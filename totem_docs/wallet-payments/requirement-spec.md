# Wallet Payments (USDC on Base) — Requirement Spec

**Status:** Implemented
**Scope:** User-initiated credit purchases paid in USDC on Base via direct wallet `transfer` to a treasury address; server-side on-chain verification; crediting the billing ledger; frontend "Buy credits" flow; admin reconciliation surface. Does NOT include: $TOTEM-token payments (future second rail), EIP-3009 gasless payments (future upgrade), CDP integration for treasury sweeps (ops concern, out of app scope for v1), fiat/card payments, refunds flow, subscription/auto-top-up.
**Depends on:** `credit-units/` (✅ Implemented) — the µ$↔USDC integer identity (1 µ$ = 1 USDC base unit), `CREDITS_PER_DOLLAR`, the `"purchase"` ledger type reservation, and the credits-at-the-API-boundary contract. Also depends on the existing wallet auth stack (SIWE, `users.wallet_address`) and `TOTEM_RPC_URL`-style JSON-RPC access to Base.

---

## 1. Problem

Users can spend credits (per-token billing on chat and image generation) but there is **no way to acquire them** beyond the one-time 100 000 µ$ welcome bonus and admin-only `grant-test`. The `credit_transactions.type` enum already reserves `"purchase"` for wallet payment top-ups (`schema.prisma`, credit-units spec F8), and `GET /credits` already renders ledger rows in credits — but nothing ever writes a `purchase` row. The billing system is a ticking clock: every beta user is drawing down a $0.10 bonus with no path to refill.

## 2. Goal

A signed-in wallet user can buy credits by sending USDC (on Base) from their connected wallet to the platform treasury address, with credits appearing in their balance within seconds of on-chain confirmation. The server verifies every payment **on-chain, server-side** (never trusting client claims), credits exactly the amount in the confirmed transfer log, and can never double-credit the same transaction. The flow works end-to-end on Base Sepolia for testing before mainnet enablement.

## 3. Requirements

### Functional

| # | Requirement |
|---|-------------|
| F1 | **Payment asset:** v1 accepts exactly one asset: **USDC on Base** (mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals; Base Sepolia equivalent for test runs). Config via env: `PAYMENTS_TREASURY_ADDRESS` (receives funds), `PAYMENTS_USDC_ADDRESS`, `PAYMENTS_RPC_URL` (defaults to `https://mainnet.base.org`), `PAYMENTS_CHAIN_ID` (defaults `8453`). The feature is **off when `PAYMENTS_TREASURY_ADDRESS` is unset** (mirrors the `TOTEM_ADDRESS` feature-gate pattern; endpoint returns 204, UI hides the buy button). |
| F2 | **Fixed packs:** the purchase UI offers exactly `{ usd: 1, 5, 10, 25 }`. Credits displayed = `usd × CREDITS_PER_DOLLAR` (1 000 / 5 000 / 10 000 / 25 000 credits). µ$ payable = `usd × 1 000 000` = USDC base units 1:1 (integer pass-through, credit-units N2). No custom amounts in v1. *(Correction during implementation: the $1 pack was added for low-friction first purchases — implementation plan Step 6, journal note 9.)* |
| F3 | **Payment method:** direct ERC-20 `transfer` from the user's connected wallet to the treasury address, executed client-side via the wallet's EIP-1193 provider (desktop) — same `window.ethereum` path as SIWE login. User pays gas (fraction of a cent on Base). The server NEVER signs or submits inbound payment transactions. |
| F4 | **Purchase session lifecycle:** `POST /credits/purchase-session` (session-auth, wallet account) creates a session record: `{ id, user, expectedAmountUsdc (integer base units), treasuryAddress, chainId, status: "pending", expiresAt }`. Sessions expire (default 30 min). Session creation is rate-limited (same in-memory limiter pattern as wallet auth). |
| F5 | **Verification (server-side, client-claim-free):** `POST /credits/purchase-session/:id/confirm` with `{ txHash }` → server fetches the transaction receipt via JSON-RPC (`PAYMENTS_RPC_URL`), locates the USDC `Transfer` log, and validates ALL of: (a) `to` == treasury address, (b) `value` == session's expected amount (integer equality), (c) `from` == the user's `wallet_address`, (d) tx status == 1 (success), (e) tx mined with ≥ `PAYMENTS_CONFIRMATIONS` (default 2) blocks, (f) tx's block is not older than the session's creation (no replaying pre-session deposits). Any mismatch → session moves to `failed` with a machine-readable reason; nothing is credited. |
| F6 | **Double-credit prevention (non-negotiable invariants):** (a) one `txHash` can be redeemed **exactly once** across all users and sessions — enforced by a unique constraint on the purchase record's tx hash; (b) credits are written **only** after (a) passes and F5's checks all succeed; (c) the credited µ$ amount equals the `value` in the on-chain log, never a client-supplied number; (d) crediting and session-status update happen atomically (single transaction / `upsert` with unique constraint, Prisma `P2002` caught and treated as already-redeemed, mirroring the wallet-signup race pattern). |
| F7 | **Ledger write:** on successful verification, record `credit_transactions` row `{ type: "purchase", amount: +value (µ$), reference: "purchase_<txHash>" }` and increment `users.credits_balance` via the existing `Credits.credit()` path. The row renders in `GET /credits` and `CreditBadge` refreshes via the existing `refresh()` flow. |
| F8 | **Pending-session recovery:** a background sweeper (same pattern as the nonce sweeper in `wallet.js`) marks expired sessions `expired` and re-checks `pending` sessions that already have a submitted-but-unverified tx (crashed-tab recovery). Sessions are stored in a dedicated `purchase_sessions` Prisma table (decision + rationale in the implementation plan Step 0; a cache-backed store was rejected because it cannot express the F6a uniqueness invariant at the DB level). |
| F9 | **Frontend "Buy credits" modal:** opened from the `CreditBadge` (and a low-balance affordance). Shows the four packs (F2), on click builds and sends the `transfer` calldata through the wallet (the transaction targets the USDC token contract; the treasury is the calldata-encoded recipient), then polls session status (`GET /credits/purchase-session/:id`) until `credited` / `failed` / `expired`, showing human-readable failure reasons (F5 reasons mapped to copy). Mobile path is **out of scope for v1** (MetaMask Connect deeplink flows are login-only today) — see Out of scope. |
| F10 | **Admin reconciliation:** `GET /admin/purchases` (admin-only) lists purchase sessions with tx hash, on-chain amount, credited µ$, user, status, and failure reason — enough to manually reconcile treasury inflows against the ledger. |
| F11 | **Testability on Base Sepolia:** setting `PAYMENTS_CHAIN_ID=84532` + Sepolia USDC address + a test treasury makes the entire flow work on testnet, including a CI-friendly unit suite with mocked JSON-RPC (no network in tests). |

