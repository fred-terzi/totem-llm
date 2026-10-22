# Wallet Payments — Implementation Plan

**Companion to:** `requirement-spec.md` (wallet-payments workstream). All paths relative to repo root. Requirement IDs (F#, N#, AC#) refer to the spec. This plan is a journal: steps state what was implemented (updated as work proceeds), deviations are recorded in place, never rewritten after the fact.

---

## Step 0 — Investigation (no code)

Verify every chain the implementation depends on before writing code.

| # | Claim to verify | file:line | Verified | Date |
|---|---|---|---|---|
| 0.1 | Feature-gate pattern to mirror: `GET /wallet/balance` returns `204` + no body when `TOTEM_ADDRESS` unset; UI hides the badge | `server/endpoints/wallet.js:90-101` | ✅ | 2026-10-22 |
| 0.2 | JSON-RPC pattern to reuse: `server/utils/totemBalance.js` does raw `fetch`-based `eth_call` with pure helpers, zero server deps, unit-testable without booting Prisma/Express | `server/utils/totemBalance.js:1-60` | ✅ | 2026-10-22 |
| 0.3 | `Credits.credit()` is already atomic: `prisma.$transaction` wrapping balance `increment` + ledger row create. Payment crediting must reuse this, not hand-roll a second writer | `server/models/credits.js:240-267` | ✅ | 2026-10-22 |
| 0.4 | `CacheData` (cache_data) is a plain key-value store (get/set/delete/list by prefix, TTL via `expiresAt`) with **no unique-constraint capability** → cannot enforce the F6a txHash-uniqueness invariant at the DB level | `server/models/cacheData.js` | ✅ | 2026-10-22 |
| 0.5 | Wallet-auth rate limiter is a per-IP `rateLimiter({...})` instantiated in the endpoint module; same pattern applies to session creation | `server/endpoints/wallet.js:75-76`, `server/utils/middleware/rateLimiter.js` | ✅ | 2026-10-22 |
| 0.6 | Nonce sweeper pattern: module-level `setInterval` sweep of expired DB rows, housekeeping only, never touches other consumers' rows | `server/endpoints/wallet.js:39-42` | ✅ | 2026-10-22 |
| 0.7 | `validatedRequest` puts the authenticated user (incl. `wallet_address`) on the request for session-auth'd routes; confirm exact property shape before wiring owner checks | `server/utils/middleware/validatedRequest.js` | ✅ | 2026-10-22 |
| 0.8 | Admin-route auth pattern (how `admin.js` gates on `role === "admin"`) to copy for `GET /admin/purchases` | `server/endpoints/admin.js` | ✅ | 2026-10-22 |
| 0.9 | `CreditBadge` structure + where a "Buy credits" affordance mounts; confirm `window.ethereum` is reachable from the modal (desktop EIP-1193) and how `WalletConnectButton` acquires the provider address | `frontend/src/components/CreditBadge/index.jsx`, `frontend/src/components/Modals/Password/MultiUserAuth.jsx` | ✅ | 2026-10-22 |
| 0.10 | `GET /credits` renders `"purchase"`-type ledger rows today via `formatLedgerCredits` (no frontend change expected for display — verify, don't assume) | `server/endpoints/credits.js`, `frontend/src/utils/numbers.js` | ✅ | 2026-10-22 |
| 0.11 | USDC contract address on Base Sepolia (spec names mainnet `0x8335…2913`; testnet address needed for F11) — source from official Circle docs, record here | Circle docs | ✅ | 2026-10-22 |
| 0.12 | `credit_transactions.reference` has **no unique constraint** in the schema → uniqueness must live on the new session table's txHash column (or a migration on `reference`, rejected — see Step 2 rationale) | `server/prisma/schema.prisma` (`credit_transactions` model) | ✅ | 2026-10-22 |

### Step 0 verification findings (2026-10-22)

- **0.7 — user shape:** `validateMultiUserRequest` loads the full `users` row via `User.get({ id: valid.id })` and attaches it as `response.locals.user` — includes `wallet_address`. **However, the credits endpoints don't consume `response.locals.user`;** they call `userFromSession(request, response)` (`server/utils/http.js`) inside the handler — same for `admin.js`. Payments endpoints should follow the `userFromSession` pattern (consistency with `credits.js`, and it also works in the single-user dev bypass where `response.locals.user` is never set). Single-user mode bypasses auth entirely in dev/no-AUTH_TOKEN (documented) — payments endpoints still require a wallet-bound user, so they fail closed with 401/403 either way.
- **0.8 — admin auth:** two patterns in the codebase: (a) `admin.js` uses middleware `[validatedRequest, strictMultiUserRoleValid([ROLES.admin, ROLES.manager])]` from `multiUserProtected`; (b) `credits.js` checks `user.role !== "admin"` inline after `userFromSession`. For `GET /admin/purchases`, use pattern (b) to match the other credits-adjacent admin endpoints (`debit-test`/`grant-test`) — one file, one style.
- **0.9 — mount point is ready-made:** `CreditBadge` already exposes an `onClick` prop and its default tooltip literally reads `"…click to buy more"` (`frontend/src/components/CreditBadge/index.jsx:70,77-79`). The badge is presentational and used by parents that already render `useCredits()` — the buy modal mounts wherever the badge's parent lives; the badge itself needs zero changes. `window.ethereum` pattern confirmed: inline `WalletConnectButton` (`MultiUserAuth.jsx:18-99`) does `eth_requestAccounts` → `accounts[0]` and guards with `!!window.ethereum` (`hasWallet`) — the buy modal copies this pattern for the connected-address check (and must compare it to the account's `wallet_address` — mismatch = UI error, server still binds payer via receipt).
- **0.10 — display path confirmed:** `GET /credits` maps **every** ledger row through `formatLedgerCredits(row.amount)` (`server/endpoints/credits.js:41`), type-agnostic — future `"purchase"` rows render automatically. Frontend mirror exists (`frontend/src/utils/numbers.js:70`). No frontend display change required.
- **0.11 — Base Sepolia USDC (Circle official docs, developers.circle.com/stablecoins/usdc-contract-addresses):** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Mainnet Base confirmed `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (matches spec). Chain ID 84532 for Base Sepolia. Faucets: Circle and Coinbase CDP (which the user already has — dev testing covered).
- **0.12 — confirmed:** `credit_transactions` (`schema.prisma:464-477`) — `reference String?` with no `@unique`, only `@@index([user_id])`. The `txHash @unique` on the new session table is the sole uniqueness anchor, as decided.

### Step 0 decision — session storage (spec F8 left this to the plan)

**Decision: dedicated `purchase_sessions` Prisma table.** Rationale:
- F6a (one txHash redeemed exactly once, across all users and sessions) is a database-level invariant. `cache_data` cannot express a unique constraint on a field inside a JSON value (0.4), so a cache-backed session store would reduce double-credit prevention to application-level check-then-write — exactly the race F6d forbids.
- A dedicated table gives us `txHash String? @unique` as the atomicity anchor: concurrent confirms of the same txHash collide on `P2002`, caught and treated as already-redeemed (mirrors the wallet-signup race pattern in `wallet.js`).
- Putting `@unique` on `credit_transactions.reference` instead was considered and rejected: `reference` is a shared column across all four ledger types (debits, grants, bonuses), so a global unique constraint changes semantics for unrelated writers and needs a backfill audit. The session table owns payment uniqueness; the ledger stays shape-identical (N2).
- Migration is additive (new table only) — no writes to existing tables, no lock risk on SQLite (same reasoning as the AGENTS.md no-relation gotcha).

---

## Step 1 — `server/utils/payments/config.js` + pure helpers (F1, F2, N1, N4)

New module, CJS (server is CommonJS — AGENTS.md gotcha). Mirrors `totemBalance.js`: pure, no server deps, unit-testable in isolation. Exports:

- `paymentsConfig()` — resolves `PAYMENTS_TREASURY_ADDRESS`, `PAYMENTS_USDC_ADDRESS`, `PAYMENTS_RPC_URL` (default `https://mainnet.base.org`), `PAYMENTS_CONFIRMATIONS` (default 2), `PAYMENTS_CHAIN_ID` (default 8453). `enabled` only when treasury is a valid `0x…40` hex address (same regex gate as `totemConfig()`).
- `PACKS` + `packAmounts()` — the `{5,10,25}` table; µ$ payable = `usd × 1_000_000` (integer), credits = `usd × CREDITS_PER_DOLLAR` via `units.js` — no magic 1 000 000 at call sites, one named constant (`MICRO_PER_DOLLAR` in `units.js` or sibling).
- `decodeUsdcTransfers(receiptLogs, { tokenAddress, treasuryAddress })` — parses `Transfer(address,address,uint256)` logs from a receipt; returns matching treasury-bound transfers with `from`/`value` as **BigInt**. Ambiguity (zero or multiple matching logs) returns a distinct result the caller must fail on (N3).
- `fetchReceipt(rpcUrl, txHash)` + `getBlockHeight(rpcUrl)` — raw JSON-RPC via `fetch`, injectable transport for tests.

**Status: DONE 2026-10-22** (commit `62c3c2d8`). Additions made during implementation:
- `MICRO_PER_DOLLAR = 1_000_000` added to `server/utils/credits/units.js` (was planned as "`units.js` or sibling" — landed in `units.js` beside `CREDITS_PER_DOLLAR` so no call site hardcodes the 6-decimal identity).
- `getBlockHeight(rpcUrl)` also exported (needed later for the F5f staleness check in Step 4).
- **Journal note (bug caught by tests):** the first `decodeUsdcTransfers` draft compared the full 32-byte padded topic word against the 40-char address — every address match would have silently failed (payments would verify as "not found"). Fix: take the low 20 bytes of the topic word before comparing. Locked in by the happy-path test — exactly why AC-mapped tests gate the merge.
- Verification: 28/28 payments tests pass (96.7% line coverage on `config.js`); `units` + `totemBalance` regression suites green; ESLint clean.

**Deviations from the original draft:** none (the additions above are within the step's declared scope).

## Step 2 — Prisma migration: `purchase_sessions` table (F4, F6a, N2) — ✅ DONE (2026-10-22, commit `87e4dad5`)

- `server/prisma/schema.prisma`: new model `purchase_sessions`:
  - `id` (uuid), `user_id` (relation → users, cascade), `expected_amount` (BigInt µ$ — identical to USDC base units per credit-units N2 identity), `treasury_address`, `chain_id`, `status` (`pending | crediting | credited | failed | expired` — `crediting` is the Step 3 claim marker between claim and mark), `failure_reason` (nullable string, machine-readable per F5), `tx_hash` (nullable, **`@unique`**), `tx_block_number` (nullable BigInt, stamped at confirm time for the F5f staleness check), `credited_amount` (nullable BigInt, audit copy of what the ledger received), `expires_at`, `createdAt`, `updatedAt`.
  - Index on `(user_id, createdAt)` for the admin/user listing paths.
- Migration: additive only. **No changes to `credit_transactions`** (N2). Record the migration timestamp and confirm `yarn prisma:migrate` applies cleanly against the dev SQLite DB, and that beta's next container restart picks it up (migrations run on container boot — verify the boot script applies pending migrations, per 0.8-style check).
- **Blast-radius note:** this is the plan's only data-layout step. Additive new table = low risk, but it is the step to re-verify first if beta misbehaves after deploy.

**Step 2 journal:**
- Migration `20261022122319_add_purchase_sessions` generated via `prisma migrate dev --create-only`, SQL reviewed (pure `CREATE TABLE` + 2 indexes — zero touches to existing tables), then applied; Prisma Client regenerated (v5.3.1).
- Behavior verified live against the dev SQLite DB with a throwaway script: `updateMany({ where: { id, status: "pending", tx_hash: null }, data: { status: "crediting", tx_hash } })` returns `count: 1` (the Step-3 claim pattern works); inserting/claiming the **same txHash through a second session rejects with `P2002`** (F6a anchor confirmed); BigInt roundtrips clean on `expected_amount`/`tx_block_number`/`credited_amount` (note: Prisma returns `BigInt` objects — Step 4 endpoints must stringify/Number() before JSON); cascade delete removes session rows with the user.
- Beta boot path confirmed: `docker/beta/run.sh` runs `yarn prisma:setup` (generate + migrate + seed) on every container start, so the migration applies on the next beta restart.

**Deviations from the original draft:** none.

## Step 3 — `server/models/purchaseSessions.js` (F4, F6, F8) — ✅ DONE (2026-10-22, commit `6cd97b36` model+tests+plan-journal)

Data-layer module in the `server/models/*.js` static-method style. Key method — the atomic redeem:

- `redeem({ sessionId, txHash, blockNumber, valueMicro })` → sequential claim → credit → mark pipeline (see journal note 1 below for why it is not one nested transaction):
  1. **claim** — atomic conditional `updateMany`: `pending` + `tx_hash=null` → `crediting` with the txHash/blockNumber stamped. Exactly one concurrent caller wins; every loser sees `count: 0`. A cross-session double-redeem of the same txHash surfaces here as `P2002` on the unique column → `already-redeemed`, nothing written.
  2. **ledger write** — `Credits.credit(userId, value, "purchase", "purchase_<txHash>")` (its own atomic transaction, 0.3). On throw, the claim is released back to `pending` (`failure_reason: ledger_write_failed`) — nothing credited, sweeper retries.
  3. **mark** — `credited` + `credited_amount` audit copy.
- **`resolveStuckClaim(session)`** — sweeper helper for crash artifacts: a session stuck in `crediting` past `CREDITING_STALE_MS` (60 s). Because the ledger `reference` is deterministic (`purchase_<txHash>`), it queries the ledger directly to tell the two crash windows apart: ledger row exists → re-sync to `credited` via `markCredited` (never credits again); no row → release the claim fully (status AND tx stamp cleared) so a later confirm/sweep can retry.
- Also: `create()`, `getById()`, `getOwned()` (fail-closed ownership), `getByUser()`, `listForAdmin()` (paged, with user join), `getByTxHash()`, `markFailed()` (conditional — never downgrades a credited session), `expireStale()`, `findSweepable()`, `serializeSession()` (BigInt → exact decimal strings for HTTP), `FAILURE_REASONS` (machine-readable codes, single source shared by endpoints + sweeper).

**Step 3 journal:**
- **Journal note 1 — nested `$transaction`s deadlock on SQLite (verified live, changed the design):** the original draft put the claim + `Credits.credit()` + mark inside one `prisma.$transaction` callback. That deadlocks — `Credits.credit()` opens its own `$transaction` on the shared client, and on SQLite the outer transaction's write lock blocks the inner one from the same pool → connector timeout. Verified with a live experiment (outer tx + inner credit = timeout; sequential = clean commit). The redeem is therefore a sequential pipeline whose exactly-once guarantee comes from the row-level claim + the `tx_hash @unique` anchor rather than one big transaction.
- **Journal note 2 — `credit_transactions.amount` is `Int`, not BigInt:** passing a BigInt `valueMicro` into `Credits.credit()` fails (Prisma Int column). redeem converts via `Number(valueMicro)` with a `Number.isSafeInteger` guard — safe, because µ$ amounts at our pack sizes are ≤ 25 000 000. BigInt stays at the session-table boundary (N2); the ledger keeps its existing `Int` shape.
- **Journal note 3 — crash-window recovery belongs to the sweeper, not redeem:** an early draft let redeem re-claim its own stale `crediting` row with a matching txHash. Live testing showed this cannot distinguish crash window 1→2 (no ledger row — safe to re-credit) from 2→3 (ledger row EXISTS — re-crediting would double-pay, since `credit_transactions.reference` has no unique constraint). Final design: redeem claims only fresh `pending` rows; the sweeper resolves stuck claims via `resolveStuckClaim` (ledger-lookup decides release vs re-sync) before any retry. All five recoverability scenarios verified live: 21/21 integration checks against a real SQLite DB, including both crash windows, cross-session P2002, no-double-credit balance assertions, and fail-closed ownership.
- Verification: 8/8 model unit tests (failure codes, BigInt serialization, constants) + full payments/credits/totemBalance regression suites green (70/70 combined); ESLint clean on the new model.

**Deviations from the original draft:** the redeem shape changed (sequential pipeline instead of one nested transaction, plus `resolveStuckClaim`) — required by the SQLite nesting deadlock and the crash-window ambiguity, both verified live and documented above. The draft's intent (single crediting path, atomicity via claim + unique anchor, P2002-as-already-redeemed) is fully preserved.

## Step 4 — Endpoints: `server/endpoints/payments.js` (F1, F4, F5, N5) + admin surface (F10)

- New router mounted under `/api` in `server/index.js`:
  - `POST /credits/purchase-session` — session-auth via `userFromSession` (per 0.7 finding; matches `credits.js` style), wallet-account-only (no `wallet_address` → 403, fail-closed per spec threat model), rate-limited per IP **and** per user (N5), body `{ packId }` → validates pack, creates session, returns `{ id, expectedAmountUsdc, treasuryAddress, chainId, expiresAt }`.
  - `POST /credits/purchase-session/:id/confirm` — owner-only (403 otherwise); body `{ txHash }`; runs the F5 six-check verification using Step 1 helpers + Step 3 `redeem`; returns `{ status, failureReason? }`. Non-owner/unauthenticated → 401/403 fail-closed.
  - `GET /credits/purchase-session/:id` — owner-only status poll for the frontend (F9).
  - All three return `204` (or 404) when `paymentsConfig().enabled === false` (F1, AC1).
- `GET /admin/purchases` in `server/endpoints/admin.js` (auth per 0.8 finding — inline `user.role !== "admin"` check after `userFromSession`, matching the `debit-test`/`grant-test` style in `credits.js`): paged session list with tx hash, on-chain amount, credited µ$, user, status, failure reason (F10).
- **Deviations from the original draft:** none.
- **Status: ✅ DONE** (commit `a4e1d7c9`). Journal notes:
  - `getBlockTimestamp(rpcUrl, blockNumber)` added to `config.js` — anticipated by the Step 1 note ("needed later for the F5f staleness check"). A receipt carries no timestamp, so F5f compares the session's `createdAt` against the tx block's on-chain header timestamp with a 90 s clock-skew tolerance.
  - **Verify-before-claim ordering**: `verifyReceipt` runs before `redeem`'s atomic claim, so a transient outcome (unmined, RPC down, short confirmations) never burns the one-shot `tx_hash` stamp. Exactly-once is unaffected — the claim + unique anchor still gate every credit (F6a/F6d).
  - `countTreasuryBoundTransfers` helper discriminates `wrong_token` (paid the treasury in a different ERC-20) from `wrong_recipient` (paid someone else), so the F10 admin surface can reconcile without re-reading the chain.
  - Endpoint tests (19) use the same fake-app + direct-handler pattern as `filesystem.test.js`/`invite.test.js` (Express's bundled `send`/`mime` breaks under Jest with the "charsets" TypeError; `supertest` is not a repo dep per N4). No new dependencies.

## Step 5 — Sweeper (F8, AC10)

- Module-level `setInterval` (60 s) in `server/endpoints/payments.js`, guarded so it only schedules when the feature is enabled; same housekeeping-only pattern as the wallet nonce sweeper (0.6).
- Marks sessions past `expiresAt` with no valid tx → `expired`.
- Re-checks `pending` sessions that have a submitted-but-unconfirmed `txHash` (crashed-tab recovery): re-runs the F5 checks; credits exactly once via `redeem` (all F6 invariants apply — the sweeper is not a second crediting path, it calls the same one).
- **Deviations from the original draft:** none yet.

## Step 6 — Frontend: Buy-credits modal (F9, AC2, AC9)

- `frontend/src/components/CreditBadge/`: add the buy affordance (opens the modal) — hidden entirely when the server reports the feature off (204 from session creation is the discovery signal; also gate on a `System.paymentsConfig()`-style probe if adding one, per 0.9 findings). **0.9 update:** the badge already accepts `onClick` (tooltip even says "click to buy more") — the affordance is a parent-level `onClick={openBuyModal}` prop pass, no badge changes.
- New `BuyCreditsModal`: renders the three packs with integer-exact credit labels (5 000 / 10 000 / 25 000 — AC2); on pack click: create session → `window.ethereum.request({ method: "eth_sendTransaction", params: [{ to: treasury, from: connected address, value: "0x0", data: <ERC-20 transfer calldata built from the session> }])` → poll `GET /credits/purchase-session/:id` (≤3 s interval, N6) → render `credited` / `failed` with human-readable reasons mapped from F5 codes / `expired`; refresh `useCredits()` on success (existing `refresh()` flow, F7).
- ERC-20 `transfer` calldata is built client-side (function selector + 32-byte padded amount — string/BigInt math only, no float).
- Mobile: out of scope per spec — modal shows desktop-only copy when no `window.ethereum` is present (no broken affordance).
- **Deviations from the original draft:** none yet.

## Step 7 — Tests (AC1–AC12) — **merge gate**

- `server/__tests__/utils/payments/config.test.js` — pack math (AC2 integer-exactness), config gating (AC1 server side), Transfer-log decoding happy/multiple/none, BigInt-only math (N1).
- `server/__tests__/models/purchaseSessions.test.js` — redeem happy path, double-redeem (`P2002` → already-redeemed, AC4), payer/amount/stale binding enforced at the endpoint-verification layer with mocked JSON-RPC (AC5, AC6, AC8), unmined/reverted handling (AC7).
- Endpoint tests with mocked RPC + mocked auth: feature gate (AC1), auth/rate-limit rejections (AC11), failure surfacing reasons (AC9).
- Sweeper test: expiry marking + crashed-tab credit-once (AC10).
- Testnet run (manual, AC12): `PAYMENTS_CHAIN_ID=84532` + Sepolia USDC (0.11) + test treasury → one full purchase from a dev wallet; record the tx hash and ledger row here as evidence.
- Every AC maps to exactly one named test (review-checklist requirement).
- **Deviations from the original draft:** none yet.

## Step 8 — Docs + release (workflow §4)

- `totem_docs/wallet-payments/README.md` (written last, describes shipped behavior).
- Spec `Status:` → Implemented (only after spec text matches reality — fold in any corrections).
- `totem_docs/README.md` topic row; `RELEASE.md` "Upcoming / Unreleased" bullet; `AGENTS.md` — env-var table addition (payments vars next to the `TOTEM_*` table) + Key-Gotchas entry (payments ≠ wallet balance ≠ credits distinction).
- Beta rollout order: merge → beta container restart picks up migration + code → set `PAYMENTS_TREASURY_ADDRESS` (+ USDC/RPC/chain) in `docker/beta/.env` → `docker compose up -d` → curl matrix (204-off vs enabled, 401/403/429 paths) → one real USDC purchase through the beta UI. Rollback: unset the treasury var — feature off, sessions table inert.

**Deviations from the original draft:** none yet.

---

## Risk table

| Step | Risk | Level | Mitigation |
|---|---|---|---|
| 2 (migration) | New table on SQLite; beta container must apply it on restart | Medium | Additive-only migration; verify boot-script migration application before deploy (Step 8); no writes to existing tables |
| 3 (redeem) | Double-credit via race between confirm and sweeper | High | Single atomic `redeem` is the *only* crediting path; sequential claim→credit→mark pipeline (nested `$transaction`s deadlock on SQLite — verified live); `txHash @unique` + P2002-as-already-redeemed; crash windows resolved by sweeper's `resolveStuckClaim` (ledger-reference lookup decides release vs re-sync); AC4/AC10 both hit it |
| 4 (verification) | Trusting client-supplied amount/tx data | High | All six checks read from the receipt fetched server-side (F5); amount from log BigInt-equality only |
| 4 (verification) | RPC unreachable → speculative crediting | Medium | Fail-closed N3: session stays `pending`, user told "verifying"; sweeper retries |
| 1 (log decode) | Multiple USDC Transfers in one tx (e.g. swap contracts) | Medium | Ambiguity fails the session (N3), never guesses |
| 6 (frontend) | Float/mismatch between pack display and calldata amount | Medium | Both derive from the same server session record (`expectedAmountUsdc`); AC2 locks the math |
| 6 (frontend) | Wrong-chain send (user on Ethereum mainnet in wallet) | Medium | Residual risk per spec threat model; UI shows chain + asset; failed session surfaces reason |
| 5 (sweeper) | Sweeper credits while user also confirms | High | Same atomic `redeem`; AC10 asserts exactly-once |
| 7 (tests) | Tests hit real RPC | Low | Injected transport; no network in Jest (N4/AC12) |

## PR / status log

| PR | Scope | Status |
|---|---|---|
| — | Steps 1–8 (single PR planned: `feat(payments): buy credits with USDC on Base`) | 🔲 Planned |
