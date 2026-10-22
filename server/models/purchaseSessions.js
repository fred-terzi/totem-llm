const prisma = require("../utils/prisma");

/**
 * Wallet payment purchase sessions (see totem_docs/wallet-payments/).
 *
 * One row per purchase attempt. Lifecycle:
 *
 *   pending → (claim: conditional update, tx_hash stamped) → crediting
 *   crediting → credited    (ledger write committed)
 *   crediting → failed      (verification failed; failure_reason set)
 *   pending  → expired      (sweeper, TTL passed with no successful confirm)
 *
 * THE SINGLE CREDITING PATH (F6d): `redeem()` is the only method that writes
 * a `purchase` ledger row. Both the confirm endpoint and the background
 * sweeper call it — there is no second writer.
 *
 * Transaction-shape note (Step 3 journal — verified live against SQLite):
 * Prisma interactive transactions do NOT nest on SQLite. Calling
 * `Credits.credit()` (its own `$transaction` on the shared client) from
 * inside a `$transaction` callback **deadlocks** (the outer transaction
 * holds the write lock; the inner query waits on it from the same client →
 * connector timeout). So `redeem()` is structured as a **sequential
 * pipeline** with the row-level claim as the exactly-once anchor instead of
 * one big interactive transaction:
 *
 *   1. claim — atomic conditional `updateMany`: pending → crediting,
 *      tx_hash stamped. The exactly-once gate. (A cross-session claim of
 *      the same txHash surfaces here as P2002 on the unique column.)
 *   2. ledger write via `Credits.credit()` (own atomic transaction).
 *   3. mark `credited` with the audit copy of the amount.
 *
 * Crash windows and how each stays safe (both resolved by the sweeper via
 * `resolveStuckClaim` — redeem itself only ever claims fresh rows):
 *   - crash after 1 before 2 → session stuck in `crediting`, NO ledger row;
 *     the sweeper's `resolveStuckClaim` finds no ledger row for the
 *     session's `purchase_<txHash>` reference and releases the claim back
 *     to `pending` — safe, nothing was credited, and a later confirm or
 *     sweep can retry.
 *   - crash after 2 before 3 → ledger row EXISTS, session still
 *     `crediting`; `resolveStuckClaim` finds the ledger row by its
 *     deterministic `purchase_<txHash>` reference and re-syncs the session
 *     to `credited` WITHOUT crediting again — no double credit. The F6a
 *     anchor (tx_hash @unique) backstops every other path.
 *   - ledger write throws → the claim is released back to `pending`
 *     (nothing credited), sweeper retries later.
 *
 * Double-credit anchor (F6a): `tx_hash` is `@unique` at the DB level. A
 * concurrent redeem of the same on-chain tx through a *different* session
 * collides on Prisma `P2002` and is treated as `already-redeemed` — the DB
 * enforces the invariant, not application logic.
 *
 * BigInt note (Step 2 finding): Prisma returns BigInt *objects* for
 * `expected_amount` / `tx_block_number` / `credited_amount`. Anything
 * returned to HTTP callers must pass through `serializeSession` here before
 * JSON.stringify, which throws on BigInt.
 */
