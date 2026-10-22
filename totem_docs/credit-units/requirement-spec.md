# Credit Units — Requirement Spec

**Status:** Draft
**Scope:** Customer-facing definition of "credit", the µ$↔credits conversion, API response shape for `GET /credits`, frontend credit display, and the `credit_transactions.type` enum cleanup. Does NOT include the wallet payment flow (separate workstream: `wallet-payments/`).
**Depends on:** Credits ledger (`server/models/credits.js`, `credit_transactions` table) as it exists today — no ledger changes. The upcoming `wallet-payments/` workstream depends on THIS workstream.

---

## 1. Problem

Today there is no credits layer at all — the "credit" and the microdollar are the same unit, which makes the customer-facing number meaningless and unbounded:

1. `GET /credits` (`server/endpoints/credits.js:31-34`) returns the raw microdollar `balance` and raw µ$ ledger `amount` values.
2. `CreditBadge` (`frontend/src/components/CreditBadge/index.jsx`) renders that raw integer verbatim. So a new wallet signup's **100 000 µ$ welcome bonus (worth $0.10) displays as "100,000 credits"**, and a future $10 top-up would display as "10,000,000 credits".
3. A typical chat turn costs ~395 µ$ ($0.000395). Displayed as raw µ$ this is either "0" (floored) or "395 credits" against a 7-figure balance — no perceptible movement.
4. Doc-vs-code drift on the ledger enum: `schema.prisma` (`credit_transactions.type`) documents `"purchase" | "debit" | "refund"`, but `wallet.js` records the welcome bonus as `type: "credit"` — an undocumented value. Any admin tooling or reconciliation built for the payment flow would filter on the wrong types.

The unit system must be settled **before** the wallet-payments workstream: the purchase modal will say "10,000 credits for $10", and payment reconciliation depends on an exact, documented µ$↔USDC relationship.

## 2. Goal

Define **1 credit = $0.001** (1 000 µ$) as the customer-facing unit. All internal accounting stays in integer microdollars; conversion to credits happens only at the API boundary (`GET /credits`) and in frontend formatting. The µ$ value never crosses the API boundary. No data migration.

## 3. Requirements

### Functional

| # | Requirement |
|---|-------------|
| F1 | The conversion rate is a single exported constant `CREDITS_PER_DOLLAR = 1000` in a new `server/utils/credits/units.js`. Credits = floor(µ$ / 1000). All other code derives from this constant — no hardcoded 1000s elsewhere. |
| F2 | `GET /credits` returns `{ balance, transactions }` where `balance` is **credits** (integer, floored from µ$) and each `transactions[]` row carries `amount` in **credits** (float, 2-decimal precision) plus its existing non-amount fields (`type`, `reference`, `model`, `createdAt`). Raw µ$ values are removed from the response. |
| F3 | `POST /credits/debit-test` and `POST /credits/grant-test` keep accepting **µ$** amounts in their request bodies (admin-only internal tools, unchanged contract), but their responses report the new balance in credits. |
| F4 | `CreditBadge` renders the server-supplied credit balance with thousands separators (existing `formatCredits` behavior, unchanged). |
| F5 | Ledger rows rendered in any user-facing list show up to 2 decimals (e.g. `0.39 credits` for a 395 µ$ debit) so per-turn debits are visible. The balance badge itself stays integer-floored. |
| F6 | The pack price table for the future purchase UI is defined in **dollars** (e.g. `{ usd: 10 }`), stored via `dollarsToMicro()`, and displayed as `credits = usd × CREDITS_PER_DOLLAR`. (Table itself ships with `wallet-payments/`; the conversion helper ships here.) |
| F7 | The welcome bonus remains **100 000 µ$ internally** in `WELCOME_BONUS` (`server/models/credits.js`) and now displays as **100 credits**. No change to the bonus amount. |
| F8 | The `credit_transactions.type` enum is reconciled with reality: the schema comment and docs bless `"purchase" | "debit" | "refund" | "credit"` where **`credit` is the documented welcome-bonus/grant type** and `purchase` is reserved for the upcoming payment flow. No rows are migrated. |

### Non-functional

