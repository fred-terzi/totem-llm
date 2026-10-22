/**
 * Credit unit conversion helpers.
 *
 * The internal accounting unit is the **microdollar** (1 µ$ = $0.000001,
 * stored as an integer in `users.credits_balance` and
 * `credit_transactions.amount`). The customer-facing unit is the **credit**:
 *
 *   1 credit = $0.001 = 1 000 µ$
 *
 * This constant is the SINGLE SOURCE OF TRUTH for that rate. Do not hardcode
 * 1000 anywhere else — import from here. All conversion happens at exactly
 * two boundaries:
 *   1. server → client (`GET /credits` response),
 *   2. display helpers (frontend formatting).
 * Raw µ$ values must never cross the API boundary to end users.
 *
 * Why µ$ internally: USDC has 6 decimals, so 1 µ$ = 1 USDC base unit exactly.
 * The upcoming wallet payment flow converts USDC base units to µ$ as a pure
 * integer pass-through — no floats, no rounding at the settlement boundary.
 */
const CREDITS_PER_DOLLAR = 1000;

/**
 * Microdollars per US dollar: 1 $ = 1 000 000 µ$.
 * Companion constant to CREDITS_PER_DOLLAR. Used by the wallet-payments
 * workstream: a pack's µ$ payable equals its USDC base-unit price exactly
 * (1 µ$ = 1 USDC base unit), so `usd × MICRO_PER_DOLLAR` is the integer
 * pass-through amount at the settlement boundary. Do not hardcode 1 000 000
 * elsewhere — import from here.
 */
const MICRO_PER_DOLLAR = 1_000_000;

/**
 * Convert microdollars to whole credits (integer floor).
 * Guards non-finite and negative inputs to 0 (balances never go negative;
 * negative ledger amounts are display-only and handled by formatLedgerCredits).
 *
 * @param {number} micro - amount in microdollars
 * @returns {number} credits (integer, floored)
 */
function microToCredits(micro) {
  if (typeof micro !== "number" || !Number.isFinite(micro) || micro <= 0) {
    return 0;
  }
  return Math.floor(micro / CREDITS_PER_DOLLAR);
}

/**
 * Format a ledger-row amount (µ$, may be negative for debits) as a credit
 * string with at most 2 decimals, trailing zeros trimmed.
 *
 *   395   → "0.39"     (a typical chat-turn debit)
 *   1500  → "1.5"
 *   1000  → "1"
 *   -395  → "-0.39"    (debit rows are stored negative)
 *   0     → "0"
 *
 * Truncation (toward zero) is computed in integer space — a fractional
 * hundredth of a credit is dropped so the displayed amount never overstates
 * the magnitude of the real ledger row.
 *
 * @param {number} micro - amount in microdollars (negative = debit)
 * @returns {string} formatted credits string
 */
function formatLedgerCredits(micro) {
  if (typeof micro !== "number" || !Number.isFinite(micro) || micro === 0) {
    return "0";
  }
  const sign = micro < 0 ? "-" : "";
  // Integer hundredths-of-credit, truncated toward zero.
  const hundredths = Math.trunc(Math.abs(micro) / 10);
  const whole = Math.floor(hundredths / 100);
  const frac = hundredths % 100;
  if (frac === 0) return `${sign}${whole}`;
  const fracStr = (frac < 10 ? "0" : "") + frac.toString().replace(/0+$/, "");
  return `${sign}${whole}.${fracStr}`;
}

module.exports = {
  CREDITS_PER_DOLLAR,
  MICRO_PER_DOLLAR,
  microToCredits,
  formatLedgerCredits,
};
