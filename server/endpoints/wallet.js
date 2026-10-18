const { v4: uuidv4 } = require("uuid");
const { ethers } = require("ethers");
const { reqBody, makeJWT, userFromSession } = require("../utils/http");
const { User } = require("../models/user");
const { totemConfig, fetchTotemBalance } = require("../utils/totemBalance");
const { Workspace } = require("../models/workspace");
const { EventLogs } = require("../models/eventLogs");
const { CacheData } = require("../models/cacheData");
const prisma = require("../utils/prisma");

// Nonce + replay state is persisted in the DB (cache_data table) instead of an
// in-memory Map. Why: the store was previously a module-level Map, which
// silently vanished whenever the server restarted (nodemon reload, crash,
// deploy) — or after the TTL sweep — leaving the frontend holding a nonce the
// server no longer knows. The user signs, verify then rejects with
// "invalid-or-expired", and the login dies AFTER the signature was approved.
// DB-backed rows survive restarts and carry their own expiry.
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 min — generous for slow mobile flows
const CONSUMED_TTL_MS = 30 * 1000; // 30 s replay window for reload recovery

const nonceKey = (nonce) => `wallet:nonce:${nonce}`;
const consumedKey = (nonce) => `wallet:consumed:${nonce}`;

async function readWalletState(key) {
  const row = await CacheData.get({ name: key });
  if (!row) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    await CacheData.delete({ name: key });
    return null;
  }
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

// Periodic sweep of expired wallet:* rows (housekeeping only — reads already
// treat expired rows as absent). Scoped to the wallet: name prefix so rows
// belonging to other cache_data consumers are never touched.
setInterval(() => {
  CacheData.delete({
    name: { startsWith: "wallet:" },
    expiresAt: { lt: new Date() },
  }).catch(() => {});
}, 60_000);

/**
 * Build the SIWE-style message the wallet must sign.
 * The address is NOT included in the message — it is derived from the
 * recovered signature, so the user cannot impersonate a different address.
 */
function buildWalletMessage(domain, origin, nonce) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    "",
    "(your wallet address will be derived from the signature)",
    "",
    "Sign this message to authenticate with Totem LLM.",
    "This request will not trigger a blockchain transaction or cost any gas fees.",
    "",
    `URI: ${origin || `https://${domain}`}`,
    `Version: 1`,
    `Chain ID: 1`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

