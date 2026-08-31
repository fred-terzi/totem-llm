# filesystem-create-directory

## Purpose

Create a new directory or ensure an existing one exists. Can create multiple
nested directories in a single call (equivalent to `mkdir -p`). If the target
directory already exists, the operation succeeds silently — making it safe and
idempotent to use as a precondition before file writes.

**When to use:** Setting up new directory structures for projects or docs;
ensuring parent paths exist before calling `filesystem-write-text-file` (which
does **not** auto-create parents); scaffolding folder hierarchies in one shot.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ Yes | The path of the directory to create. Nested paths are supported and all intermediate levels are created automatically (like `mkdir -p`). Must be within the allowed directories. |

## Returns

A success confirmation on creation, or a silent no-op success if the directory
already existed. On failure (permission denied, invalid path outside allowed
root), an error message is returned.

## Examples

```jsonc
// Create a single new directory
{ "path": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/totem_docs" }

// Create nested directories in one call (mkdir -p behavior)
{ "path": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/totem_docs/tools/web" }

// Idempotent — safe to run even if dir already exists
{ "path": "~/totem-llm/tmp/scratch" }
```

## Gotchas & Caveats

- **Idempotent by design.** Running this on an existing directory never errors.
  You can safely call it as a guard before every write without worrying about
  "already exists" failures.

- **Does not overwrite files.** If the `path` points to an existing *file* (not
  a directory), creation will fail — you cannot replace a file with a directory
  of the same name. Remove or rename the conflicting file first.

- **No permissions parameter.** Created directories use default umask-based
  permissions. To set specific permissions, follow up with `terminal-access`
  (`chmod`).

- **Allowed directories only.** Paths outside the permitted root are rejected.
