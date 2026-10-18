# Plan: Restore the Original Wallet Login Implementation

**Goal:** Get back to the simple, robust single-code-path wallet login from
commit `403de195` (direct EIP-1193 `window.ethereum` flow), stripping out the
mobile rework (WalletConnect v2 → Reown AppKit → MetaMask Connect) that
degraded reliability on both Android and iPhone.

**Branch:** `dev-totem` (new branch off latest: `git checkout -b revert/wallet-original-flow`)

---

## Current State Assessment

| Piece | Status | Action |
|---|---|---|
| `server/endpoints/wallet.js` — nonce/verify endpoints | Improved since original (DB-backed nonce store, not in-memory Map) | **Keep** server-side improvements |
| `server/endpoints/wallet.js` — `/auth/wallet/ping` | Debug-only artifact from mobile debugging | **Remove** |
| `server/endpoints/wallet.js` — `/wallet/balance` ($TOTEM badge) | Unrelated to login; works | **Keep** |
| `frontend/.../MultiUserAuth.jsx` — `WalletConnectButton` | ~Original (labels changed only) | **Keep**, minor label cleanup |
| `frontend/.../WalletConnectMobile.jsx` (279 lines, `@metamask/connect-evm`) | Source of mobile fragility + ESM crash fix needed | **Delete** |
| `frontend/src/models/system.js` — `walletVerify()` retry loop (3 retries, reload recovery) | Masks failures unpredictably; can double-verify | **Revert to original simple fetch** |
| `frontend/src/models/system.js` — `walletPing()` | Debug artifact | **Remove** |
| `frontend/package.json` — `@metamask/connect-evm` | Unused after removal | **Remove dependency** |

**Why keep the DB-backed nonce store:** the original in-memory `Map` had a real
bug — nonces vanished on server restart, so logins died *after* the user
approved the signature. That fix is orthogonal to the mobile problems and is
strictly better. We restore the *method* (direct `window.ethereum`), not the bugs.

---

## Steps

### Phase 1 — Frontend removal (the actual fix)

1. **Delete `frontend/src/components/Modals/Password/WalletConnectMobile.jsx`.**
2. **Remove its import and `<WalletConnectMobile />` usage** from
   `MultiUserAuth.jsx` (line ~9 and ~416).
3. **Revert `system.js` `walletVerify()`** to the original single-attempt
   `fetch` (see `git show 403de195:frontend/src/models/system.js` for the
   reference; keep the JSDoc). Remove `walletPing()`.
4. **Remove `@metamask/connect-evm`** from `frontend/package.json` and run
   `yarn install` in `frontend/` to clean the lockfile.
5. **Restore original button labels** in `WalletConnectButton`:
   - Divider text: `or` (was `on desktop`)
   - Button text: `Connect Wallet` (was `Connect Wallet in Browser`)
6. **Add an EIP-6963-aware wallet-detection nicety (optional, small):**
   `window.ethereum` detection already works in wallet browsers (MetaMask app
   browser, Trust, Coinbase). For plain mobile Safari/Chrome, show a helpful
   message: *"Open this page in the MetaMask app to sign in"* with a
   `https://metamask.app.link/` deep link that carries the current URL. This
   is ~10 lines, no SDK, and replaces what the mobile components tried to do.

### Phase 2 — Server cleanup

7. **Remove the `/auth/wallet/ping` endpoint** from `wallet.js`.
8. **Leave `/auth/wallet/nonce` and `/auth/wallet/verify` intact** — they are
   the original endpoints plus the DB-backed nonce store. Verify the
   `CONSUMED_TTL_MS` 30s replay window behavior still matches the simple
   frontend (it does — single verify call consumes and allows one reload
   recovery within 30s; with retries gone this is fine but confirm no double-
   issue of tokens on repeated verify calls).
9. **No DB migration needed.** `cache_data` nonce storage uses existing tables.

### Phase 3 — Verification

10. **Desktop (Chrome + MetaMask extension):** full login → home redirect,
    new wallet gets 10 credits + default workspace, existing wallet logs in.
11. **Android:** MetaMask in-app browser login end-to-end; then plain
    Chrome → verify helpful redirect message appears and deep link works.
12. **iPhone:** Safari → same checks; MetaMask in-app browser login.
13. **Regression:** password login still works; $TOTEM balance badge still
    loads for wallet accounts.
14. **Lint & test:** `yarn lint && yarn test` (per AGENTS.md).

### Phase 4 — Ship

15. Commit message (Conventional Commits, per AGENTS.md):
    `revert(auth): restore original direct EIP-1193 wallet login flow`
16. PR into `main-totem` with before/after notes and test matrix above.

---

## Risk Notes

- **Mobile web browsers without a wallet:** the original method genuinely
  cannot sign messages there — no injected provider exists. The Phase 1.6
  deep-link message is the honest, dependency-free answer. If in-page mobile
  support is ever needed again, treat it as a separate, isolated feature —
  not baked into the login path.
- **Existing users who signed in via the SDK flows:** their accounts are
  address-keyed (`wallet_address`), unchanged. They log in identically under
  the restored flow. No data migration.
- **What we are deliberately NOT reverting:** DB-backed nonces, balance
  endpoint, workspace auto-create, ESM alias fix (harmless once the SDK is
  gone, keep it for safety).