const PurchaseSessions = {
  /** Session TTL — spec F4 (30 minutes). */
  TTL_MS: 30 * 60 * 1000,

  /**
   * How long a `crediting` claim may persist before the sweeper treats it
   * as a crash artifact (either window above) and resolves it via
   * `resolveStuckClaim`.
   */
  CREDITING_STALE_MS: 60 * 1000,

  /**
   * Machine-readable failure reasons (spec F5). Kept here so endpoints and
   * the sweeper surface identical codes.
   */
  FAILURE_REASONS: {
    TX_NOT_FOUND: "tx_not_found", // not yet mined / unknown hash
    TX_REVERTED: "tx_reverted", // receipt.status !== "0x1"
    TX_TOO_OLD: "tx_too_old", // mined before the session was created (F5f)
    NOT_CONFIRMED: "not_confirmed", // fewer than N confirmations yet
    WRONG_RECIPIENT: "wrong_recipient", // no treasury-bound USDC transfer in tx
    WRONG_TOKEN: "wrong_token", // transfer was a different ERC-20 contract
    AMOUNT_MISMATCH: "amount_mismatch", // paid ≠ session expected amount
    PAYER_MISMATCH: "payer_mismatch", // sender ≠ session owner's wallet
    AMBIGUOUS_TRANSFER: "ambiguous_transfer", // multiple matching logs (N3)
    RPC_UNAVAILABLE: "rpc_unavailable", // verification could not complete
  },

  /**
   * Serialize a session row for HTTP responses — BigInts → strings (exact,
   * no precision loss; µ$ values are integers).
   * @param {object|null} session
   */
  serializeSession(session) {
    if (!session) return null;
    return {
      ...session,
      expected_amount: session.expected_amount?.toString() ?? null,
      tx_block_number: session.tx_block_number?.toString() ?? null,
      credited_amount: session.credited_amount?.toString() ?? null,
    };
  },

  /**
   * Create a new pending purchase session.
   * @param {{userId: number, expectedAmountMicro: number|bigint, treasuryAddress: string, chainId: number, ttlMs?: number}} opts
   * @returns {Promise<{session: object|null, error: string|null}>}
   */
  async create({
    userId,
    expectedAmountMicro,
    treasuryAddress,
    chainId,
    ttlMs = this.TTL_MS,
  }) {
    if (!userId || !expectedAmountMicro || !treasuryAddress || !chainId) {
      return { session: null, error: "Missing required session fields." };
    }
    try {
      const session = await prisma.purchase_sessions.create({
        data: {
          user_id: Number(userId),
          expected_amount: BigInt(expectedAmountMicro),
          treasury_address: String(treasuryAddress),
          chain_id: Number(chainId),
          status: "pending",
          expires_at: new Date(Date.now() + ttlMs),
        },
      });
      return { session, error: null };
    } catch (error) {
      console.error("FAILED TO CREATE PURCHASE SESSION.", error.message);
      return { session: null, error: error.message };
    }
  },

  /**
   * Fetch a session by id (uuid).
   * @param {string} sessionId
   * @param {{includeUser?: boolean}} opts
   */
  async getById(sessionId, { includeUser = false } = {}) {
    if (!sessionId) return null;
    return prisma.purchase_sessions.findUnique({
      where: { id: String(sessionId) },
      ...(includeUser ? { include: { user: true } } : {}),
    });
  },

  /**
   * Fetch a session by id, enforcing ownership. Returns the session only if
   * it exists AND belongs to `userId` — fail-closed (spec threat model).
   * @param {string} sessionId
   * @param {number} userId
   */
  async getOwned(sessionId, userId) {
    if (!sessionId || !userId) return null;
    const session = await this.getById(sessionId);
    if (!session || session.user_id !== Number(userId)) return null;
    return session;
  },

  /**
   * All sessions for a user, newest first (user-facing history).
   * @param {number} userId
   * @param {number} [limit=20]
   */
  async getByUser(userId, limit = 20) {
    if (!userId) return [];
    return prisma.purchase_sessions.findMany({
      where: { user_id: Number(userId) },
      orderBy: { createdAt: "desc" },
      take: Number(limit),
    });
  },

  /**
   * Paged session list for the admin reconciliation view (F10), newest first.
   * @param {{limit?: number, offset?: number, status?: string}} opts
   */
  async listForAdmin({ limit = 50, offset = 0, status = null } = {}) {
    return prisma.purchase_sessions.findMany({
      where: status ? { status: String(status) } : {},
      orderBy: { createdAt: "desc" },
      skip: Number(offset),
      take: Math.min(Number(limit), 200),
      include: {
        user: { select: { id: true, username: true, wallet_address: true } },
      },
    });
  },

  /**
   * THE ATOMIC REDEEM — the only crediting path in the system (F6d).
   * Sequential claim → credit → mark pipeline (see the transaction-shape
   * note at the top of this file for why it is not one nested transaction).
   *
   * @param {{sessionId: string, txHash: string, blockNumber: number|bigint, valueMicro: number|bigint}} opts
   * @returns {Promise<{result: "credited"|"already-redeemed"|"not-claimable"|"not-found"|"error", session: object|null, error: string|null}>}
   *   - `credited`          — ledger write committed (exactly once)
   *   - `already-redeemed`  — this txHash was already redeemed (any session);
   *                           if the session itself was stuck in `crediting`
   *                           it has been re-synced to `credited`
   *   - `not-claimable`     — session not in a claimable state (already
   *                           credited/failed/expired/claimed concurrently)
   *   - `not-found`         — no such session id
   */
  async redeem({ sessionId, txHash, blockNumber, valueMicro }) {
    if (
      !sessionId ||
      !txHash ||
      blockNumber === undefined ||
      blockNumber === null
    ) {
      return {
        result: "error",
        session: null,
        error: "Missing redeem fields.",
      };
    }
    // Ledger amounts are `Int` in Prisma (µ$ values fit comfortably within
    // safe-integer range at our pack sizes) — pass a Number, not BigInt.
    const value = Number(valueMicro);
    if (!Number.isSafeInteger(value) || value <= 0) {
      return {
        result: "error",
        session: null,
        error: "Invalid credit amount.",
      };
    }

    // ── 1. Row-level claim: exactly one concurrent caller wins. ─────────
    // Atomic conditional update — claims ONLY fresh `pending` rows with no
    // stamped tx. A `crediting` row (in-flight claim or crash artifact) is
    // never claimed here: in-flight means a concurrent caller owns it;
    // crash artifacts belong to the sweeper's `resolveStuckClaim`, which
    // checks the ledger before deciding to release or re-sync. This keeps
    // redeem itself stateless about crash windows — it can never re-claim
    // a row whose ledger write may have already committed.
    let claim;
    try {
      claim = await prisma.purchase_sessions.updateMany({
        where: {
          id: String(sessionId),
          status: "pending",
          tx_hash: null,
        },
        data: {
          status: "crediting",
          tx_hash: String(txHash),
          tx_block_number: BigInt(blockNumber),
        },
      });
    } catch (error) {
      // Cross-session double-redeem: a DIFFERENT session already stamped
      // this txHash → the unique column fires P2002 on this write. Aborted
      // write = nothing credited twice (F6a). Expected, benign outcome.
      // NOTE: the claiming write may also surface P2002 when the SAME
      // session is stale-crediting and being re-claimed while another
      // writer wins — treated identically (fail safe, never guess).
      if (error?.code === "P2002") {
        return {
          result: "already-redeemed",
          session: await this.getByTxHash(String(txHash)),
          error: null,
        };
      }
      console.error("FAILED TO CLAIM PURCHASE SESSION.", error.message);
      return { result: "error", session: null, error: error.message };
    }
    if (claim.count !== 1) {
      // Lost the race, or the session is in a terminal/non-claimable state
      // (credited/failed/expired, or `crediting` — in-flight or crash
      // artifact; the latter is the sweeper's `resolveStuckClaim` job).
      // Distinguish "never existed" from "not claimable" for callers.
      const existing = await this.getById(sessionId);
      return {
        result: existing ? "not-claimable" : "not-found",
        session: existing,
        error: null,
      };
    }

    // ── 2. Ledger write via the existing atomic Credits.credit(). ───────
    // Sequential, NOT nested — nested $transactions deadlock on SQLite
    // (verified live; see the transaction-shape note above).
    const { Credits } = require("./credits");
    let session;
    try {
      session = await this.getById(sessionId);
      await Credits.credit(
        session.user_id,
        value,
        "purchase",
        `purchase_${String(txHash)}`
      );
    } catch (error) {
      // Ledger write failed → release the claim back to pending so the
      // sweeper can retry. Nothing was credited.
      await prisma.purchase_sessions.updateMany({
        where: { id: String(sessionId), status: "crediting" },
        data: { status: "pending", failure_reason: "ledger_write_failed" },
      });
      console.error("FAILED TO CREDIT LEDGER FOR PURCHASE.", error.message);
      return { result: "error", session: null, error: error.message };
    }

    // ── 3. Mark credited with the audit copy of the amount. ─────────────
    try {
      session = await prisma.purchase_sessions.update({
        where: { id: String(sessionId) },
        data: {
          status: "credited",
          failure_reason: null,
          credited_amount: value,
        },
      });
    } catch (error) {
      // Crash window 2→3: ledger row EXISTS but the session still says
      // `crediting`. The sweeper's `resolveStuckClaim` resolves it — the
      // ledger reference is deterministic, so it re-syncs the session to
      // `credited` without crediting again.
      console.error(
        "FAILED TO MARK SESSION CREDITED (ledger row written).",
        error.message
      );
      session = await this.getById(sessionId);
    }
    return { result: "credited", session, error: null };
  },

  /**
   * Look up a session by its stamped tx hash (sweeper recovery path).
   * @param {string} txHash
   */
  async getByTxHash(txHash) {
    if (!txHash) return null;
    return prisma.purchase_sessions.findUnique({
      where: { tx_hash: String(txHash) },
    });
  },

  /**
   * Re-sync a session to `credited` (crash window 2→3). Called by the
   * sweeper's `resolveStuckClaim` after it finds the ledger row.
   * @param {string} sessionId
   * @param {number|bigint} valueMicro - audit copy of the credited amount
   */
  async markCredited(sessionId, valueMicro) {
    try {
      return await prisma.purchase_sessions.update({
        where: { id: String(sessionId) },
        data: {
          status: "credited",
          failure_reason: null,
          credited_amount: BigInt(valueMicro),
        },
      });
    } catch (error) {
      console.error("FAILED TO MARK SESSION CREDITED.", error.message);
      return null;
    }
  },

  /**
   * Sweeper helper — resolve a session stuck in `crediting` past
   * CREDITING_STALE_MS (a crash window from the redeem pipeline). The
   * ledger row's `reference` is deterministic (`purchase_<txHash>`), which
   * tells the two crash windows apart by querying the ledger directly:
   *   - ledger row exists for this reference → the credit DID commit →
   *     re-sync the session to `credited` (never credit again);
   *   - no ledger row → the credit never happened → release the claim back
   *     to `pending` so a later confirm/sweep can retry.
   * The redeem claim itself refuses to re-claim ANY `crediting` row that
   * is not stale, and the tx_hash @unique anchor backstops every path —
   * a ledger reference can never be written twice.
   * @param {object} session - a stale `crediting` session row
   * @returns {Promise<"re-synced"|"released"|"error">}
   */
  async resolveStuckClaim(session) {
    if (!session || session.status !== "crediting" || !session.tx_hash) {
      return "error";
    }
    try {
      const reference = `purchase_${String(session.tx_hash)}`;
      const ledgerRow = await prisma.credit_transactions.findFirst({
        where: { user_id: session.user_id, reference },
      });
      if (ledgerRow) {
        // Crash window 2→3: credit committed, session never marked.
        await this.markCredited(session.id, ledgerRow.amount);
        return "re-synced";
      }
      // Crash window 1→2: credit never committed → release the claim.
      // tx_hash/tx_block_number are cleared too — redeem's claim requires
      // a fresh `pending` row with no stamp, and since the ledger row is
      // confirmed absent, no credit ever used this stamp.
      await prisma.purchase_sessions.updateMany({
        where: { id: session.id, status: "crediting" },
        data: {
          status: "pending",
          failure_reason: null,
          tx_hash: null,
          tx_block_number: null,
        },
      });
      return "released";
    } catch (error) {
      console.error("FAILED TO RESOLVE STUCK CREDITING CLAIM.", error.message);
      return "error";
    }
  },

  /**
   * Mark a session failed with a machine-readable reason (F5).
   * Only pending sessions can fail — never a credited one.
   * @param {string} sessionId
   * @param {string} reason - one of FAILURE_REASONS
   * @returns {Promise<object|null>} updated session or null
   */
  async markFailed(sessionId, reason) {
    if (!sessionId || !reason) return null;
    try {
      // Conditional update: never downgrade a credited session to failed.
      const result = await prisma.purchase_sessions.updateMany({
        where: {
          id: String(sessionId),
          status: { in: ["pending", "crediting"] },
        },
        data: { status: "failed", failure_reason: String(reason) },
      });
      return result.count === 1
        ? this.getById(sessionId)
        : this.getById(sessionId);
    } catch (error) {
      console.error("FAILED TO MARK PURCHASE SESSION FAILED.", error.message);
      return null;
    }
  },

  /**
   * Sweeper: sessions whose TTL passed while still pending (nothing
   * submittable) → expired. Returns the count marked.
   */
  async expireStale() {
    try {
      const result = await prisma.purchase_sessions.updateMany({
        where: {
          status: "pending",
          expires_at: { lte: new Date() },
        },
        data: { status: "expired", failure_reason: "session_expired" },
      });
      return result.count;
    } catch (error) {
      console.error("FAILED TO EXPIRE STALE PURCHASE SESSIONS.", error.message);
      return 0;
    }
  },

  /**
   * Sweeper recovery candidates: sessions with a submitted-but-unconfirmed
   * txHash (pending with the hash stamped, or stuck in `crediting` from a
   * crash window). Re-running the F5 checks + redeem resolves both safely
   * because redeem is exactly-once.
   * @returns {Promise<Array>}
   */
  async findSweepable() {
    return prisma.purchase_sessions.findMany({
      where: {
        status: { in: ["pending", "crediting"] },
        tx_hash: { not: null },
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
  },
};

module.exports = { PurchaseSessions };