### Non-functional

| # | Requirement |
|---|-------------|
| N1 | **Integer-only money math.** All amounts (USDC base units, µ$, credits) are integers/BigInt end-to-end. No `parseFloat`/float arithmetic anywhere in the payment path. µ$↔USDC conversion is a pure pass-through (credit-units N2). Pack µ$ derives from `usd × 1 000 000` via a helper in `server/utils/credits/units.js` (or sibling) — no magic literals at call sites. |
| N2 | **Ledger stays append-only and untouched in shape.** No changes to `credit_transactions` columns; `"purchase"` was already reserved. If a session table is added, it holds no monetary authority — the chain + ledger are the source of truth. |
| N3 | **Fail-closed everywhere.** Missing treasury config → feature off. RPC unreachable → session stays `pending`, user told "verifying", never credited speculatively. Ambiguous log (e.g. multiple Transfers in one tx) → fail the session rather than guess. |
| N4 | **No new runtime dependencies in server.** The USDC Transfer log parsing and receipt polling use the existing JSON-RPC `fetch`-based pattern from `totemBalance.js` (raw `eth_getTransactionReceipt` + manual log decode), not ethers/viem server-side. Frontend may use the wallet provider already present via the login stack. |
| N5 | **Rate limiting & auth.** Session creation is session-authenticated (wallet login required — purchases are impossible for password-only accounts in v1, since verification matches the payer to `wallet_address`) and rate-limited per IP + per user. Confirm is session-authenticated and only reachable by the session's owner. |
| N6 | **Latency target:** credits appear within ~10 s of on-chain confirmation (poll interval ≤ 3 s during an active confirm; sweeper interval 60 s for background). |
| N7 | **Secrets hygiene.** No private keys in the app for v1 (plain transfer, F3). Treasury address is public config. CDP API keys, when the treasury-sweep workstream lands, live only in deployment env — never in the repo. |

## 4. Out of scope

- **$TOTEM as payment asset** — future second rail; requires a price oracle (deferred).
- **EIP-3009 gasless payments** (`transferWithAuthorization`) — upgrade path if "no ETH for gas" proves a real blocker; CDP Server Wallet (user has a CDP account/project) is the designated submitter for that future, replacing any hot EOA.
- **CDP treasury sweeps / conversion to fiat** — ops-side outbound management, separate workstream.
- **Mobile (MetaMask Connect) purchase flow** — v1 is desktop EIP-1193 only; mobile users can buy on desktop (balance is account-level, not device-level).
- **Refunds / clawbacks / dispute flow** — admin can debit via existing tooling; formal refunds deferred.
- **Subscriptions, auto-top-up, custom amounts, promo codes.**

