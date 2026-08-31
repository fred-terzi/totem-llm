# filesystem-copy-file

## Purpose

Copy a file or directory from a source path to a destination path, creating a
duplicate while leaving the original intact. For directories, performs a
**recursive copy of all contents** (the entire subtree is duplicated). If the
destination already exists, the operation **fails** — it will not merge into or
overwrite an existing target. Both source and destination must be within the
allowed directories.

**When to use:** Duplicating a file for editing while preserving the original;
creating backups (`config.json` → `config.json.bak`); copying templates before
customizing; snapshotting a directory tree before risky operations.

**When NOT to use:**
- You want to move (not duplicate) → `filesystem-move-file`.
- The destination already exists and you intend to overwrite/merge → handle that
  explicitly first (delete or rename the target), since this tool refuses.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source` | `string` | ✅ Yes | The path of the existing file or directory to copy. Must exist and be within allowed directories. Directories are copied recursively including all nested contents. |
| `destination` | `string` | ✅ Yes | The target path where the copy is created. **Must not already exist** (operation fails if it does). Within allowed directories. Parent of a file destination must exist. |

## Returns

A success confirmation on completion. On failure — typically "source not found"
or "destination already exists" — an error message describes the cause. The
partial state on a failed recursive copy is implementation-dependent; treat a
failure as "not reliably completed."

## Examples

```jsonc
// Duplicate a config file as a backup before editing
{
  "source": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/server/.env.development",
  "destination": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/server/.env.development.bak"
}

// Copy a file into another directory (target dir must exist)
{
  "source": "/home/fred-terzi/templates/README.md",
  "destination": "/home/fred-terzi/project/docs/README.md"
}

// Recursive copy of an entire directory tree
{
  "source": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/totem_docs",
  "destination": "/home/fred-terzi/backup/totem_docs"
}
```

## Gotchas & Caveats

- **Destination must not exist.** Unlike `cp -r` in a shell (which can merge
  into an existing directory), this tool fails if the destination path is taken.
  To add files into an existing folder, target specific file paths inside it
  rather than copying onto the folder itself — or clear/rename the target first.

- **Recursive for directories.** Copying a directory duplicates everything under
  it, preserving internal structure. Large trees take longer and consume more
  disk; check available space before copying big subtrees (e.g., `node_modules`).

- **Symlinks / special files** are copied per implementation behavior — verify
  if you're duplicating paths that contain symlinks or sockets.

- **Both source and destination must be within allowed directories.** You cannot
  copy from outside the permitted root into it, or vice versa.
