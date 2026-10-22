const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { rateLimiter } = require("../utils/middleware/rateLimiter");
const { PurchaseSessions } = require("../models/purchaseSessions");
const payments = require("../utils/payments/config");
const prisma = require("../utils/prisma");

/**
 * Wallet payment endpoints (USDC on Base) — see totem_docs/wallet-payments/.
 *
 *   POST /credits/purchase-session             — create a purchase session
 *   POST /credits/purchase-session/:id/confirm — verify the on-chain tx + redeem
 *   GET  /credits/purchase-session/:id         — owner-only status poll
 *
 * Feature gate (F1/AC1): every endpoint returns `204` (no body) when
 * `paymentsConfig().enabled === false` (treasury unset/invalid) — mirrors the
 * `GET /wallet/balance` gate in `wallet.js`. Checked per-request so flipping
 * the env var takes effect without a code change.
 *
 * Auth (N5, spec threat model): `userFromSession` per the credits.js style
 * (Step 0 finding 0.7). Wallet-account-only — a user without
 * `wallet_address` cannot create or confirm sessions (F5c has nothing to
 * bind the payer against). Unauthenticated → 401; non-owner → 403;
 * fail-closed everywhere (N3).
 *
 * Crediting flow (F5 + F6d): the confirm endpoint runs the six-check
 * verification against the on-chain receipt and, only on a full pass,
 * hands the *server-derived* values (block number, log value) to
 * `PurchaseSessions.redeem()` — THE SINGLE CREDITING PATH. This endpoint
 * never writes a ledger row and never trusts a client-supplied amount
 * or block number (risk table: "trusting client-supplied amount/tx data").
 *
 * Claim ordering note: verification runs BEFORE `redeem`'s atomic claim,
 * so an unmined/unconfirmed tx never burns the one-shot claim stamp. The
 * exactly-once guarantee is unaffected — redeem's conditional claim +
 * `tx_hash @unique` anchor (F6a) still gates every credit, and concurrent
 * confirms of the same txHash collapse onto a single claim winner.
 */

const REASONS = PurchaseSessions.FAILURE_REASONS;

/** Clock-skew tolerance for the F5f staleness check: a tx mined after the
 * session was created can still carry a block timestamp slightly behind the
 * server's wall clock (chain clock vs local clock). Anything older than the
 * session's creation minus this tolerance is a pre-session deposit. Also
 * governs the sweeper's re-verification of a submitted session: a
 * submitted-but-unmined tx is retried until the session's TTL passes, then
 * expired instead of failed (AC10). */
const STALENESS_TOLERANCE_MS = 90_000;

/** Sweeper cadence — 60 s, per spec N6 (same as the wallet nonce sweeper). */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Per-user in-memory rate limiter (N5: session creation is limited per IP
 * AND per user). Same Map/sweep pattern as `rateLimiter.js`, keyed by user
 * id since the identity is only known inside the handler.
 */
const userHits = new Map(); // userId → { count, windowStart }
const USER_RATE_WINDOW_MS = parseInt(
  process.env.PAYMENTS_SESSION_RATE_WINDOW_MS || String(15 * 60 * 1000),
  10
);
const USER_RATE_MAX = parseInt(
  process.env.PAYMENTS_SESSION_RATE_LIMIT || "10",
  10
);

/**
 * @param {number} userId
 * @returns {boolean} true if allowed, false if over the per-user limit
 */
function userRateAllow(userId) {
  const now = Date.now();
  const entry = userHits.get(userId);
  if (!entry || now - entry.windowStart > USER_RATE_WINDOW_MS) {
    userHits.set(userId, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= USER_RATE_MAX;
}

// Periodic sweep so the Map cannot grow unboundedly (housekeeping only).
const userRateSweeper = setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of userHits) {
    if (now - entry.windowStart > USER_RATE_WINDOW_MS) userHits.delete(userId);
  }
}, 60_000);
if (typeof userRateSweeper.unref === "function") userRateSweeper.unref();

/**
 * Count Transfer logs bound to the treasury from ANY token contract —
 * used to distinguish `wrong_token` (a different ERC-20 paid the treasury)
 * from `wrong_recipient` (nothing did). Low-20-bytes comparison, same
 * topic layout rule as `decodeUsdcTransfers`.
 * @param {Array<{topics?: string[]}>|null|undefined} receiptLogs
 * @param {string} treasuryAddress
 * @returns {number}
 */
