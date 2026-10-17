# Per-User Filesystem — Requirement Spec

**Status:** Draft
**Scope:** Filesystem agent only (terminal tool is a separate workstream)
**Depends on:** Multiuser mode (`User` model, workspace membership)

---

## 1. Problem

Today the filesystem agent is a single process-wide sandbox: every user on a deployment shares one allowed directory (`$STORAGE_DIR/totemllm-fs`). Any agent session can read, overwrite, delete, or move **any other user's** files. The `FilesystemManager` singleton holds one static `#allowedDirectories` list.

## 2. Goal

In multiuser mode, each user gets a dedicated directory that **only their** agent sessions can access through the filesystem tools.

## 3. Requirements

### Functional

| # | Requirement |
|---|-------------|
| F1 | Each user gets a directory at `$STORAGE_DIR/totemllm-fs/users/<username>/` (auto-created on first filesystem operation). |
| F2 | All 10 filesystem tools (read x2, write, edit, mkdir, list, move, copy, search, info) resolve their allow-list from the **invoking user's** directory, not a global one. |
| F3 | Relative paths in tool calls resolve against the user's directory (existing behavior, preserved). |
| F4 | Cross-user access is denied with the same "Access denied" error the tool already emits for out-of-sandbox paths (no new error shape). |
| F5 | Single-user mode (no multiuser / no authenticated user on the invocation) keeps working exactly as today: allow-list = `$STORAGE_DIR/totemllm-fs`. |
| F6 | Citations and image attachments continue to work unchanged (they key off the validated path, which is now per-user). |
| F7 | `search-files` scans only the invoking user's directory. |

### Non-functional

| # | Requirement |
|---|-------------|
| N1 | Enforce at the same layer as today: `validatePath()` in `FilesystemManager`. No new security surface, no new network path, no new process. |
| N2 | Symlink defense (realpath re-check) must apply to per-user directories too — a symlink inside user A's dir pointing at user B's dir must be rejected. (Already implemented; must not regress.) |
| N3 | No data migration of existing files is mandatory for this change, but a **one-time optional migration** (Step 5) may move legacy shared files into an admin-owned directory. |
| N4 | No per-invocation directory creation cost on the hot path: create lazily, cache the resolved path per user in-process. |
| N5 | Backwards compatible: `FilesystemManager` public API (`readFile`, `writeFile`, etc.) keeps its signatures; only the allow-list source changes. |

### Out of scope

- Terminal tool per-user sandboxing (separate workstream, Option B-sandbox).
- Per-user size quotas (future: trivial to add as a check in `validatePath`-adjacent code).
- Sharing files between users (future feature).
- Frontend changes (the UI already sees tool errors/citations opaquely).

## 4. Threat Model (what this change does and does not prevent)

- ✅ Prevents: user A's agent reading/writing user B's files; one user's `rm`-style edits affecting another user's workspace.
- ✅ Prevents: symlink escapes between user dirs (realpath check).
- ❌ Does not prevent: a user's *terminal* session touching another user's dir (solved by the terminal workstream, not here).
- ❌ Does not prevent: a malicious user deleting **their own** files (expected behavior).

## 5. Acceptance Criteria

1. Given two users A and B in multiuser mode, when A's session writes `notes.md`, then B's session calls `list-directory` on the sandbox root: A's `notes.md` is not visible.
2. When B calls `read-text-file` on A's absolute path: response is an error containing "Access denied".
3. When A creates a symlink `s` → B's directory and calls `list-directory s`: "Access denied".
4. In single-user mode, existing behavior is byte-identical (same default dir, same errors).
5. A user's relative path `config.json` lands in `users/<them>/config.json`, verified by `get-file-info`.
6. `search-files` for a string present only in user A's files returns no results when run by user B.