function walletEndpoints(app) {
  if (!app) return;

  /**
   * GET /api/wallet/balance
   *
   * Reads the caller's $TOTEM token balance (on-chain, Base) for the wallet
   * address stored on their account. Read-only — no transaction is created.
   * Requires a valid session (multi-user mode). Feature is off (204, no
   * body) when TOTEM_ADDRESS is not configured — the UI then shows the
   * badge in its "non-holder" state.
   *
   * Response 200: { available: true,  tokenAddress, symbol, chainId, amount (decimal string), updatedAt }
   * Response 200: { available: false, noWallet: true } when the account has no wallet
   * Response 200: { available: false, error? } when configured but the on-chain read failed
   */
  app.get("/wallet/balance", async (request, response) => {
    const config = totemConfig();
    if (!config.enabled) {
      response.status(204).end();
      return;
    }

    try {
      const user = await userFromSession(request, response);
      if (!user || !user.wallet_address) {
        response.status(200).json({
          available: false,
          noWallet: true,
          error: "Not signed in with a wallet.",
        });
        return;
      }

      const amount = await fetchTotemBalance({
        rpcUrl: config.rpcUrl,
        tokenAddress: config.tokenAddress,
        ownerAddress: user.wallet_address,
        decimals: config.decimals,
      });

      response.status(200).json({
        available: true,
        tokenAddress: config.tokenAddress,
        symbol: config.symbol,
        chainId: config.chainId,
        amount,
        updatedAt: Date.now(),
      });
    } catch (e) {
      console.error("TOTEM balance read failed:", e.message);
      response.status(200).json({
        available: false,
        error: "Could not read $TOTEM balance. Try again later.",
      });
    }
  });

  /**
   * POST /api/auth/wallet/nonce
   *
   * Returns a nonce and the exact message to sign.
   * The client passes this message to window.ethereum.request({ method: 'personal_sign', ... }).
   *
   * Body: { origin?: string }
   * Response: { nonce, message }
   */
  app.post("/auth/wallet/nonce", async (request, response) => {
    try {
      const { origin } = reqBody(request);
      console.log(
        `[wallet:nonce] request from ip=${request.ip} host=${request.headers.host} origin=${origin || "(none)"}`
      );

      // Derive domain from origin or request host
      let domain;
      if (origin) {
        try {
          domain = new URL(origin).hostname;
        } catch {
          domain = request.headers.host;
        }
      } else {
        domain = request.headers.host || "totem.local";
      }

      const nonce = uuidv4();
      const message = buildWalletMessage(domain, origin, nonce);

      // Persist the exact message so verify can check against it. Stored in
      // the DB (cache_data) so it survives server restarts during the flow.
      await CacheData.new({
        name: nonceKey(nonce),
        data: JSON.stringify({ message }),
        expiresAt: new Date(Date.now() + NONCE_TTL_MS),
      });
      const activeCount = await CacheData.count({
        name: { startsWith: "wallet:nonce:" },
      });
      console.log(
        `[wallet:nonce] issued nonce=${nonce} for domain=${domain} (active nonces: ${activeCount})`
      );

      response.status(200).json({ nonce, message });
    } catch (e) {
      console.error("[wallet] nonce error:", e.message);
      response.status(500).json({ error: "Failed to generate wallet nonce." });
    }
  });

  /**
   * POST /api/auth/wallet/verify
   *
   * Verifies the wallet signature and returns a JWT.
   * The address is NOT trusted from the client — it is derived from the
   * signature itself via ethers.verifyMessage().
   *
   * Body: { signature: string, nonce: string }
   * Response: { valid, user, token, message }  (same shape as /request-token)
   */
  app.post("/auth/wallet/verify", async (request, response) => {
    try {
      const { signature, nonce } = reqBody(request);

      // --- Input validation ---
      if (!signature || !nonce) {
        console.error("[wallet] verify: missing signature or nonce");
        response.status(400).json({
          valid: false,
          user: null,
          token: null,
          message: "Missing required fields: signature and nonce.",
        });
        return;
      }
      console.log(
        `[wallet:verify] attempt nonce=${String(nonce).slice(0, 8)}… sigLen=${String(signature).length} ip=${request.ip}`
      );

      // --- Nonce lookup (single-use, DB-backed, with 30 s replay window) ---
      let entry = await readWalletState(nonceKey(nonce));
      let isReplay = false;
      if (!entry) {
        const consumed = await readWalletState(consumedKey(nonce));
        if (consumed) {
          entry = consumed;
          isReplay = true;
        }
      }
      if (!entry) {
        const activeCount = await CacheData.count({
          name: { startsWith: "wallet:nonce:" },
        });
        const consumedCount = await CacheData.count({
          name: { startsWith: "wallet:consumed:" },
        });
        console.error(
          `[wallet:verify] REJECTED nonce=${String(nonce).slice(0, 8)}… reason=invalid-or-expired (active: ${activeCount}, recently-consumed: ${consumedCount})`
        );
        response.status(401).json({
          valid: false,
          user: null,
          token: null,
          message: "Invalid or expired nonce. Please request a new one.",
        });
        return;
      }

      // --- Recover address from signature ---
      let recoveredAddress;
      try {
        recoveredAddress = ethers.verifyMessage(entry.message, signature);
      } catch (e) {
        console.error(
          `[wallet:verify] REJECTED nonce=${String(nonce).slice(0, 8)}… reason=bad-signature (${e.message})`
        );
        // Consume nonce even on failure to prevent replay of a bad sig
        await CacheData.delete({ name: nonceKey(nonce) });
        response.status(401).json({
          valid: false,
          user: null,
          token: null,
          message: "Invalid signature.",
        });
        return;
      }

      const normalizedAddress = recoveredAddress.toLowerCase();

      // Consume the nonce: move from the active store to the consumed store
      // (30 s replay window so a post-reload recovery re-verify succeeds).
      await CacheData.delete({ name: nonceKey(nonce) });
      await CacheData.new({
        name: consumedKey(nonce),
        data: JSON.stringify({ message: entry.message }),
        expiresAt: new Date(Date.now() + CONSUMED_TTL_MS),
      });
      console.log(
        `[wallet:verify] signature valid → address=${normalizedAddress}${isReplay ? " (REPLAY within 30s window)" : ""}`
      );

      // --- Find or create user ---
      let user = await User._get({ wallet_address: normalizedAddress });
      console.log(
        `[wallet:verify] user lookup: ${user ? `existing user id=${user.id} username=${user.username}` : "NEW wallet — creating account"}`
      );

      if (!user) {
        // New user: welcome bonus of 100,000 microdollars (~100k output tokens)
        const WELCOME_BONUS = 100_000; // microdollars

        const placeholderPassword = uuidv4() + uuidv4();
        const username = `wallet_${normalizedAddress.slice(2, 8)}`;

        try {
          const newUser = await prisma.users.create({
            data: {
              username,
              password: placeholderPassword,
              wallet_address: normalizedAddress,
              credits_balance: WELCOME_BONUS,
              role: "default",
            },
          });

          await prisma.credit_transactions.create({
            data: {
              user_id: newUser.id,
              type: "credit",
              amount: WELCOME_BONUS,
              reference: `signup_${normalizedAddress}`,
            },
          });

          user = newUser;

          // --- Auto-create a default workspace for the new user ---
          try {
            const { workspace, message: wsError } = await Workspace.new(
              "My Workspace",
              user.id
            );
            if (wsError) {
              console.error(
                "[wallet] default workspace creation failed:",
                wsError
              );
            }
          } catch (wsErr) {
            // Non-fatal: user can still log in and create a workspace manually.
            console.error(
              "[wallet] default workspace creation error:",
              wsErr.message
            );
          }

          await EventLogs.logEvent(
            "wallet_account_created",
            { wallet_address: normalizedAddress, ip: request.ip || "unknown" },
            user.id
          );
        } catch (e) {
          console.error(
            "[wallet] user creation failed, retrying lookup:",
            e.message
          );
          // Race condition: another request created the user concurrently. Re-fetch.
          user = await User._get({ wallet_address: normalizedAddress });
          if (!user) throw e;
        }
      }

      if (user.suspended) {
        console.error("[wallet] verify: user suspended");
        response.status(403).json({
          valid: false,
          user: null,
          token: null,
          message: "Account is suspended.",
        });
        return;
      }

      // --- Issue JWT (same shape as /request-token) ---
      const sessionToken = makeJWT(
        { id: user.id, username: user.username },
        process.env.JWT_EXPIRY || "30d"
      );
      console.log(
        `[wallet:verify] SUCCESS user=${user.username} userId=${user.id} isReplay=${isReplay} — issuing JWT`
      );

      await EventLogs.logEvent(
        "wallet_login_event",
        {
          wallet_address: normalizedAddress,
          ip: request.ip || "unknown",
          isReplay,
        },
        user.id
      );

      response.status(200).json({
        valid: true,
        user: User.filterFields(user),
        token: sessionToken,
        message: null,
      });
    } catch (e) {
      console.error("[wallet] verify error:", e.message);
      response.status(500).json({
        valid: false,
        user: null,
        token: null,
        message: "Internal server error during wallet authentication.",
      });
    }
  });
}

module.exports = { walletEndpoints };
