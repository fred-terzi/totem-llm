# Credit Units

Define the customer-facing "credit" as a display unit over the internal microdollar ledger: **1 credit = $0.001** (1 000 µ$).

## Documents

| Document | Purpose |
|---|---|
| [requirement-spec.md](./requirement-spec.md) | What & why — unit definition, conversion boundaries, rounding rules, enum reconciliation |
| [implementation-plan.md](./implementation-plan.md) | How, in what order — investigation findings, steps, risk table, PR log |

## Summary

- **Internal accounting stays integer microdollars** — no ledger migration, no changes to `Credits.debit/credit/debitUsage`.
- **Credits are display-only**, converted at exactly two boundaries: `GET /credits` (server→client) and display helpers. Raw µ$ never reaches the client.
- **Why 1 credit = $0.001:** a $10 pack = 10,000 credits; the 100 000 µ$ welcome bonus = an honest 100 credits; a typical turn (~395 µ$) = 0.39 credits, so the badge moves perceptibly. Bonus: 1 µ$ = 1 USDC base unit (USDC has 6 decimals), so the upcoming wallet-payment flow converts money-in with a pure integer pass-through.
- **Enum cleanup:** `credit_transactions.type` officially blesses `"credit"` (welcome bonus/grant) alongside `"purchase" | "debit" | "refund"` — matching what `wallet.js` has always written. Comment/docs change only; no data migration.

## Status

✅ **Implemented (2026-10-22)** — see `implementation-plan.md` PR log for smoke-test evidence. Prerequisite complete for the `wallet-payments/` workstream (the purchase UI speaks credits).

## Shipped surface

| Piece | Where |
|---|---|
| `CREDITS_PER_DOLLAR`, `microToCredits()`, `formatLedgerCredits()` | `server/utils/credits/units.js` (single source of truth) |
| `GET /credits` returns credits (`balance` floored int, ledger `amount` numeric ≤2 decimals) | `server/endpoints/credits.js` |
| Admin test endpoints: µ$ bodies, credit responses | `server/endpoints/credits.js` |
| Frontend ledger-row display helper (ready for purchase history) | `frontend/src/utils/numbers.js` |
| Unit tests (11) + welcome-bonus lock | `server/__tests__/utils/credits/units.test.js`, `server/__tests__/models/credits.test.js` |