function countTreasuryBoundTransfers(receiptLogs, treasuryAddress) {
  if (!Array.isArray(receiptLogs)) return 0;
  const treasury = String(treasuryAddress || "").toLowerCase();
  let count = 0;
  for (const log of receiptLogs) {
    if (!log || !Array.isArray(log.topics) || log.topics.length < 3) continue;
    if (String(log.topics[0]).toLowerCase() !== payments.TRANSFER_TOPIC)
      continue;
    const to =
      "0x" +
      String(log.topics[2]).slice(2).toLowerCase().padStart(64, "0").slice(-40);
    if (to === treasury) count += 1;
  }
  return count;
}

/**
 * The F5 six-check verification, in fail-closed order. Returns a
 * discriminated result instead of throwing — every outcome maps to exactly
 * one HTTP response. All on-chain data is fetched server-side; the client
 * contributes only the txHash.
 *
 * @param {object} session - the session row (with `user` included for F5c)
 * @param {string} txHash
 * @returns {Promise<
 *   | {outcome: "redeem", blockNumber: bigint, valueMicro: bigint} — all checks passed
 *   | {outcome: "pending", reason: string}                         — transient, retry later
 *   | {outcome: "failed", reason: string}                          — permanent failure
 * >}
 */
async function verifyReceipt(session, txHash) {
  const config = payments.paymentsConfig();

  // ── Transport: fetch the receipt (server-side — never trust the client). ──
  let receipt;
  try {
    receipt = await payments.fetchReceipt(config.rpcUrl, txHash);
  } catch (rpcError) {
    console.error("[payments] RPC receipt fetch failed:", rpcError.message);
    return { outcome: "pending", reason: REASONS.RPC_UNAVAILABLE };
  }

  // F5d prerequisite: the receipt must exist (tx mined). Unknown/unmined is
  // transient — the tx may land momentarily (N3: stay pending, never credit).
  if (!receipt) {
    return { outcome: "pending", reason: REASONS.TX_NOT_FOUND };
  }

  // F5d: status must be 1 (success). Reverted is permanent — the user must
  // send a NEW transaction; retrying this hash can never succeed.
  if (String(receipt.status) !== "0x1") {
    return { outcome: "failed", reason: REASONS.TX_REVERTED };
  }

  const blockNumber = BigInt(receipt.blockNumber);

  // F5f: no pre-session deposits. The receipt carries no timestamp, so
  // compare the session's wall-clock creation against the block's on-chain
  // timestamp (small skew tolerance above).
  let blockTs;
  try {
    blockTs = await payments.getBlockTimestamp(config.rpcUrl, blockNumber);
  } catch (rpcError) {
    console.error("[payments] RPC block fetch failed:", rpcError.message);
    return { outcome: "pending", reason: REASONS.RPC_UNAVAILABLE };
  }
  if (
    blockTs <
    new Date(session.createdAt).getTime() - STALENESS_TOLERANCE_MS
  ) {
    return { outcome: "failed", reason: REASONS.TX_TOO_OLD };
  }

  // F5e: >= PAYMENTS_CONFIRMATIONS blocks since the tx block. Insufficient
  // depth is transient — the tx may reach depth momentarily.
  let height;
  try {
    height = await payments.getBlockHeight(config.rpcUrl);
  } catch (rpcError) {
    console.error("[payments] RPC height fetch failed:", rpcError.message);
    return { outcome: "pending", reason: REASONS.RPC_UNAVAILABLE };
  }
  if (height - blockNumber + 1n < BigInt(config.confirmations)) {
    return { outcome: "pending", reason: REASONS.NOT_CONFIRMED };
  }

  // F5a/F5b: decode the USDC Transfer log — recipient + integer amount.
  const { match, ambiguous } = payments.decodeUsdcTransfers(receipt.logs, {
    tokenAddress: config.usdcAddress,
    treasuryAddress: config.treasuryAddress,
  });

  if (ambiguous) {
    // N3: multiple treasury-bound USDC transfers in one tx — fail, never guess.
    return { outcome: "failed", reason: REASONS.AMBIGUOUS_TRANSFER };
  }
  if (!match) {
    // Distinguish "paid a different token" from "paid someone else" so the
    // admin surface (F10) can reconcile without re-reading the chain.
    const anyTreasuryBound = countTreasuryBoundTransfers(
      receipt.logs,
      config.treasuryAddress
    );
    const reason =
      anyTreasuryBound > 0 ? REASONS.WRONG_TOKEN : REASONS.WRONG_RECIPIENT;
    return { outcome: "failed", reason };
  }

  // F5c: payer binding — the sender must be the session owner's wallet.
  const payer = String(session.user?.wallet_address || "").toLowerCase();
  if (match.from.toLowerCase() !== payer) {
    return { outcome: "failed", reason: REASONS.PAYER_MISMATCH };
  }

  // F5b: amount binding — integer BigInt equality against the session's
  // expectation (µ$ == USDC base units 1:1, credit-units N2).
  if (match.value !== BigInt(session.expected_amount)) {
    return { outcome: "failed", reason: REASONS.AMOUNT_MISMATCH };
  }

  return { outcome: "redeem", blockNumber, valueMicro: match.value };
}

