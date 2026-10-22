# Wallet Payments (USDC on Base) — Shipped Behavior

**Status:** Implemented (see [requirement-spec.md](requirement-spec.md) for the F/N/AC references and [implementation-plan.md](implementation-plan.md) for the full journal).
**Companions:** [credit-units/](../credit-units/) (µ$↔USDC integer identity) · wallet login (SIWE, `AGENTS.md`).

---

## What shipped

Wallet-authenticated users can buy credits by sending **USDC on Base** from their connected wallet to the platform treasury. The server verifies every payment **on-chain, server-side** (never trusting client claims), credits exactly the amount in the confirmed `Transfer` log, and can never double-credit the same transaction. Desktop EIP-1193 only; mobile purchase flow is out of scope for v1.

### The flow

1. **Buy affordance** — the `CreditBadge` tooltip ("click to buy more") opens the `BuyCredits` modal, but only when the feature is on: the frontend probes the gate with one rate-limited request using a deliberately invalid `packId` (feature-off → `204` short-circuit **before** body validation, feature-on → `400`; no session is ever persisted by the probe). When off, the badge renders neutral with no click affordance (AC1).
2. **Pack selection** — four fixed packs (F2 source of truth: `PACKS` in `server/utils/payments/config.js`; frontend `PURCHASE_PACKS` is a display-only mirror — the on-chain amount always comes from the server session record):

   | Pack | USDC | USDC base units | Credits |
   |---|---|---|---|
   | `usd1` | 1 | 1,000,000 | 1,000 |
   | `usd5` | 5 | 5,000,000 | 5,000 |
   | `usd10` | 10 | 10,000,000 | 10,000 |
   | `usd25` | 25 | 25,000,000 | 25,000 |

   Integer-exact (AC2): 1 USDC base unit = 1 µ$ of credit exactly (USDC has 6 decimals); all math is BigInt end to end (N1) — no floats anywhere.
3. **Session creation** — `POST /credits/purchase-session` (session-auth, wallet-bound account; password-only accounts fail closed with 403) → creates a `purchase_sessions` row (30 min TTL) and returns `{ id, expectedAmountUsdc, treasuryAddress, usdcAddress, chainId, expiresAt }`.
4. **Wallet send** — the modal pre-flights: connected-chain vs session `chainId` (wrong-chain gate with explicit switch copy before any send), connected address vs the account's `wallet_address` (soft client-side check; the authoritative binding is server-side). It then sends `eth_sendTransaction` **to the USDC token contract** (from the session's `usdcAddress`) with `transfer(treasury, amount)` calldata built by `buildUsdcTransferCalldata()` (selector `a9059cbb`, two 32-byte words, string/BigInt math, fail-closed throws). Amounts are decimal strings, never floats.
5. **Verify & credit** — `POST /credits/purchase-session/:id/confirm` with `{ txHash }` → the server fetches the receipt via JSON-RPC and runs the six checks (F5): (a) treasury-bound `Transfer` log, (b) value == expected (integer), (c) `from` == owner's `wallet_address`, (d) status 1, (e) ≥ `PAYMENTS_CONFIRMATIONS` blocks, (f) tx block not older than the session (90 s clock-skew tolerance via block-header timestamp). On a full pass the atomic `redeem` pipeline (claim → `Credits.credit(userId, value, "purchase", "purchase_<txHash>")` → mark) credits the ledger exactly once (F6). The modal then polls `GET /credits/purchase-session/:id` (≤3 s cadence, N6) and calls `useCredits().refresh()` on success (F7).
6. **Failure & pending** — every failure surfaces a **human-readable reason** (AC9 — `FAILURE_REASON_COPY` maps every machine code; never a bare code). A transient outcome (unmined, RPC down) tells the user they can close the window: the background sweeper keeps retrying until the TTL passes (AC10).

### Exactly-once crediting (F6)

The single crediting path is the sequential claim→credit→mark pipeline in `server/models/purchaseSessions.js` (nested `$transaction`s deadlock on SQLite — verified live, see plan journal note 1):

