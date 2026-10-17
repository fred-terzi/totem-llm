# Per-User Filesystem — Implementation Plan

Companion to `requirement-spec.md` in this directory.
All paths relative to repo root `totem-llm/`.

---

## Step 0 — Verify the user-identity chain (investigation, no code) ✅ DONE

Goal: know exactly how to get the authenticated user into `aibitat.handlerProps`.

**Findings (verified 2026-10-16):**

| Entry point | User source | Notes |
|---|---|---|
| WS agent (`AgentHandler.createAIbitat()`) | `this.invocation.user_id` | Stamped at chat time by `WorkspaceAgentInvocation.new()` from `userFromSession()`. Already used at `index.js:81,506,701,736,846` — consistent pattern. No `this.user` property on `AgentHandler`. |
| Ephemeral agent | `this.#userId` (constructor param, optional → defaults `null`) | Developer-API workspace-thread endpoints. Pass `this.#userId ?? null` at `ephemeral.js:~514`. |
| Job-based aibitat (memory extraction) | **none** | Observer/Reflector construct `AIbitat` directly; no filesystem plugin attached. No action needed. |

**Key facts:**
- `invocation.user_id` is a Prisma `Int` (nullable) → registry key is numeric; use `String(userId)` for map key.
- F5 (single-user) holds: `user_id` is nullable in schema; falsy → `getFilesystem()` fallback.
- **Correction to Step 2:** source is `this.invocation.user_id ?? null` (not `this.user?.id`).

## Step 1 — Per-user registry in `lib.js` ✅ DONE

File: `server/utils/agents/aibitat/plugins/filesystem/lib.js`

**What was implemented:**

1. `FilesystemManager` now accepts an optional `constructor(initialDirectories)` param. When provided, `ensureInitialized()` seeds `#allowedDirectories` from that list instead of the legacy `totemllm-fs` root. Zero behavioural change when omitted (the default instance).
2. Module-level `perUserRegistry` Map (key = `String(userId)`, value = `FilesystemManager`). `getFilesystemFor(userId)`:
   - `userId == null` → returns the shared default instance (F5).
   - `userId` is numeric → returns (or creates + caches) a `FilesystemManager` rooted at `$STORAGE_DIR/totemllm-fs/users/<userId>/`.
   - Directory is **not** created at lookup time — it's created lazily by the existing `#initializeFilesystem()` → `fs.mkdir(recursive)` on first `validatePath()` call (N4).
3. `validatePath()` untouched (N2 — symlink/realpath defense preserved as-is).
4. Backwards-compatible `module.exports`:
   - `module.exports` is the default `FilesystemManager` instance (existing `require("./lib.js")` call sites still work).
   - `module.exports.getFilesystem()` → default instance (no-op, kept for clarity).
   - `module.exports.getFilesystemFor(userId)` → per-user or default instance.
   - `module.exports.defaultFs` → alias to the default instance.

**Deviations from the original draft:**
- No separate `userFsRoot()` helper — the path is inlined in `getFilesystemFor()` (simpler, one call site).
- Constructor param instead of a `setAllowedDirectories()` setter (no new public API surface; `#initializeFilesystem` already handled the `directories` argument).
- Directory creation stays lazy (on first `validatePath()`), not eager `mkdirSync` at lookup. Matches the existing `#initializeFilesystem` contract.

**Smoke-tested:** default identity, F5 fallback (null/undefined), cache hit, cross-user denial (F4 message verbatim), relative path resolution into `users/<id>/`, lazy creation confirmed. ESLint clean.

## Step 2 — Pipe `userId` into `handlerProps`

1. In `server/utils/agents/index.js` `createAIbitat()`, add to the `handlerProps` object:
   ```js
   handlerProps: {
     invocation: this.invocation,
     log: this.log,
     routingMetadata: this.routingMetadata || null,
     userId: this.invocation.user_id ?? null,   // verified Step 0: Prisma Int, nullable
   }
   ```
   Note: `this.invocation.user_id` is already the established pattern in this file (see lines 81, 506, 701, 736, 846). No constructor changes needed.
