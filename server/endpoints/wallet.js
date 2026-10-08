const { v4: uuidv4 } = require("uuid");
const { ethers } = require("ethers");
const { reqBody, makeJWT, userFromSession } = require("../utils/http");
const { User } = require("../models/user");
const { totemConfig, fetchTotemBalance } = require("../utils/totemBalance");
const { Workspace } = require("../models/workspace");
const { EventLogs } = require("../models/eventLogs");
const prisma = require("../utils/prisma");

// In-memory nonce store with 5-minute TTL.
// Key: nonce (uuid), Value: { message, createdAt }
const nonces = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000;

// Periodically clean up expired nonces (every 60s).
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of nonces) {
    if (now - val.createdAt > NONCE_TTL_MS) nonces.delete(key);
  }
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

      // Store the exact message so verify can check against it.
      nonces.set(nonce, { message, createdAt: Date.now() });

      response.status(200).json({ nonce, message });
    } catch (e) {
      console.error("Wallet nonce error:", e.message, e);
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
        response.status(400).json({
          valid: false,
          user: null,
          token: null,
          message: "Missing required fields: signature and nonce.",
        });
        return;
      }

      // --- Nonce lookup (single-use) ---
      const entry = nonces.get(nonce);
      if (!entry) {
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
        // Consume nonce even on failure to prevent replay of a bad sig
        nonces.delete(nonce);
        response.status(401).json({
          valid: false,
          user: null,
          token: null,
          message: "Invalid signature.",
        });
        return;
      }

      const normalizedAddress = recoveredAddress.toLowerCase();

      // Consume the nonce (single-use, even on subsequent errors)
      nonces.delete(nonce);

      // --- Find or create user ---
      let user = await User._get({ wallet_address: normalizedAddress });

      if (!user) {
        // New user: create account with 10 free credits
        const placeholderPassword = uuidv4() + uuidv4();
        const username = `wallet_${normalizedAddress.slice(2, 8)}`;

        try {
          const newUser = await prisma.users.create({
            data: {
              username,
              password: placeholderPassword,
              wallet_address: normalizedAddress,
              credits_balance: 10,
              role: "default",
            },
          });

          await prisma.credit_transactions.create({
            data: {
              user_id: newUser.id,
              type: "credit",
              amount: 10,
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
                "Wallet signup: failed to create default workspace:",
                wsError
              );
            }
          } catch (wsErr) {
            // Non-fatal: user can still log in and create a workspace manually.
            console.error(
              "Wallet signup: workspace creation error:",
              wsErr.message
            );
          }

          await EventLogs.logEvent(
            "wallet_account_created",
            { wallet_address: normalizedAddress, ip: request.ip || "unknown" },
            user.id
          );
        } catch (e) {
          // Race condition: another request created the user concurrently. Re-fetch.
          user = await User._get({ wallet_address: normalizedAddress });
          if (!user) throw e;
        }
      }

      if (user.suspended) {
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

      await EventLogs.logEvent(
        "wallet_login_event",
        { wallet_address: normalizedAddress, ip: request.ip || "unknown" },
        user.id
      );

      response.status(200).json({
        valid: true,
        user: User.filterFields(user),
        token: sessionToken,
        message: null,
      });
    } catch (e) {
      console.error("Wallet verify error:", e.message, e);
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
