# Per-User Filesystem — Implementation Plan

Companion to `requirement-spec.md` in this directory.
All paths relative to repo root `totem-llm/`.

---

## Step 0 — Verify the user-identity chain (investigation, no code)

Goal: know exactly how to get the authenticated user into `aibitat.handlerProps`.

1. Trace the WS auth path in `server/index.js` — confirm what the auth middleware attaches to the socket (expected: `socket.data.user` or similar) on chat/agent connections.
2. Trace the endpoint that runs a workspace agent (`server/endpoints/` + `server/utils/agents/index.js` `WorkspaceAgent`) and confirm the socket/user is in scope at `createAIbitat()` (`server/utils/agents/index.js:~790`), which is where `handlerProps` is assembled (`invocation`, `log`, `routingMetadata`).
3. Confirm the same is true for ephemeral agents (`server/utils/agents/ephemeral.js:~510`) and job-based aibitat instances (`server/jobs/helpers/memory-extraction-utils.js`) — decide whether those run "as a user" at all (likely no user → must fall back to single-user mode per F5).

**Output:** one-sentence answer per entry point: *who is the user, and where do we read them from*.

## Step 1 — Per-user registry in `lib.js`

File: `server/utils/agents/aibitat/plugins/filesystem/lib.js`

1. Add a user-dir resolver:
   ```js
   function userFsRoot(userIdOrName) {
     // $STORAGE_DIR/totemllm-fs/users/<slug>
     // slug = sanitized username (lowercase, [a-z0-9._-]); fall back to `user-<id>`
   }
   ```
2. Add a **registry** (module-level, process-lifetime — users are bounded, no eviction needed):
   ```js
   const #perUser = new Map(); // key: userId -> FilesystemManager
   function getFilesystemFor(userId) {
     if (!userId) return getFilesystem();          // F5: single-user fallback
     if (!#perUser.has(userId)) {
       const dir = userFsRoot(userId);
       fs.mkdirSync(dir, { recursive: true });      // N4: lazy, cheap, idempotent
       #perUser.set(userId, new FilesystemManager({ allowedDirectories: [dir] }));
     }
     return #perUser.get(userId);
   }
   ```
   Reuse the existing `FilesystemManager` constructor/`setAllowedDirectories` — do **not** fork the class. Keep `getFilesystem()` untouched for backwards compat (N5).
3. Keep `validatePath()` exactly as-is — it already enforces against `this.#allowedDirectories` per manager instance, including the realpath/symlink check (N2). No changes to the security core.

## Step 2 — Pipe `userId` into `handlerProps`

1. In `server/utils/agents/index.js` `createAIbitat()`, add to the `handlerProps` object:
   ```js
   handlerProps: {
     invocation: this.invocation,
     log: this.log,
     routingMetadata: this.routingMetadata || null,
     userId: this.user?.id ?? null,   // from Step 0's verified source
   }
   ```
   (Ensure `this.user` is populated wherever `WorkspaceAgent` is constructed — add it to the constructor opts if needed.)
2. Ephemeral agent (`ephemeral.js`) and job helpers: pass `userId` **only if** a real end-user is attributable; otherwise leave `undefined` so Step 1's fallback applies (F5).

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
