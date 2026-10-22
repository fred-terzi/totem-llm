/**
 * Credit unit helpers — frontend mirror of `server/utils/credits/units.js`.
 *
 * The internal accounting unit is the **microdollar** (1 µ$ = $0.000001,
 * stored as an integer in `users.credits_balance` and returned raw by admin
 * endpoints like `GET /admin/users`). The customer-facing unit is the
 * **credit**: 1 credit = $0.001 = 1 000 µ$.
 *
 * `CREDITS_PER_DOLLAR = 1000` mirrors `server/utils/credits/units.js`, the
 * single source of truth. Do not hardcode 1000 anywhere else — import from
 * here. Raw µ$ values must never be rendered to users (see AGENTS.md,
 * "Credits" section); convert with `microToCredits` before display.
 */

/** Credits per US dollar: 1 credit = $0.001. Mirrors the server constant. */
export const CREDITS_PER_DOLLAR = 1000;

/** Microdollars per credit (1 credit = $0.001 = 1 000 µ$). */
export const MICRO_PER_CREDIT = CREDITS_PER_DOLLAR;

/**
 * Convert microdollars to whole credits (integer floor).
 * Guards non-finite and negative inputs to 0 — mirrors the server-side
 * `microToCredits` exactly, so admin displays agree with what the user's
 * own `GET /credits` balance shows for the same underlying µ$ value.
 *
 * @param {number} micro - amount in microdollars
 * @returns {number} credits (integer, floored)
 */
export function microToCredits(micro) {
  if (typeof micro !== "number" || !Number.isFinite(micro) || micro <= 0) {
    return 0;
  }
  return Math.floor(micro / CREDITS_PER_DOLLAR);
}

/**
 * Convert whole credits to microdollars (integer). The inverse of
 * `microToCredits` for admin grant flows: the admin UI speaks credits, the
 * `POST /credits/grant-test` endpoint's µ$ contract is unchanged.
 *
 * Throws on non-integer or non-positive input (fail closed — a malformed
 * grant must never silently become a 1000×-smaller µ$ grant).
 *
 * @param {number} credits - amount in whole credits
 * @returns {number} microdollars (integer)
 */
export function creditsToMicro(credits) {
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    !Number.isInteger(credits) ||
    credits <= 0
  ) {
    throw new Error("credits must be a positive integer");
  }
  return credits * MICRO_PER_CREDIT;
}
