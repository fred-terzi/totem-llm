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

## Step 5 — Sweeper (F8, AC10) — ✅ DONE (2026-10-22, commit `b452508e`)

- Module-level `setInterval` (60 s, `SWEEP_INTERVAL_MS`) in `server/endpoints/payments.js` via `paymentSweeper()`, scheduled from `server/index.js` only when the feature is enabled (F1 — no treasury config → no timer at all); timer is `.unref()`'d so it never holds the process (or Jest) open; same housekeeping-only pattern as the wallet nonce sweeper (0.6). `runPaymentSweep` is exported for tests (injected-seam pattern from Steps 1/4 — the sweep body is exercised directly, no timers).
- Per sweep, three disjoint duties:
  1. **`expireStale`** — bulk-mark past-TTL sessions with **no submitted tx** → `expired`.
  2. **`resolveStuckClaim`** — crash artifacts stuck in `crediting` past `CREDITING_STALE_MS` (60 s); fresh rows are left alone (in-flight claim, a concurrent caller owns it).
  3. **Crashed-tab recovery** — pending sessions WITH a submitted txHash: re-run the F5 six-check verification via the exact `verifyReceipt` code path the confirm endpoint uses, then `redeem` on a full pass. All F6 invariants apply — the sweeper is not a second crediting path, it calls the same one (F6d).
- Outcome handling in the sweep loop: `redeem` outcome → credit exactly once; `failed` outcome (reverted, wrong token/recipient — permanent by construction) → `markFailed` immediately with the precise F5 reason regardless of TTL; `pending` outcome (transient — unmined, RPC down) → retry next sweep, and `markExpired` once the session's TTL passes (never blanket-failed — the user may still get their credits if the tx lands).
- The feature gate is re-read per sweep (`paymentsConfig()` inside `runPaymentSweep`), so flipping the env var takes effect without a restart, matching the endpoints' per-request gate.
- `findSweepable()` now includes the owning `user` — the F5c payer-binding check needs the user's `wallet_address` on the re-verification pass.