## 5. Threat model

**✅ Prevents:**
- **Fake-confirmation attacks:** client claiming "I paid" without an on-chain tx — server verifies against the chain (F5), never the client.
- **Double-crediting:** same txHash redeemed twice (unique constraint, F6a), or same funds credited to two users (F5c binds the payer to the session owner).
- **Underpayment/partial payment:** integer equality on the log's `value` (F5b) — no rounding games.
- **Cross-user replay:** transferring once, claiming on two accounts — `from` must equal the claiming user's wallet (F5c) and hash uniqueness (F6a).
- **Pre-session deposit replay:** old unrelated treasury deposits being redeemed — session-created-before-block check (F5f).
- **Session spam:** rate limiting on session creation (N5).
- **Feature-surface leak when unconfigured:** feature-gate off → no endpoints, no UI (F1).

**❌ Does not prevent:**
- **User sends funds on the wrong chain / wrong token** — plain `transfer` gives no pre-flight guarantee; mitigated by UI showing chain + asset explicitly; failed sessions surface the reason. (EIP-3009/relayer workstream would narrow this.)
- **User sends to a mistyped address** — inherent to wallets; UI copy-only mitigation.
- **Treasury-side risks** (sweep compromise, CDP credential leak) — owned by the future treasury-sweep workstream, not this one.
- **Frontend compromise / phishing lookalikes** — out of app scope.
- **Reorg > 2 blocks on Base** — considered practically negligible; `PAYMENTS_CONFIRMATIONS` is tunable for extra depth.
- **Missing-identity behavior (mandatory statement):** a request with no valid session or a session owned by a different user is rejected 401/403 (fail-closed) — there is no anonymous or shared-context purchase path; a password-only account (no `wallet_address`) cannot create purchase sessions (fail-closed, F5c has nothing to match against).

## 6. Acceptance Criteria

1. **AC1 (feature gate):** Given `PAYMENTS_TREASURY_ADDRESS` unset, when any purchase endpoint is called, then the server returns 204/404 per F1 and the frontend renders no buy affordance; given it is set, the flow is discoverable.
2. **AC2 (pack math):** Given the pack table `{1,5,10,25}`, when the UI renders, then payable USDC base units are exactly `1_000_000 / 5_000_000 / 10_000_000 / 25_000_000` and displayed credits are `1000/5000/10000/25000` — integer-exact, no floats.
3. **AC3 (happy path):** Given a confirmed, valid USDC transfer to treasury from the session owner's wallet, when confirm is called, then `credit_transactions` gains `{ type: "purchase", amount: +value, reference: "purchase_<txHash>" }`, `users.credits_balance` increases by the same µ$, and `GET /credits` reflects it.
4. **AC4 (double-credit):** Given AC3 succeeded, when confirm is called again with the same txHash (any session, any user), then no second ledger row is written and the response reports already-redeemed.
5. **AC5 (payer binding):** Given a valid tx whose `from` differs from the session owner's `wallet_address`, when confirm is called, then the session fails with reason `payer-mismatch` and nothing is credited.
6. **AC6 (amount binding):** Given a tx whose `value` differs from the session's expected amount, when confirm is called, then the session fails with reason `amount-mismatch` and nothing is credited.
7. **AC7 (unmined/reverted):** Given a pending or status-0 transaction hash, when confirm is called, then the session stays/becomes failed-pending appropriately and no credit is written until a confirmed successful receipt exists.
8. **AC8 (pre-session replay):** Given a tx mined before the session's creation block, when confirm is called, then the session fails with reason `stale-tx`.
9. **AC9 (failure surfacing):** Given any F5 failure, when the frontend polls session status, then a human-readable reason is shown and the ledger is unchanged.
10. **AC10 (sweeper):** Given a session past `expiresAt` with no valid tx, when the sweeper runs, then it is marked `expired`; given a pending session whose tx later confirms, the sweeper credits it exactly once (same invariants as F6).
11. **AC11 (auth & rate limits):** Given an unauthenticated caller or non-owner of the session, when hitting session endpoints, then 401/403; given >N session creations from one IP in the window, then 429.
12. **AC12 (testnet + unit):** Given `PAYMENTS_CHAIN_ID=84532` config, the flow completes on Base Sepolia; `npx jest server/__tests__/**/payments*` passes with mocked JSON-RPC covering AC3–AC8. *(Outcome: the unit/integration suites passed exactly as written; the live end-to-end run was instead performed on **Base mainnet** — stronger evidence, recorded with tx hashes and ledger row in the implementation plan Step 7 and topic README. The testnet configuration remains documented in `server/.env.example` for future runs.)*
