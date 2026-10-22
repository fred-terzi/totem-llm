/**
 * Wallet payments — frontend pure helpers (USDC on Base).
 *
 * Companion to `server/utils/payments/config.js` (the server is the source of
 * truth for packs, amounts, and verification — this module only builds what
 * the wallet needs and formats what the user sees).
 *
 * Money invariants (credit-units N1/N2, mirrored server-side):
 *   - ALL amount math is string/BigInt. There is no float anywhere in this
 *     module — `parseFloat`/`Number()` on a payable amount is a bug.
 *   - The amount sent on-chain is ALWAYS `session.expectedAmountUsdc` from
 *     the server's session record (risk table: "float/mismatch between pack
 *     display and calldata amount" — both derive from the same record).
 *
 * This module never talks to the network or `window.ethereum` (the API client
 * lives in `models/payments.js`, the wallet interaction in the modal) — which
 * keeps every function here unit-testable in plain Node.
 */

/**
 * The purchase pack table for display. Mirrors `PACKS` in
 * `server/utils/payments/config.js` — any change there MUST be mirrored here.
 * The values are integer-exact per AC2:
 *   - credits = usd × CREDITS_PER_DOLLAR (1 credit = $0.001)
 *   - usdc    = usd × 1 000 000 base units (USDC has 6 decimals; 1 µ$ = 1
 *     base unit, credit-units N2)
 * The pack row is display-only: the amount actually sent on-chain always
 * comes from the created session's `expectedAmountUsdc`, never from this table.
 */
export const PURCHASE_PACKS = [
  { id: "usd1", usd: 1, credits: 1_000, usdc: "1000000" },
  { id: "usd5", usd: 5, credits: 5_000, usdc: "5000000" },
  { id: "usd10", usd: 10, credits: 10_000, usdc: "10000000" },
  { id: "usd25", usd: 25, credits: 25_000, usdc: "25000000" },
];

/** keccak4("transfer(address,uint256)") — the ERC-20 transfer selector. */
const TRANSFER_SELECTOR = "a9059cbb";

/**
 * Builds the ERC-20 `transfer(address,uint256)` calldata for the wallet's
 * `eth_sendTransaction` call — pure string/BigInt math, no floats (N1).
 *
 * Layout: `0x` + 4-byte selector + 32-byte recipient word + 32-byte value word.
 *
 * @param {{recipient: string, amountBaseUnits: string|number|bigint}} opts
 *   - `recipient` — the treasury address from the session record
 *   - `amountBaseUnits` — the session's `expectedAmountUsdc` (exact decimal
 *     string from the server — never a computed float)
 * @returns {string} hex calldata (`0x` + 136 chars)
 * @throws when the recipient is not a 40-hex address or the amount is not a
 *   positive integer base-unit value (fail-closed — never send a malformed
 *   transfer, N3)
 */
export function buildUsdcTransferCalldata({ recipient, amountBaseUnits }) {
  const addr = String(recipient || "")
    .toLowerCase()
    .replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(addr)) {
    throw new Error("Invalid recipient address for transfer calldata.");
  }
  const raw = String(amountBaseUnits ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      "Invalid transfer amount — must be an integer base-unit value."
    );
  }
  const amount = BigInt(raw);
  if (amount <= 0n) {
    throw new Error("Invalid transfer amount — must be positive.");
  }
  const recipientWord = addr.padStart(64, "0");
  const valueWord = amount.toString(16).padStart(64, "0");
  return "0x" + TRANSFER_SELECTOR + recipientWord + valueWord;
}

/**
 * Formats a USDC base-unit amount (exact decimal string, 6 decimals) as a
 * human-readable USDC value — pure string manipulation, no floats (N1).
 *
 *   "5000000"    → "5"
 *   "10500000"   → "10.5"
 *   "123456789"  → "123.456789"
 *   "999"        → "0.000999"
 *
 * @param {string|number|bigint} baseUnits
 * @returns {string|null} formatted USDC amount, or null when the input is
 *   not a valid non-negative integer string (callers render nothing rather
 *   than a wrong number).
 */