function paymentEndpoints(app) {
  if (!app) return;

  // Per-IP limiter for session creation (N5 — same pattern as wallet auth).
  const sessionRateLimiter = rateLimiter({
    max: parseInt(process.env.PAYMENTS_SESSION_RATE_LIMIT_IP || "10", 10),
    windowMs: USER_RATE_WINDOW_MS,
    message: "Too many purchase attempts. Please try again later.",
  });

  /**
   * POST /api/credits/purchase-session
   * Body: { packId: "usd1" | "usd5" | "usd10" | "usd25" }
   * Response 200: { id, expectedAmountUsdc, treasuryAddress, usdcAddress, chainId, expiresAt }
   *   `usdcAddress` is the ERC-20 token contract the wallet must target —
   *   an `eth_sendTransaction` for a token transfer goes TO the token
   *   contract with the recipient encoded in calldata, never to the
   *   treasury directly (a direct tx to the treasury EOA is a silent no-op
   *   that still mines successfully — the manual-test bug this field fixes).
   * Response 204: feature disabled (F1/AC1)
   * Response 400/401/403/429/500: per contract below
   */
  app.post(
    "/credits/purchase-session",
    [validatedRequest, sessionRateLimiter],
    async (request, response) => {
      const config = payments.paymentsConfig();
      if (!config.enabled) return response.status(204).end();

      try {
        const user = await userFromSession(request, response);
        if (!user) {
          return response.status(401).json({ message: "Not authenticated" });
        }
        // Wallet-account-only (spec: password-only accounts cannot purchase
        // in v1 — payer binding needs a wallet_address to match against).
        if (!user.wallet_address) {
          return response.status(403).json({
            message:
              "Purchases require a wallet-linked account. Sign in with your wallet.",
          });
        }
        // Per-user limit (N5) — after auth, inside the handler.
        if (!userRateAllow(user.id)) {
          return response.status(429).json({
            message: "Too many purchase attempts. Please try again later.",
          });
        }

        const { packId } = reqBody(request);
        const pack = payments.getPack(packId);
        if (!pack) {
          return response.status(400).json({
            message: "Unknown packId. Valid packs: usd1, usd5, usd10, usd25.",
          });
        }

        const { session, error } = await PurchaseSessions.create({
          userId: user.id,
          expectedAmountMicro: pack.usdcBaseUnits,
          treasuryAddress: config.treasuryAddress,
          chainId: config.chainId,
        });
        if (!session) {
          console.error("[payments] session creation failed:", error);
          return response
            .status(500)
            .json({ message: "Could not create purchase session." });
        }

        // BigInt µ$ amounts must never hit JSON.stringify raw (Step 2 note).
        const safe = PurchaseSessions.serializeSession(session);
        response.status(200).json({
          id: safe.id,
          expectedAmountUsdc: safe.expected_amount, // exact decimal string
          treasuryAddress: session.treasury_address,
          usdcAddress: config.usdcAddress, // token contract = the tx target
          chainId: session.chain_id,
          expiresAt: session.expires_at,
        });
      } catch (e) {
        console.error("[payments] purchase-session error:", e);
        response.status(500).json({ message: "Internal error" });
      }
    }
  );

  /**
   * POST /api/credits/purchase-session/:id/confirm
   * Body: { txHash }
   *
   * Response 200 shapes (the outcome is always in `status` — network errors
   * are the only non-200s):
   *   { status: "credited", session }                    — AC3 happy path
   *   { status: "already-redeemed" }                     — AC4 (txHash used)
   *   { status: "pending", failureReason }               — transient (unmined,
   *     insufficient confirmations, RPC down) — client should retry
   *   { status: "failed", failureReason, session? }      — permanent (F5 codes)
   *   { status: "<current>", failureReason?, session? }  — terminal/non-claimable
   */
  app.post(
    "/credits/purchase-session/:id/confirm",
    [validatedRequest],
    async (request, response) => {
      const config = payments.paymentsConfig();
      if (!config.enabled) return response.status(204).end();

      try {
        const user = await userFromSession(request, response);
        if (!user) {
          return response.status(401).json({ message: "Not authenticated" });
        }

        const { id } = request.params;
        const session = await PurchaseSessions.getById(id, {
          includeUser: true,
        });
        if (!session) {
          return response.status(404).json({ message: "Session not found." });
        }
        // Owner-only, fail-closed (N5 / spec threat model).
        if (session.user_id !== Number(user.id)) {
          return response.status(403).json({ message: "Not authorized." });
        }

        const { txHash } = reqBody(request);
        if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) {
          return response
            .status(400)
            .json({ message: "A valid txHash is required." });
        }

        // Terminal states answer from the DB — no RPC round-trip. A second
        // confirm of a credited session is the AC4 already-redeemed shape.
        if (["credited", "failed", "expired"].includes(session.status)) {
          return response.status(200).json({
            status:
              session.status === "credited"
                ? "already-redeemed"
                : session.status,
            failureReason: session.failure_reason || null,
            session: PurchaseSessions.serializeSession(session),
          });
        }

        // ── Verify first (no claim burned on transient outcomes). ────────
        const verification = await verifyReceipt(session, String(txHash));

        if (verification.outcome === "pending") {
          // N3: fail closed — nothing marked failed, nothing credited. The
          // session stays pending; the client retries, the sweeper re-checks.
          return response
            .status(200)
            .json({ status: "pending", failureReason: verification.reason });
        }
        if (verification.outcome === "failed") {
          // Permanent: mark failed (conditional — never downgrades a
          // credited session if a concurrent confirm just won).
          await PurchaseSessions.markFailed(id, verification.reason);
          const updated = await PurchaseSessions.getById(id);
          return response.status(200).json({
            status: updated?.status || "failed",
            failureReason: verification.reason,
            session: PurchaseSessions.serializeSession(updated),
          });
        }

        // ── All six checks passed — the single crediting path (F6d). ─────
        // redeem re-reads the row and claims atomically; a concurrent
        // confirm that won the claim first makes this call report
        // not-claimable/already-redeemed — never a second credit.
        const redeemResult = await PurchaseSessions.redeem({
          sessionId: id,
          txHash: String(txHash),
          blockNumber: verification.blockNumber,
          valueMicro: verification.valueMicro,
        });

        if (redeemResult.result === "credited") {
          return response.status(200).json({
            status: "credited",
            session: PurchaseSessions.serializeSession(redeemResult.session),
          });
        }
        if (redeemResult.result === "already-redeemed") {
          return response
            .status(200)
            .json({ status: "already-redeemed", failureReason: null });
        }
        if (
          redeemResult.result === "not-claimable" ||
          redeemResult.result === "not-found"
        ) {
          // Lost the claim race or the row vanished — report the current
          // state (the winner's confirm will surface the final status).
          const current = await PurchaseSessions.getById(id);
          return response.status(200).json({
            status: current?.status || "pending",
            failureReason: current?.failure_reason || null,
            session: PurchaseSessions.serializeSession(current),
          });
        }

        console.error("[payments] redeem error:", redeemResult.error);
        return response.status(500).json({ message: "Internal error" });
      } catch (e) {
        console.error("[payments] confirm error:", e);
        response.status(500).json({ message: "Internal error" });
      }
    }
  );

  /**
   * GET /api/credits/purchase-session/:id
   * Owner-only status poll for the frontend (F9/N6).
   * Response 200: { session } — full serialized row (BigInts as exact
   * decimal strings), including `status` + `failure_reason` for AC9.
   */
  app.get(
    "/credits/purchase-session/:id",
    [validatedRequest],
    async (request, response) => {
      const config = payments.paymentsConfig();
      if (!config.enabled) return response.status(204).end();

      try {
        const user = await userFromSession(request, response);
        if (!user) {
          return response.status(401).json({ message: "Not authenticated" });
        }

        const { id } = request.params;
        const session = await PurchaseSessions.getById(id);
        if (!session) {
          return response.status(404).json({ message: "Session not found." });
        }
        if (session.user_id !== Number(user.id)) {
          return response.status(403).json({ message: "Not authorized." });
        }

        response
          .status(200)
          .json({ session: PurchaseSessions.serializeSession(session) });
      } catch (e) {
        console.error("[payments] status error:", e);
        response.status(500).json({ message: "Internal error" });
      }
    }
  );
}