**Step 5 journal:**
- **Journal note 4 — redeem's claim widened to same-session same-hash re-claim:** the Step 3 draft claimed only fresh `pending` rows with `tx_hash: null`. That made the sweeper retry a dead end: after a ledger-write failure, redeem releases the row to `pending` but the retry (sweeper or user re-confirm) could never win the claim on a stamped row. Fix: the claim's `where` accepts `tx_hash: null` **or** `tx_hash = <this same txHash>` on this same session. Safe because a pending+stamped row can ONLY arise from this session's own verified claim releasing on ledger failure — `Credits.credit()` throwing means its transaction rolled back, so no credit committed under that stamp; a stamp from a *different* session is impossible (`tx_hash @unique`); and re-stamping the same hash re-arms the F6a unique anchor. Cross-session and cross-hash double-redeems still lose the claim exactly as before.
- **Journal note 5 — `resolveStuckClaim` release now KEEPS the tx stamp:** the Step 3 draft cleared `tx_hash`/`tx_block_number` when releasing crash window 1→2. That conflicted with the crashed-tab recovery loop: the stamp records the tx the user actually submitted (evidence for the F10 admin surface) and is the hash the sweep re-verifies and re-redeems. Since the ledger row is confirmed absent (that is what chose the release branch), no credit ever used the stamp, and the @unique anchor guarantees no other session could have held it. Release now drops only `status` + `failure_reason`.
- **Journal note 6 — `expireStale` narrows to unstamped rows + new `markExpired(sessionId, reason)`:** the bulk expiry gained a `tx_hash: null` filter — a submitted-but-unmined session must not be silently expired while its tx might still land (AC10's "no valid tx" phrasing). Submitted sessions instead expire through the sweep loop's `markExpired` companion (conditional on `pending`, never downgrades a credited row), recording the **last transient verification reason** (e.g. `tx_not_found`) instead of the generic expiry code so the F10 admin surface can tell an abandoned session from one whose tx never landed.
- Verification: 10/10 sweeper tests (`server/__tests__/endpoints/payments.sweeper.test.js`) — scheduling gate (F1), bulk expiry, stuck-claim routing, crashed-tab credit-exactly-once with no-op second sweep (AC10), RPC-failure-leaves-pending retry semantics, TTL expiry of unmined submissions, permanent-failure marking; full payments/credits/totemBalance regression suites green (112/112 combined).
- Committed as `b452508e` (`feat(payments): background payment sweeper for stale/stuck purchase sessions (wallet-payments Step 5)`) — code + tests together; the plan-journal update itself is the immediately preceding commit `c677d3ec`.

**Deviations from the original draft:** three, all additive safety refinements discovered while wiring the sweeper to the Step 3 model (journal notes 4–6): the redeem claim accepts a same-session same-hash re-stamp, `resolveStuckClaim` retains the tx stamp on release, and bulk expiry excludes submitted sessions (handled by the targeted `markExpired` instead). The draft's intent — exactly-once crediting through the single redeem path, TTL expiry of abandoned sessions, crashed-tab recovery — is fully preserved and now actually reachable end-to-end.

## Step 6 — Frontend: Buy-credits modal (F9, AC2, AC9) — ✅ DONE (2026-10-22, commit `55521750`)

- `frontend/src/utils/payments.js` — pure helpers (zero side effects, unit-testable in plain Node):
  - `PURCHASE_PACKS` — the display pack table, integer-exact per AC2 (5 000 / 10 000 / 25 000 credits; USDC base-unit amounts carried as **decimal strings**, never floats — mirrors the server `PACKS`; any change there must be mirrored here). Display-only: the amount actually sent on-chain always comes from the session record.
  - `buildUsdcTransferCalldata({ recipient, amountBaseUnits })` — ERC-20 `transfer(address,uint256)` calldata (selector `a9059cbb` + two 32-byte words), string/BigInt math only. Throws on non-address recipient / non-integer amount (fail-closed, N3 — never send a malformed transfer).
  - `formatUsdcBaseUnits()` — human-readable USDC display from the exact base-unit string (pure string manipulation; BigInt round-trip tested).
  - `FAILURE_REASON_COPY` + `failureReasonCopy()` — human-readable copy for every F5 code incl. the sweeper's `session_expired`/`ledger_write_failed` and a frontend-side `feature_disabled`; unknown reasons get a safe generic message (AC9 — never a bare code).
  - `resolvePurchaseSession()` — the F9 confirm+poll loop (≤3 s cadence, N6): confirm → (pending?) → GET status → confirm again → … until `credited`/`already-redeemed`/`failed`/`expired`. Re-confirming is safe by construction (terminal states are answered from the DB; crediting is exactly-once server-side). Injectable `sleepFn`/`isCancelled` seams for tests; on deadline expiry returns `pending` → the modal hands off to the background sweeper (AC10 keeps retrying until TTL). A `204` from either call maps to `feature_disabled` (AC1 discovery parity).
- `frontend/src/models/payments.js` — API client for the three purchase-session endpoints; every method reports `{ available: false }` on the gate's `204` so callers never special-case it twice. `paymentsEnabled()` probe: deliberately sends an **invalid packId** — the server checks the feature gate BEFORE body validation, so feature-off → `204`, feature-on → `400`, and NO session is ever persisted by the probe. Fail-closed on network errors (no affordance).
- `frontend/src/components/Modals/BuyCredits/index.jsx` — the modal. Phases: packs → sending → verifying → credited / failed / expired / pending, plus two pre-flight gates: **wrong-chain** (wallet `eth_chainId` ≠ session `chainId` — the threat model's wrong-chain residual risk surfaced as explicit UI copy asking the user to switch, before any send is offered) and **no-wallet** (desktop-only copy, mobile out of scope per spec — the flow never starts, no broken affordance). Connected-wallet vs account `wallet_address` mismatch fails fast client-side (F5c still enforced server-side regardless). Calldata + amount come ONLY from the server session record (risk table mitigation). On success: `useCredits().refresh()` (F7). Wallet rejection (code 4001) returns to packs silently. The verifying/pending screens tell the user they can close the window — the sweeper owns the session from there.
- `frontend/src/components/UserMenu/index.jsx` — mounts the buy affordance: the badge's existing `onClick` prop (0.9 finding — zero badge changes) is wired to open the modal ONLY when the probe reports the feature on; when off, the badge renders with a neutral tooltip and no click affordance (AC1).
- Tests: `frontend/__tests__/utils/payments.test.js` (16: AC2 pack exactness, calldata byte-exactness + fail-closed throws, USDC formatting + BigInt round-trip, AC9 reason mapping, terminal-status coverage) and `payments.resolve.test.js` (10: the poll loop — immediate credited, already-redeemed as terminal, poll-then-reconfirm, failed/expired surfacing, deadline → sweeper handoff, 204 → feature_disabled, cancellation on unmount). 26/26 pass; server payments/credits regression suites green (76/76); ESLint clean; `vite build` succeeds.

**Step 6 journal:**
- **Journal note 7 — jest-haste memory blowup on a single combined frontend suite:** the first draft put all 26 tests in one file; running it OOM'd (4 GB heap exhausted, ~90 s in) while trivially-small suites over the same module passed. Root cause appears to be this repo's jest config (`roots: ["<rootDir>"]` + the haste map scanning the full monorepo graph) interacting badly with one larger frontend suite. Splitting into two small suites (`payments.test.js` + `payments.resolve.test.js`) made every run fast and stable. Noted for Step 7: keep frontend test files small and split.
- **Probe design:** the plan's "204 from session creation is the discovery signal" is implemented without creating any session: an invalid packId is rejected with 400 when the feature is on and short-circuits to 204 when off (the gate is checked first in the endpoint). One rate-limited request per page load.
- The client-side connected-address check intentionally mirrors `WalletConnectButton`'s `eth_accounts` pattern (0.9) and compares against the account's `wallet_address` from local storage — a soft pre-flight; the authoritative F5c binding stays server-side.

**Deviations from the original draft:** the test split (journal note 7) is the only one — organizational, not behavioral. The draft's intent (F9 flow, AC2 integer-exactness, AC9 human-readable reasons, N6 poll cadence, no badge changes, desktop-only mobile handling) is fully implemented.

**Step 6 journal — addenda from live mainnet manual testing (2026-10-22):**
- **Journal note 8 — the wallet-boundary bug (call-site error invisible to unit tests):** the first manual mainnet run sent `eth_sendTransaction` with `to` set to the **treasury address** and `transfer(treasury, amount)` as calldata. An ERC-20 transfer must be a call **on the token contract** with the recipient encoded in calldata — a direct tx to the treasury EOA executes the calldata against an EOA, so it **mines successfully as a silent no-op (status 1, zero logs)**: no USDC moves, gas burns, and the server correctly fails the session with `wrong_recipient`. Evidence tx `0x284b7878fe2bbbaeef2c3505e233d504c8575cfd2ada4ec232e394d105bae176` (block 52,948,893 — status `0x1`, 0 logs). No unit test can catch this: the calldata was byte-correct; the bug was the `to` field of the EIP-1193 call. The tell was MetaMask's own pre-send screen showing **"0 ETH / No changes"** (a no-op transfer previews as nothing happening). Fix (`3be45ee7`): the create-session response now carries the configured USDC contract address and the modal sends **to the token contract**, with a fail-closed guard when the session record lacks a well-formed token address (N3).
- **Journal note 9 — $1 pack added (`b51c1436`):** new smallest pack `usd1` (1,000 credits / 1,000,000 USDC base units) for low-friction first purchases. The pack table is intentionally **mirrored in two places** (server `PACKS` in `server/utils/payments/config.js` — the F2 source of truth — and frontend `PURCHASE_PACKS` in `frontend/src/utils/payments.js`, display-only; the on-chain amount always comes from the session record), and the AC2 tests were updated to assert all **four** packs integer-exactly. Server payments suites 57/57, frontend 26/26.

## Step 7 — Tests (AC1–AC12) — ✅ DONE (2026-10-22, merge gate passed)

- `server/__tests__/utils/payments/config.test.js` — pack math (AC2 integer-exactness, four packs after journal note 9), config gating (AC1 server side), Transfer-log decoding happy/multiple/none, BigInt-only math (N1).
- `server/__tests__/models/purchaseSessions.test.js` — redeem happy path, double-redeem (`P2002` → already-redeemed, AC4), payer/amount/stale binding enforced at the endpoint-verification layer with mocked JSON-RPC (AC5, AC6, AC8), unmined/reverted handling (AC7).
- Endpoint tests with mocked RPC + mocked auth: feature gate (AC1), auth/rate-limit rejections (AC11), failure surfacing reasons (AC9).
- Sweeper test: expiry marking + crashed-tab credit-once (AC10).
- **AC12 — live purchase evidence (recorded here per the plan):** the plan asked for a Base Sepolia testnet run; the live verification was instead performed **directly on Base mainnet** — arguably stronger evidence, since it exercises the real asset, real value, and real confirmation depths. Both transactions:
  - **Failed first attempt:** `0x284b7878fe2bbbaeef2c3505e233d504c8575cfd2ada4ec232e394d105bae176` (block 52,948,893) — the journal note 8 wrong-target bug: status `0x1`, **zero logs**, no USDC moved; the server correctly failed the session `wrong_recipient`. Kept as evidence that the six-check pipeline rejects no-op transfers (and as the bug report itself).
  - **Successful $1 run:** `0x30370029d754ea4e8e117770b404cf086cc077178c4330e62170e24c45f37e9d` (block 52,949,908) — status `0x1`, one `Transfer` log from `0xd52437db133eaa3289455d708c749a1981808bda` to the treasury, value `0xf4240` = **1,000,000 USDC base units (= 1 µ$×10⁶ = 1,000 credits)**. DB evidence: session `d5fd7f0d-decd-4b46-9436-fd457fb7b148` (user 15, `expected_amount` 1000000, chain 8453) → **`credited`**, `credited_amount` 1000000; ledger row `credit_transactions` `{ user_id: 15, type: "purchase", amount: 1000000, reference: "purchase_0x30370029…f37e9d" }` — AC3 confirmed end-to-end with real funds.
  - The testnet (Base Sepolia) configuration is fully documented in `server/.env.example` (`PAYMENTS_CHAIN_ID=84532` + Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`) for future runs; note the earlier Sepolia sessions (chain 84532 in the sessions table) were abandoned `expired` after faucet friction — the mainnet run superseded them as AC12 evidence.
- Every AC maps to exactly one named test (review-checklist requirement).
- **Deviations from the original draft:** AC12's live run happened on mainnet instead of testnet (see above); all unit/integration suites ran exactly as drafted with mocked JSON-RPC (no network in Jest, N4).

## Step 8 — Docs + release (workflow §4) — ✅ DONE (2026-10-22)

- `totem_docs/wallet-payments/README.md` (written last, describes shipped behavior).
- Spec `Status:` → Implemented (only after spec text matches reality — fold in any corrections).
- `totem_docs/README.md` topic row; `RELEASE.md` "Upcoming / Unreleased" bullet; `AGENTS.md` — env-var table addition (payments vars next to the `TOTEM_*` table) + Key-Gotchas entry (payments ≠ wallet balance ≠ credits distinction).
- Beta rollout order: merge → beta container restart picks up migration + code → set `PAYMENTS_TREASURY_ADDRESS` (+ USDC/RPC/chain) in `docker/beta/.env` → `docker compose up -d` → curl matrix (204-off vs enabled, 401/403/429 paths) → one real USDC purchase through the beta UI. Rollback: unset the treasury var — feature off, sessions table inert.

**Step 8 journal:**
- Spec corrections folded in with the status flip: F2 pack set corrected to `{1,5,10,25}` (journal note 9), F8 records the dedicated `purchase_sessions` table decision, F9 notes the tx targets the USDC token contract (journal note 8 fix), AC2 updated to four packs, AC12 annotated with the mainnet-run outcome, `Status:` → **Implemented**.
- `totem_docs/wallet-payments/README.md` written: shipped flow, four-pack table, exactly-once pipeline summary (incl. pipeline diagram), env-var table, API endpoints, key files, testing/AC12 evidence, Base Sepolia faucet/testing notes, sweeper duties, rollout/rollback.
- `AGENTS.md`: the five `PAYMENTS_*` env vars documented next to the `TOTEM_*` table (same off-by-default gating pattern); the "Credits ≠ microdollars, and ≠ wallet token" gotcha extended — payments now *create* credit purchases, and the USDC payment rail is distinct from the read-only $TOTEM balance rail.
- `RELEASE.md` Unreleased: `feat(payments)` bullet with the send-target fix and $1 pack sub-bullets.

**Deviations from the original draft:** none — all four deliverables landed as drafted; the beta curl matrix remains an ops task for the beta restart, not a docs item.

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
| — | Steps 1–8 (single PR planned: `feat(payments): buy credits with USDC on Base`) | ✅ Ready to open (Steps 1–7 code + tests complete; Step 8 docs landed. Commits: `62c3c2d8` config, `87e4dad5` migration, `6cd97b36` model, `3520c1c7` endpoints, `b452508e` sweeper, `55521750` frontend, `3be45ee7` send-target fix, `b51c1436` $1 pack; docs: plan/spec/README/RELEASE/AGENTS updates) |