| # | Requirement |
|---|-------------|
| N1 | **No ledger changes.** `credit_transactions.amount` stays integer µ$; `users.credits_balance` stays integer µ$; `Credits.debit/credit/debitUsage` signatures and math are untouched. Credits are a display unit only. |
| N2 | **Integer-exact payment boundary.** µ$ is chosen so 1 µ$ = 1 USDC base unit (USDC has 6 decimals). The conversion µ$↔USDC in the future payment flow is a pure integer pass-through — no floats, no rounding. This workstream must not introduce any float math on internal amounts. |
| N3 | Conversion is enforced at exactly two boundaries: server→client (`GET /credits` response) and display helpers. No frontend component performs µ$ math; the frontend renders what the server sends. |
| N4 | Rounding rules, stated once: balance display = floor to whole credits; ledger-row display = µ$/1000 rounded to ≤2 decimals; pack prices = exact (dollars divide cleanly at rate 1000); internal math = integer µ$ always. |
| N5 | `microToDisplay()` remains `@internal` (admin/debug only) per its existing JSDoc — this workstream does not change its status or expand its usage. |
| N6 | Backwards compatibility inside this repo: the admin test endpoints and `Credits` model API keep their signatures (F3); only the `GET /credits` response shape changes (it is the only consumer-facing contract, and its sole consumer is `CreditContext`). |
| N7 | Unit tests in `server/__tests__/utils/credits/units.test.js` cover: standard conversions, flooring behavior, 2-decimal ledger formatting, the property `credits × 1000 ≤ µ$` for floored values, and zero/negative guards. |

### Out of scope

- **Wallet payment flow** (purchase sessions, EIP-3009 signatures, webhooks, reconciliation) — separate workstream: `totem_docs/wallet-payments/`, depends on this spec.
- **Purchase UI** (the "buy credits" modal) — ships with `wallet-payments/`.
- **Changing the welcome bonus amount** — stays 100 000 µ$ (= 100 credits displayed). F7 documents the intentional display change.
- **On-chain $TOTEM balance display** (`GET /wallet/balance`, `TotemBalanceBadge`) — different unit, different concern, untouched.
- **Admin dashboard/usage-stats UI** — none exists yet; `getUsageStats()` stays µ$-internal until an admin surface is built.

## 4. Threat Model (what this change does and does not prevent)

- ✅ Prevents: **microdollar leakage to end users.** Today `GET /credits` hands raw internal pricing units to the client; after this change µ$ values cannot reach the DOM or any consumer of the public API.
- ✅ Prevents: unit drift — a single `CREDITS_PER_DOLLAR` constant plus tests mean the display rate cannot diverge between endpoints or components.
- ✅ Prevents (prepares for): payment-amount confusion — the µ$ = USDC-base-unit identity is documented here so the payment workstream cannot introduce a rounding boundary at settlement.
- ❌ Does not prevent: a future endpoint returning µ$ by mistake. Mitigation is convention + tests, not a type system. Any new endpoint returning amounts must go through `units.js` helpers (enforced by review; noted in AGENTS.md).
- ❌ Does not prevent: a user learning the 1 credit = $0.001 relationship (it is trivially inferable and not meant to be secret). What stays internal is per-token pricing and `microToDisplay`, not the credit rate itself.
- ❌ Does not prevent: admin test endpoints being callable by non-admins (pre-existing, out of scope — admin check unchanged).

## 5. Acceptance Criteria

1. **AC1 (rate constant):** Given `server/utils/credits/units.js`, when imported, then it exports `CREDITS_PER_DOLLAR = 1000`, `microToCredits(micro)` = `Math.floor(micro / 1000)`, and `formatLedgerCredits(micro)` producing ≤2-decimal strings; all values in `GET /credits` responses derive from these (grep-verified: no other literal 1000 divisor in server credit paths).
2. **AC2 (API shape):** Given a user with `credits_balance = 100_000` and a 395 µ$ debit row, when `GET /credits` is called, then the response is `{ balance: 100, transactions: [{ amount: 0.39, ... }] }` and no field anywhere in the response equals a raw µ$ value.
3. **AC3 (badge):** Given the AC2 response, when the frontend renders `CreditBadge`, then it shows `100` (not `100,000`).
4. **AC4 (ledger row display):** Given a 395 µ$ debit, when its row is displayed in a user-facing list, then it renders `0.39 credits`; given a 1 500 µ$ debit, then `1.5 credits`.
5. **AC5 (no balance regression):** Given any sequence of debits/credits through the existing `Credits` model, when compared before and after this change, then `users.credits_balance` and `credit_transactions.amount` values are byte-identical (ledger untouched).
6. **AC6 (welcome bonus):** Given a new wallet signup, when the account is created, then `credits_balance = 100_000` (µ$, unchanged) and `GET /credits` reports `balance: 100`.
7. **AC7 (admin endpoints):** Given an admin calling `POST /credits/grant-test` with `{ amount: 500 }` (µ$), when it succeeds, then the response reports the updated balance in credits and the ledger row stores −500/+500 µ$ as before.
8. **AC8 (enum reconciliation):** Given the shipped code, then `schema.prisma`'s `credit_transactions.type` comment and the AGENTS.md credits section both document `"purchase" | "debit" | "refund" | "credit"` with `credit` = bonus/grant, matching what `wallet.js` actually writes; the `credits.test.js` suite asserts the welcome-bonus row uses `type: "credit"`.
9. **AC9 (unit tests):** `npx jest server/__tests__/utils/credits/units.test.js` passes, including the invariant `microToCredits(m) * 1000 <= m` for all m ≥ 0.
