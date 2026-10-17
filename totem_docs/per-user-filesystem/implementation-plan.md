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

## Step 2 — Pipe `userId` into `handlerProps` ✅ DONE

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

## Step 3 — Point all 10 tools at the per-user manager ✅ DONE

In each plugin file under `server/utils/agents/aibitat/plugins/filesystem/`, replaced the module-level singleton lookup with a per-request, per-user lookup.

**What was implemented:**

1. In all 10 plugin files, the top-level `const filesystem = require("./lib.js")` was changed to `const { getFilesystemFor } = require("./lib.js")`, and inside each tool's `handler` (first line of the `try` block) the manager is now resolved per-invocation:
   ```js
   const filesystem = getFilesystemFor(
     this.super.handlerProps?.userId
   );
   ```
   All subsequent calls in that handler (`filesystem.validatePath`, `filesystem.readFileContent`, `filesystem.getAllowedDirectories()`, etc.) now operate against the invoking user's sandbox. `userId == null` (single-user mode, F5) transparently falls back to the shared default instance — no branching in the plugins.

2. `search-files.js` had a second, module-level reference: the standalone `readMatchingFileContents()` helper (called via `.call(this, …)`) also resolved its manager per-invocation with the same one-liner, so `includeFileContents: true` reads are scoped to the same user's sandbox.

**Deviations from the original draft:**
- No shared `fsMgr()` helper was added — instead the one-line lookup is inlined in each handler (11 total sites: 10 handlers + `search-files.js`'s `readMatchingFileContents`), keeping the change fully self-contained per file and identical in shape to the existing `this.super.*` usage.
- `move-file.js` / `copy-file.js`: both `source` and `destination` are validated against the *same* per-user manager, so cross-user moves/copies are denied automatically (as planned).

**Smoke-tested (end-to-end, via the real plugin handlers):**
- User 42 writes `notes.txt` → lands in `users/42/`; user 7's same relative write → lands in `users/7/`; both files intact.
- User 7 reads user 42's absolute path → `Access denied - path outside allowed directories.` (verbatim F4 message, surfaced to the LLM).
- `userId: null` → writes land in the legacy shared `totemllm-fs/` root (F5 regression guard).
- All 10 files pass `node --check`; ESLint clean across the whole `plugins/filesystem/` directory.

`validatePath()` in `lib.js` was left untouched — per-user isolation is entirely enforced at the allow-list layer (N1), and the symlink/realpath defense (N2) is inherited unchanged by every per-user instance.

## Step 4 — Error-message consistency check (F4) ✅ DONE

`validatePath` throws three `Access denied` variants (`path outside allowed directories`, `symlink target outside allowed directories`, `parent directory outside allowed directories`). Verified all 10 plugins surface the thrown `e.message` verbatim to the LLM — no new wording introduced.

**Findings (verified 2026-10-16):**

| Plugin | Error surface | Pattern |
|---|---|---|
| `read-text-file` | handler catch | `Error reading file: ${e.message}` |
| `read-multiple-files` | handler catch + inner per-file catch | `Error reading files: ${e.message}` / `Error - ${error.message}` per item |
| `write-text-file` | handler catch | `Error writing file: ${e.message}` |
| `edit-file` | handler catch | `Error editing file: ${e.message}` |
| `create-directory` | handler catch | `Error creating directory: ${e.message}` |
| `list-directory` | handler catch | `Error listing directory: ${e.message}` |
| `move-file` | handler catch | `Error moving file: ${e.message}` |
| `copy-file` | handler catch | `Error copying file: ${e.message}` |
| `get-file-info` | handler catch | `Error getting file info: ${e.message}` |
| `search-files` | handler catch + `readMatchingFileContents` helper | `Error searching files: ${e.message}` / `Error reading file: ${error.message}` |

All pass `e.message` through unchanged. A cross-user denial renders identically to a legacy sandbox escape (e.g. `Error reading file: Access denied - path outside allowed directories.`) — F4 satisfied with no code changes required.

## Step 5 — Optional one-time migration (N3) ✅ DONE

1. `scripts/migrate-fs-to-users.mjs` (ESM, matching repo `scripts/*.mjs` convention — deviation: plan said `.js`, repo standard is `.mjs`):
   - Copies top-level entries from `$STORAGE_DIR/totemllm-fs/` → `$STORAGE_DIR/totemllm-fs/users/<userId>/`.
   - **Copy, never move** — originals stay in place. Operator reviews and removes duplicates manually.
   - **Idempotent** — entries already present at the destination are skipped on re-run.
   - Skips `users/`, `sessions/`, and any `.git*` entry at the source root.
   - `--dry-run` flag for a read-only preview.
   - `--userId N` selects the destination (default `1` = admin).
   - `--storage-dir P` overrides `$STORAGE_DIR` for testing.
   - Exit 0 on success/no-op, 1 on error (bad args, I/O failure).
2. `package.json` — added `"fs:migrate": "node scripts/migrate-fs-to-users.mjs"` for ergonomic invocation (`yarn fs:migrate`).

**Verified:** syntax check, dry-run listing, real copy (3 items + nested dirs), second-run idempotency (0 copied / 3 skipped), bad `--userId` rejection (exit 1).

## Step 6 — Tests ✅ DONE

**What was implemented:**

`server/__tests__/utils/agents/aibitat/plugins/filesystem/per-user.test.js` — 6 tests covering all acceptance criteria, testing the security boundary in `lib.js` directly (no AIbitat instance, no provider mock, no fake `super` objects). All plugin handlers delegate to `validatePath()` / `getAllowedDirectories()`, so testing those methods covers the same guarantee.

**Storage isolation:** `process.env.STORAGE_DIR` is set to a unique `os.tmpdir()` path (`/tmp/totem-fs-test-<pid>/`) **before** the first `require()` of `lib.js`, so every filesystem operation lands under the temp dir — never `~/totem-llm/`. Jest's per-file module registry prevents the `perUserRegistry` singleton from leaking across test files. `afterAll` removes the temp dir.

| # | AC | Test |
|---|-----|------|
| 1 | AC1 | A writes `notes.md`; B's `validatePath` on A's file → `Access denied` |
| 2 | AC2 | B reads A's absolute path → exact `Access denied - path outside allowed directories.` message |
| 3 | AC3 | A creates symlink → B's dir; A validates symlink → `Access denied` (N2) |
| 4 | AC4 | `userId=null` → default root is `<storage>/totemllm-fs` (not `users/`); write+read works |
| 5 | AC5 | Root is `<storage>/totemllm-fs/users/42`; file accessible via absolute path + `getFileStats` |
| 6 | AC6 | B's allowed dirs exclude A's; A's file invisible to B; A can still access own file |

**Suite run (2026-10-16):**
```
Test Suites: 5 passed, 5 total   (incl. abort.test.js, untooled, ollama, abortSignal)
Tests:       29 passed, 29 total
Time:        0.83 s
```
ESLint clean.

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

Suggested PR split: **PR1** = Steps 0–4 + 6 (the feature) ✅ complete. **PR2** = Step 5 + 7 (migration & docs). This keeps the security-relevant change testable and reviewable in isolation.