export function formatUsdcBaseUnits(baseUnits) {
  const raw = String(baseUnits ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const padded = raw.replace(/^0+(?=\d)/, "").padStart(7, "0");
  const whole = padded.slice(0, padded.length - 6);
  const frac = padded.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Human-readable copy for every machine-readable F5 failure reason the
 * server can surface (`PurchaseSessions.FAILURE_REASONS`) plus the two
 * frontend-side codes (`session_expired` / `feature_disabled` parity with
 * the server's sweeper codes). AC9: the user always sees WHY a purchase
 * failed, never a bare code.
 */
export const FAILURE_REASON_COPY = {
  tx_not_found:
    "The payment hasn't been mined yet. If you just sent it, check back in a moment — your credits are added automatically once it confirms.",
  tx_reverted:
    "The transaction failed on-chain (reverted). No funds moved for this purchase — please start a new purchase.",
  tx_too_old:
    "That transaction was mined before this purchase started. Send a new payment for this purchase.",
  not_confirmed:
    "The payment is still gaining network confirmations. This usually takes only a few seconds.",
  wrong_recipient:
    "The payment went to a different address than the platform treasury. Double-check the recipient address and try again — the funds are not recoverable by the platform.",
  wrong_token:
    "The payment used a different token than USDC. Only USDC on Base is accepted — the funds are not recoverable by the platform.",
  amount_mismatch:
    "The payment amount doesn't match the selected pack. The exact amount shown for the pack must be sent.",
  payer_mismatch:
    "The payment was sent from a different wallet than the one signed in. Purchases must come from your own wallet.",
  ambiguous_transfer:
    "The transaction contained multiple transfers, so it can't be verified automatically. Contact support with the transaction hash.",
  rpc_unavailable:
    "We couldn't reach the network to verify the payment right now. Verification retries automatically — your credits will appear once it completes.",
  ledger_write_failed:
    "The payment verified, but crediting your account hit a temporary error. It retries automatically — no funds are at risk.",
  session_expired:
    "This purchase session expired before the payment was verified. Please start a new purchase.",
  feature_disabled: "Credit purchases were turned off. Please try again later.",
};

/**
 * Maps a machine-readable failure reason to human-readable copy (AC9).
 * Unknown reasons get a safe generic message (fail-visible, never a bare code).
 * @param {string|null|undefined} reason
 * @returns {string}
 */
export function failureReasonCopy(reason) {
  return (
    FAILURE_REASON_COPY[String(reason || "").trim()] ||
    "The payment could not be verified. Contact support with the transaction hash if funds left your wallet."
  );
}

/**
 * Session statuses that end the purchase flow. `already-redeemed` is the
 * confirm endpoint's reporting shape for a txHash that was credited through
 * any session (AC4) — treated as success in the UI.
 */
export const TERMINAL_SESSION_STATUSES = [
  "credited",
  "failed",
  "expired",
  "already-redeemed",
];

/** Poll cadence during an active confirm — spec N6 (≤ 3 s). */
export const PURCHASE_POLL_INTERVAL_MS = 3_000;

/** How long the open modal drives verification before handing off to the
 * background sweeper (which keeps retrying until the session's 30-min TTL).
 * 5 minutes is generous: a mined tx on Base confirms in seconds. */
export const PURCHASE_VERIFY_DEADLINE_MS = 5 * 60 * 1000;

/**
 * Drives a submitted purchase to a terminal state (F9 flow).
 *
 * The GET status endpoint only reports state — server-side verification is
 * triggered by the confirm endpoint. So the loop is: confirm → (pending?) →
 * sleep → GET status → (terminal?) → confirm again → … Both calls are safe
 * to repeat: confirm is idempotent for a given txHash (terminal states are
 * answered from the DB without an RPC round-trip) and crediting is
 * exactly-once server-side (F6a/F6d), no matter how often we re-confirm.
 *
 * @param {object} opts
 * @param {string} opts.sessionId - purchase session id
 * @param {string} opts.txHash - the tx hash the wallet returned
 * @param {Function} opts.confirmFn - async (sessionId, txHash) => {status?, failureReason?, available?, error?}
 * @param {Function} opts.statusFn - async (sessionId) => {session?, available?, error?}
 * @param {number} [opts.intervalMs] - poll cadence (N6: ≤ 3000)
 * @param {number} [opts.deadlineMs] - give up and return `pending` after this long
 * @param {Function} [opts.sleepFn] - injectable delay (tests pass a no-op)
 * @param {Function} [opts.isCancelled] - polled between steps; when true the
 *   loop returns `{status: "cancelled"}` immediately (modal unmounted)
 * @returns {Promise<{status: "credited"|"already-redeemed"|"failed"|"expired"|"pending"|"cancelled", failureReason?: string|null, session?: object}>}
 */
export async function resolvePurchaseSession({
  sessionId,
  txHash,
  confirmFn,
  statusFn,
  intervalMs = PURCHASE_POLL_INTERVAL_MS,
  deadlineMs = PURCHASE_VERIFY_DEADLINE_MS,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isCancelled = () => false,
}) {
  const deadline = Date.now() + deadlineMs;

  const terminal = (result) =>
    result && TERMINAL_SESSION_STATUSES.includes(result.status) ? result : null;

  // Drive server-side verification immediately — don't wait one interval.
  let last = await confirmFn(sessionId, txHash);
  if (last?.available === false) {
    return { status: "failed", failureReason: "feature_disabled" };
  }
  const immediate = terminal(last);
  if (immediate) return immediate;

  while (true) {
    if (isCancelled()) return { status: "cancelled" };
    if (Date.now() >= deadline) {
      // Hand off to the background sweeper: it keeps re-verifying submitted
      // sessions until the TTL passes (AC10) — the purchase is not lost.
      return { status: "pending", failureReason: last?.failureReason ?? null };
    }
    await sleepFn(intervalMs);
    if (isCancelled()) return { status: "cancelled" };

    const poll = await statusFn(sessionId);
    if (poll?.available === false) {
      return { status: "failed", failureReason: "feature_disabled" };
    }
    if (
      poll?.session &&
      TERMINAL_SESSION_STATUSES.includes(poll.session.status)
    ) {
      return {
        status:
          poll.session.status === "credited" ? "credited" : poll.session.status,
        failureReason: poll.session.failure_reason ?? null,
        session: poll.session,
      };
    }

    // Still pending — re-trigger verification (GET alone never verifies).
    last = await confirmFn(sessionId, txHash);
    if (last?.available === false) {
      return { status: "failed", failureReason: "feature_disabled" };
    }
    const done = terminal(last);
    if (done) return done;
  }
}
