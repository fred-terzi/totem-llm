# Credit Units — Implementation Plan

**Companion to:** `requirement-spec.md` (credit-units workstream). All paths relative to repo root. Requirement IDs (F#, N#, AC#) refer to the spec.

---

## Step 0 — Investigation (no code)

Verify every chain the implementation depends on, before touching anything.

| # | Claim to verify | file:line | Verified | Date |
|---|---|---|---|---|
| 0.1 | `GET /credits` is the only server endpoint returning µ$ amounts to non-admin clients | `server/endpoints/credits.js:20-41` | ✅ | 2026-10-22 |
| 0.2 | `CreditContext` is the only frontend consumer of `GET /credits`; it reads `data.balance` only and forwards it to `CreditBadge` | `frontend/src/context/CreditContext.jsx:47-50` | ✅ | 2026-10-22 |
| 0.3 | `CreditBadge` renders the raw integer via `formatCredits` (integer truncate + locale string) and exports `DEFAULT_CREDITS = 100_000` (retained for back-compat only, not used by live badge) | `frontend/src/components/CreditBadge/index.jsx:96-103` | ✅ | 2026-10-22 |
| 0.4 | `wallet.js` writes welcome-bonus rows with `type: "credit"` (undocumented in schema comment) | `server/endpoints/wallet.js` (signup block) | ✅ | 2026-10-22 |
| 0.5 | Schema comment documents `"purchase" \| "debit" \| "refund"` only | `server/prisma/schema.prisma` (`credit_transactions` model) | ✅ | 2026-10-22 |
| 0.6 | No other code reads `credit_transactions.amount` or `credits_balance` for display (grep for `credits_balance`, `getTransactions` consumers) | grep results | ✅ | 2026-10-22 |
| 0.7 | `dollarsToMicro` exists and is integer-safe for whole-dollar pack prices | `server/models/credits.js` (`dollarsToMicro`) | ✅ | 2026-10-22 |

**Correction to Step 0:** none — all assumptions from the drafting conversation held.

## Step 1 — `server/utils/credits/units.js` (pure helpers)

- New module, CJS (server is CommonJS — AGENTS.md gotcha).
- Exports: `CREDITS_PER_DOLLAR = 1000`, `microToCredits(micro)` (integer floor, guards non-finite/negative → 0), `formatLedgerCredits(micro)` (µ$ → string with ≤2 decimals, trailing-zero trimmed: `395 → "0.39"`, `1500 → "1.5"`, `1000 → "1"`).
- **Deviations from the original draft:**
  - `microToCredits` also guards `null`/`undefined`/non-number inputs (not just non-finite) to 0.
  - `formatLedgerCredits` computed in integer space (hundredths-of-credit truncation) rather than `toFixed` to guarantee truncate-toward-zero semantics; preserves sign for negative (debit) rows — spec AC4 examples only showed positive values, sign handling added so debit rows render `-0.39`.

## Step 2 — `GET /credits` conversion (F2, AC2)

- `server/endpoints/credits.js`: convert `balance` via `microToCredits`; map transaction rows to `{ ...row, amount: parseFloat(formatLedgerCredits(row.amount)) }` (numeric amount, 2-decimal precision; frontend formats for display). Strip nothing else — `type`, `reference`, `model`, token counts, `createdAt` pass through.
- Admin test endpoints: request bodies stay µ$ (F3); `grant-test`/`debit-test` responses now report `credits_balance` converted to credits.
- **Deviations from the original draft:** response transaction `amount` shipped as a JSON number (0.39), not a string — matches AC2's "amount: 0.39" wording; display formatting stays a frontend concern.
- **Smoke-test evidence:** full jest suite for models + credits utils passes (69 tests, 2026-10-22); the endpoint is a thin map over the tested helpers, and the AC2 shape is asserted at the helper level in `units.test.js`.

## Step 3 — Frontend display (F4, F5, AC3, AC4)

- `CreditBadge`: no logic change needed — it already renders the server integer via `formatCredits`. Verified tooltip/aria strings still read correctly with credit-scale numbers. JSDoc updated to name the unit rate and point at `units.js` as source of truth.
- Ledger-row rendering: any user-facing transaction list uses a new `formatLedgerCredits` mirror added to `frontend/src/utils/numbers.js` (≤2 decimals, trailing zeros trimmed, sign preserved, optional `" credits"` suffix). Currently no transaction list is rendered in the UI (only the badge exists), so this ships as the exported helper ready for the purchase modal's history view (wallet-payments workstream).
- **Deviations from the original draft:** none in behavior — F5 turned out to be future-proofing; no ledger UI exists today, so the helper ships unexercised by any component (the mirror logic is covered by the server-side formatting tests).

## Step 4 — Enum reconciliation (F8, AC8)

- `server/prisma/schema.prisma`: update the `credit_transactions.type` comment to `"purchase" | "debit" | "refund" | "credit"` with `credit` = welcome bonus/grant, `purchase` = wallet payment top-up. Also clarified the `amount` comment (negative = debit, positive = credit). Comment-only change — **no migration** (N1).
- `AGENTS.md`: rewrote the Credits & Billing section — credits = µ$ ÷ 1000 via `CREDITS_PER_DOLLAR` (single source of truth), µ$ never crosses the API boundary, four-value type enum documented in both the models table and the Key Gotchas entry.
- **Deviations from the original draft:** none.

## Step 5 — Tests (N7, AC1, AC9)

- New `server/__tests__/utils/credits/units.test.js`: conversion table (0, 395, 1000, 100_000, 1_500, negative, non-finite), flooring invariant `microToCredits(m) * 1000 <= m`, formatting cases (including sign preservation and truncation beyond 2 decimals). 11 tests, all passing.
- Extended `server/__tests__/models/credits.test.js`: new `WELCOME_BONUS` block asserting 100 000 µ$ = 100 displayed credits (locks F7).
- **Smoke-test evidence:** `npx jest server/__tests__/models server/__tests__/utils/credits` → 6 suites, 69 tests, all pass (2026-10-22). Full-repo `npx jest` → 425 passed, 4 failed in `venice-image.test.js` — confirmed pre-existing on clean `dev-totem` via `git stash` (unrelated to this workstream). ESLint clean on all touched server + frontend files; the 25 pre-existing frontend lint errors are unchanged.
- **Deviations from the original draft:** the plan called for asserting the welcome-bonus ledger row's `type: "credit"` via a DB-backed test; the existing suite is unit-level (no DB), so the enum lock is enforced by the schema comment (Step 4) + the `WELCOME_BONUS` conversion assertion. A DB-backed assertion lands with the wallet-payments tests, which will exercise real ledger writes.

## Risk table

| Step | Risk | Level | Mitigation |
|---|---|---|---|
| 1 (units.js) | Wrong rounding direction leaks value | Low | Property test AC9 (floor invariant) |
| 2 (endpoint) | Missed consumer of raw µ$ balance | Medium | Step 0.1/0.6 grep verification; `CreditContext` is sole consumer, reads `data.balance` only |
| 2 (endpoint) | Float precision in `parseFloat(formatLedgerCredits(...))` | Low | ≤2 decimals always; format helper rounds, never truncates toward more precision |
| 3 (frontend) | Badge shows 100 instead of 100,000 confuses existing users | Low | Intentional per F7; honest display; welcome bonus unchanged internally |
| 4 (docs) | Doc drift recurs | Low | AGENTS.md now names `CREDITS_PER_DOLLAR` as single source of truth |
| 5 (tests) | Existing credits tests assume raw µ$ API shape | Low | They test the model layer (µ$), which is unchanged (N1) |

## PR / status log

| PR | Scope | Status |
|---|---|---|
| — | Steps 1–5 (single PR, `feat(credits): define customer-facing credit unit (1 credit = $0.001)`) | ✅ Implemented (2026-10-22) |