- **Claim** — atomic conditional `updateMany` (`pending` → `crediting`, tx hash stamped). Exactly one concurrent caller wins; cross-session double-redeems collide on the `tx_hash @unique` index → `P2002` → already-redeemed, nothing written.
- The **background sweeper** (`paymentSweeper()`, 60 s, scheduled only when the feature is on, `.unref()`'d timer, gate re-read per sweep) is *not* a second path — it calls the same `redeem`. Duties: expire unstamped past-TTL sessions; resolve crash artifacts stuck in `crediting` (ledger-reference lookup decides release vs re-sync — never double-credits); crashed-tab recovery (re-verify + redeem sessions whose user submitted a tx and closed the tab).

### Admin surface (F10)

`GET /admin/purchases` (admin-only, inline role check matching the other credits-adjacent admin endpoints) — paged session list with tx hash, on-chain amount, credited µ$, user, status, and failure reason, for reconciling treasury inflows against the ledger.

## API endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /credits/purchase-session` | session, wallet-bound, rate-limited (IP + user) | Create a purchase session |
| `POST /credits/purchase-session/:id/confirm` | session, owner-only | Submit `{ txHash }`, run verification + redeem |
| `GET /credits/purchase-session/:id` | session, owner-only | Status poll for the modal |
| `GET /admin/purchases` | admin | Reconciliation listing |

All user-facing endpoints return `204` (or `404`) when the feature is off (AC1). Amounts cross the API boundary as exact decimal strings (BigInt serialization).

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `PAYMENTS_TREASURY_ADDRESS` | *(unset — feature off)* | Address that receives USDC; setting it (valid `0x…40` hex) enables the feature |
| `PAYMENTS_USDC_ADDRESS` | *(required to enable)* | ERC-20 USDC contract — Base mainnet `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `PAYMENTS_RPC_URL` | `https://mainnet.base.org` | JSON-RPC endpoint (needs `eth_getTransactionReceipt`, `eth_blockNumber`, `eth_getBlockByNumber`; testnet e.g. `https://sepolia.base.org`) |
| `PAYMENTS_CHAIN_ID` | `8453` | Payment chain (`84532` = Base Sepolia) |
| `PAYMENTS_CONFIRMATIONS` | `2` | Required block confirmations before crediting |

The frontend additionally needs a send-transaction-capable injected wallet (`window.ethereum`) — same EIP-1193 stack as SIWE login. Full annotated config block: `server/.env.example`.

## Verify / credit pipeline summary

```
confirm(txHash)                      sweeper (60 s, same code path)
      │                                     │
      ▼                                     ▼
 verifyReceipt  ── six F5 checks ──▶  re-verify via verifyReceipt
      │ (transient? → stay pending,          │
      │  sweeper retries until TTL)          ▼
      ▼                                  redeem()
   redeem()                             │
      │  claim: pending→crediting  ◀────┘  (tx_hash @unique + row claim =
      │  credit: Credits.credit(...)        exactly-once anchor, F6a/F6d;
      │  mark:   credited + audit copy      P2002 → already-redeemed)
      ▼
 credit_transactions { type:"purchase", amount:+µ$, reference:"purchase_<txHash>" }
      → users.credits_balance  →  GET /credits / CreditBadge (credits display)
```

## Key files

| File | Role |
|---|---|
| `server/utils/payments/config.js` | Pure config/pack/decoding/RPC helpers (F2 pack source of truth, log decode, receipt fetch) |
| `server/models/purchaseSessions.js` | Session data layer + atomic `redeem` pipeline + `resolveStuckClaim` |
| `server/endpoints/payments.js` | Purchase-session endpoints + sweeper wiring |
| `server/endpoints/admin.js` | `GET /admin/purchases` |
| `frontend/src/utils/payments.js` | Pack mirror, calldata builder, failure copy, confirm+poll loop |
| `frontend/src/models/payments.js` | API client + `paymentsEnabled()` gate probe |
| `frontend/src/components/Modals/BuyCredits/index.jsx` | The buy modal (packs → send → verify → terminal states) |
| `frontend/src/components/UserMenu/index.jsx` | Mounts the affordance on `CreditBadge`'s existing `onClick` |

## Testing

All unit/integration suites use **mocked JSON-RPC — no network in Jest** (N4). Every AC maps to a named test: `server/__tests__/utils/payments/config.test.js`, `server/__tests__/models/purchaseSessions.test.js`, `server/__tests__/endpoints/payments*.test.js` (endpoints + sweeper), `frontend/__tests__/utils/payments*.test.js`. Keep frontend test files small and split (plan journal note 7 — jest-haste memory blowup on a single combined suite).

**AC12 live evidence** (plan Step 7): performed on **Base mainnet** — failed no-op attempt `0x284b7878fe2bbbaeef2c3505e233d504c8575cfd2ada4ec232e394d105bae176` (wrong-target bug, status 1 / zero logs — correctly failed `wrong_recipient`), then the successful $1 purchase `0x30370029d754ea4e8e117770b404cf086cc077178c4330e62170e24c45f37e9d` credited 1,000 credits via ledger row `purchase_0x30370029…`. Testnet config for future runs lives in `server/.env.example`.

### Base Sepolia test runs (future)

- **USDC contract:** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, chain ID `84532`, RPC `https://sepolia.base.org`.
- **Faucets:** the **Coinbase Developer Platform (CDP) faucet** funds both test wallets and test USDC — and notably **needs no business account** for testnet faucet use, despite what the Portal UI suggests. Circle's faucet is the alternative source. Commands (via CDP):

  ```bash
  # ETH for gas + test USDC, one request per wallet:
  cdp faucet --network base-sepolia --address 0x<dev-wallet>
  cdp faucet --network base-sepolia --address 0x<test-treasury>
  ```

- **Test accounts:** the `totem-treasury-test` CDP wallet receives the transfers; dev MetaMask accounts act as payers. Set `PAYMENTS_CHAIN_ID=84532`, `PAYMENTS_USDC_ADDRESS=<sepolia USDC>`, `PAYMENTS_RPC_URL=https://sepolia.base.org`, `PAYMENTS_TREASURY_ADDRESS=<test treasury>` — and remember the connected wallet must switch to the Sepolia network in MetaMask or the modal blocks the send (wrong-chain gate).

## Operational notes

- **Sweeper duties** (per 60 s tick, only when the feature is enabled): ① bulk-expire past-TTL sessions with no submitted tx → `expired`; ② resolve crash artifacts stuck in `crediting` >60 s (ledger row exists → re-sync to `credited`; absent → release the claim, keeping the tx stamp as evidence); ③ crashed-tab recovery — re-run the full six-check verification on pending sessions with a submitted txHash, then redeem on a pass. Permanent on-chain failures (reverted, wrong token/recipient) are marked `failed` immediately with the precise reason; transient failures retry until TTL, then expire with the last verification reason recorded.
- **Rollout:** set `PAYMENTS_TREASURY_ADDRESS` (+ USDC/RPC/chain) in the deployment env and restart — migration is additive and applies on container boot; unset the treasury var to disable (sessions table stays inert).
- **F2 pack changes** must be mirrored in both the server `PACKS` table and the frontend `PURCHASE_PACKS` display table (AC2 tests assert both).
