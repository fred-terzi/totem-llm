# Per-User Filesystem Isolation

**Status:** Implemented (v0.2.x)
**Spec:** [requirement-spec.md](./requirement-spec.md)
**Plan:** [implementation-plan.md](./implementation-plan.md)

---

## What it does

In multiuser mode, each authenticated user's agent sessions are sandboxed to a
dedicated directory. No user's agent can read, write, or traverse another
user's files through the 10 filesystem tools.

| Mode | Allow-list root |
|------|----------------|
| Multiuser, authenticated | `$STORAGE_DIR/totemllm-fs/users/<user_id>/` |
| Multiuser, unauthenticated / single-user | `$STORAGE_DIR/totemllm-fs/` (shared, legacy) |

The `user_id` is the Prisma `User.id` (integer) from the JWT session, piped
through `handlerProps.userId` into every plugin handler.

## How it works (3 layers)

```
┌─────────────────────────────────────────────────────────────────┐
│  Plugin handler (e.g. read-text-file.js)                        │
│  const filesystem = getFilesystemFor(this.super.handlerProps?.userId); │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│  lib.js — getFilesystemFor(userId)                              │
│  • userId == null  → return defaultFilesystem (shared root)     │
│  • userId = N      → return perUserRegistry.get("N")           │
│                       (lazy-create + cache FilesystemManager)   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│  FilesystemManager.validatePath(path)                           │
│  • Resolves against #allowedDirectories (user-scoped)           │
│  • Symlink realpath re-check (N2)                               │
│  • Throws "Access denied – …" on any out-of-scope path          │
└─────────────────────────────────────────────────────────────────┘
```

## Directory layout

```
$STORAGE_DIR/totemllm-fs/
├── (legacy shared files — visible only in single-user / unauth mode)
└── users/
    ├── 1/          ← admin
    │   ├── notes.md
    │   └── projects/
    ├── 9/          ← your test user
    │   └── hello.txt
    └── 42/
```

## Migration (optional)

If you had files in the shared root before this change and want them
available to a specific user:

```bash
yarn fs:migrate --dry-run      # preview
yarn fs:migrate --userId 1     # copy (not move) into users/1/
```

The originals remain in the shared root — delete manually after review.
Re-running is safe (idempotent).

## Tests

```
server/__tests__/utils/agents/aibitat/plugins/filesystem/per-user.test.js
```

6 tests covering all acceptance criteria (isolation, cross-user denial,
symlink escape, single-user fallback, relative path resolution, search
isolation). Run with:

```bash
yarn --cwd server test per-user
```

## Related workstreams

| Workstream | Status | Notes |
|-----------|--------|-------|
| Per-user filesystem (this) | ✅ Done | 10 tools scoped to `users/<id>/` |
| Per-user terminal sandbox | 🔲 Planned | Separate workstream; terminal tool still runs with full shell access |
| Per-user size quotas | 🔲 Future | Trivial: check in `validatePath`-adjacent code |