/**
 * Background purchase-session sweeper (F8, AC10) — Step 5.
 *
 * Housekeeping-only, mirroring the wallet nonce sweeper pattern (0.6):
 * a module-level `setInterval` whose callback never throws, scoped so it
 * only ever touches `purchase_sessions` rows. It is NOT a second crediting
 * path — every credit goes through the same `PurchaseSessions.redeem()`
 * the confirm endpoint uses (F6d), so all F6 invariants (atomic claim,
 * `tx_hash @unique` P2002 anchor, verify-before-claim) apply unchanged.
 *
 * Per sweep, three disjoint duties:
 *
 *   1. expireStale — bulk-mark past-TTL sessions that never got a tx.
 *
 *   2. resolveStuckClaim — crash artifacts in `crediting` past
 *      CREDITING_STALE_MS: ledger-lookup decides re-sync (credit committed,
 *      crash 2→3) vs release (no credit, crash 1→2).
 *
 *   3. sweep re-verification — pending sessions WITH a submitted txHash
 *      (crashed-tab recovery): re-run the F5 six-check verification and
 *      redeem on a full pass. A submitted session that passes its TTL is
 *      expired (never blanket-failed) — the user may still get their credits
 *      if the tx lands; the generic sweep keeps retrying until then.
 *
 * Guarded on `paymentsConfig().enabled` at schedule time (F1): no treasury
 * config, no timer. The config is re-read per sweep so flipping the env var
 * takes effect without a restart, matching the endpoints' per-request gate.
 */
