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
- **Deviations from the original draft:** none.

## Step 2 — `GET /credits` conversion (F2, AC2)

- `server/endpoints/credits.js`: convert `balance` via `microToCredits`; map transaction rows to `{ ...row, amount: parseFloat(formatLedgerCredits(row.amount)) }` (numeric amount, 2-decimal precision; frontend formats for display). Strip nothing else — `type`, `reference`, `model`, token counts, `createdAt` pass through.
- Admin test endpoints: request bodies stay µ$ (F3); `grant-test`/`debit-test` responses now report `credits_balance` converted to credits.
- **Deviations from the original draft:** response transaction `amount` shipped as a JSON number (0.39), not a string — matches AC2's "amount: 0.39" wording; display formatting stays a frontend concern.

## Step 3 — Frontend display (F4, F5, AC3, AC4)

- `CreditBadge`: no logic change needed — it already renders the server integer via `formatCredits`. Verified tooltip/aria strings still read correctly with credit-scale numbers.
- Ledger-row rendering: any user-facing transaction list uses a new `formatLedgerCredits` mirror (or receives pre-formatted strings) showing ≤2 decimals + "credits" suffix. Currently no transaction list is rendered in the UI (only the badge exists), so this ships as the exported helper in `frontend/src/utils/numbers.js` ready for the purchase modal's history view.
- **Deviations from the original draft:** none — F5 turned out to be future-proofing; no ledger UI exists today.

## Step 4 — Enum reconciliation (F8, AC8)

- `server/prisma/schema.prisma`: update the `credit_transactions.type` comment to `"purchase" | "debit" | "refund" | "credit"` with `credit` = welcome bonus/grant. Comment-only change — **no migration** (N1).
- `AGENTS.md`: rewrite the Credits & Billing "gotcha" — credits = µ$ ÷ 1000, display-only, `CREDITS_PER_DOLLAR` is the single source of truth, µ$ never crosses the API boundary; document the four-value enum.
- **Deviations from the original draft:** none.

## Step 5 — Tests (N7, AC1, AC9)

- New `server/__tests__/utils/credits/units.test.js`: conversion table (0, 395, 1000, 100_000, 1_500, negative, non-finite), flooring invariant `microToCredits(m) * 1000 <= m`, formatting cases.
- Extend `server/__tests__/models/credits.test.js`: welcome-bonus ledger row asserts `type: "credit"` (locks the blessed enum).
- Smoke test the endpoint: run dev server, `GET /credits` with a session cookie, verify AC2 shape.
- **Deviations from the original draft:** none.

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
| — | Steps 1–5 (single PR, `feat(credits): define customer-facing credit unit (1 credit = $0.001)`) | 🔲 Not started |