2. Ephemeral agent (`ephemeral.js:~514`): add `userId: this.#userId ?? null` to `handlerProps`. When `null`, Step 1's fallback applies (F5).
3. Job-based aibitat: **no change** — filesystem plugin is not attached to those clusters.

## Step 3 — Point all 10 tools at the per-user manager

In each plugin file under `server/utils/agents/aibitat/plugins/filesystem/`, replace the singleton lookup:

| File | Change |
|---|---|
| `read-text-file.js` | `getFilesystem()` → `getFilesystemFor(this.super.handlerProps?.userId)` |
| `read-multiple-files.js` | same |
| `write-text-file.js` | same |
| `edit-file.js` | same |
| `create-directory.js` | same |
| `list-directory.js` | same |
| `move-file.js` | same (source **and** destination validate against the same per-user manager — cross-user moves denied automatically) |
| `copy-file.js` | same |
| `search-files.js` | same (its `getAllowedDirectories()` loop at lines ~130/202 then naturally scans only the user's dir — F7) |
| `get-file-info.js` | same |

To keep the diff small and consistent, add a one-line helper in each file (or import from `lib.js`):
```js
const fsMgr = () => getFilesystemFor(this.super.handlerProps?.userId);
```
No other logic changes: citations, image attachments, head/tail, truncation all operate on the validated path and keep working (F6).

## Step 4 — Error-message consistency (F4)

`validatePath` already throws/logs `Access denied - path outside allowed directories: ...`. Verify the 10 plugins surface that message verbatim to the LLM (no new wording), so a cross-user attempt looks identical to any sandbox escape.

## Step 5 — Optional one-time migration (N3)

1. Add a script `scripts/migrate-fs-to-users.js` (or a server-side endpoint behind admin):
   - For the admin user (or a chosen `OWNER`), copy `totemllm-fs/*` → `totemllm-fs/users/admin/*` (excluding the new `users/` dir itself).
   - Keep the old top-level files **read-only in place** or delete after confirmation — do not move silently.
2. Document in `totem_docs/per-user-filesystem/README.md` how to run it. Mark "not required" in RELEASE notes.

## Step 6 — Tests

Add `server/__tests__/utils/agents/aibitat/plugins/filesystem/per-user.test.js` covering the acceptance criteria in the spec:

1. Two fake users → A writes `notes.md`; B's `list-directory` of its root does not show it.
2. B reads A's absolute path → `Access denied`.
3. A creates symlink → B's dir; A's `list-directory` on it → `Access denied` (N2).
4. `handlerProps.userId` undefined → global default manager used (F5 regression guard).
5. Relative write lands under `users/<user>/` (AC5).
6. `search-files` content hit in A's dir is invisible to B (F7).

Run the existing aibitat test suite (`yarn test` scoped to `server/__tests__/utils/agents/aibitat`) to confirm no regressions in citation/attachment paths.

## Step 7 — Docs & release

1. `totem_docs/per-user-filesystem/README.md`: layout diagram, migration runbook, pointer to the terminal workstream.
2. `totem_docs/README.md`: add a row/link to this workstream.
3. `RELEASE.md`: one bullet — "Filesystem tools are now per-user sandboxes in multiuser mode; legacy shared files require optional migration script."

---

## Ordering & risk

| Step | Risk | Notes |
|---|---|---|
| 0 | none | investigation only |
| 1 | low | additive; `getFilesystem()` untouched |
| 2 | low | additive property on `handlerProps` |
| 3 | **medium** | 10-file mechanical change — biggest blast radius; mitigated by Step 6 tests |
| 4 | low | message check only |
| 5 | low | opt-in, copy-not-move by default |
| 6 | — | gate for merge |
| 7 | — | docs only |

Suggested PR split: **PR1** = Steps 0–4 + 6 (the feature). **PR2** = Step 5 + 7 (migration & docs). This keeps the security-relevant change testable and reviewable in isolation.