async function runPaymentSweep() {
  // Re-read per sweep — the feature can be turned off after boot.
  if (!payments.paymentsConfig().enabled) return;

  // 1. TTL expiry for never-submitted sessions.
  try {
    const expired = await PurchaseSessions.expireStale();
    if (expired > 0)
      console.log(`[payments] sweeper: expired ${expired} stale session(s)`);
  } catch (e) {
    console.error("[payments] sweeper: expireStale failed:", e.message);
  }

  // 2. Crash-window recovery for stuck `crediting` claims.
  try {
    const stuck = await prisma.purchase_sessions.findMany({
      where: { status: "crediting" },
    });
    const now = Date.now();
    for (const session of stuck) {
      if (
        now - new Date(session.updatedAt).getTime() <
        PurchaseSessions.CREDITING_STALE_MS
      )
        continue; // in-flight claim — a concurrent caller owns it
      const outcome = await PurchaseSessions.resolveStuckClaim(session);
      if (outcome !== "error")
        console.log(`[payments] sweeper: stuck claim ${session.id} ${outcome}`);
    }
  } catch (e) {
    console.error("[payments] sweeper: stuck-claim pass failed:", e.message);
  }

  // 3. Crashed-tab recovery: submitted-but-unverified sessions. Verification
  // and redeem are the exact code paths the confirm endpoint uses.
  try {
    const sweepable = await PurchaseSessions.findSweepable();
    for (const session of sweepable) {
      const pastTtl = new Date(session.expires_at).getTime() <= Date.now();
      const verification = await verifyReceipt(
        session,
        String(session.tx_hash)
      );

      if (verification.outcome === "redeem") {
        const redeemResult = await PurchaseSessions.redeem({
          sessionId: session.id,
          txHash: String(session.tx_hash),
          blockNumber: verification.blockNumber,
          valueMicro: verification.valueMicro,
        });
        if (redeemResult.result === "credited")
          console.log(
            `[payments] sweeper: credited session ${session.id} (crashed-tab recovery)`
          );
        continue;
      }

      if (verification.outcome === "failed") {
        // Permanent: a reverted/wrong-recipient tx can never succeed on
        // retry — fail immediately with the precise F5 reason regardless of
        // TTL (markFailed is conditional, never downgrades a credited row).
        await PurchaseSessions.markFailed(session.id, verification.reason);
        continue;
      }

      // outcome === "pending" (transient). Retry next sweep; expire once the
      // TTL passes so a session whose tx never lands cannot linger forever.
      if (pastTtl) {
        await PurchaseSessions.markExpired(session.id, verification.reason);
      }
    }
  } catch (e) {
    console.error("[payments] sweeper: verification pass failed:", e.message);
  }
}

/**
 * Schedule the sweeper ONLY when the feature is enabled (F1): no treasury
 * config → no timer at all. Unref'd so the timer never keeps the process
 * (or Jest) alive on its own — same hygiene as the wallet nonce sweeper.
 * `runPaymentSweep` is exported for tests (the injected-seam pattern from
 * Step 1/4 — the sweep body is exercised directly, no timers).
 * @returns {import("node:timers").NodeJS.Timeout|null} the timer (for tests)
 */
function paymentSweeper() {
  if (!payments.paymentsConfig().enabled) return null;
  const timer = setInterval(() => {
    runPaymentSweep().catch((e) =>
      console.error("[payments] sweeper iteration failed:", e.message)
    );
  }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = { paymentEndpoints, paymentSweeper, runPaymentSweep };
