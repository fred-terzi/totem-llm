# filesystem-move-file

## Purpose

Move or rename files and directories. Can move a file between different
directories and/or change its name in a single operation (like `mv`). If the
destination path already exists, the operation **fails** — it will not silently
overwrite an existing target. Works across different directories within the
allowed root, and can be used for simple renames within the same directory.

**When to use:** Renaming a file or folder, relocating a file into a different
directory (e.g., organizing `totem_docs/`), refactoring module paths where the
target name is free.

**When NOT to use:**
- The destination already exists and you want to replace it → remove/rename the
  existing target first, or copy then delete the source manually.
- You need to keep the original in place → `filesystem-copy-file`.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source` | `string` | ✅ Yes | The path of the existing file or directory to move. Must exist and be within allowed directories. Moving a directory moves its entire subtree. |
| `destination` | `string` | ✅ Yes | The target path where the item should end up. **Must not already exist** (operation fails if it does). Within allowed directories. For a rename, same parent dir with a new name; for a move, a different parent dir. |

## Returns

A success confirmation including source and destination on completion. On
failure — most commonly "destination already exists" or "source not found" — an
error message describes the cause. The source is **not** modified on failure
(the operation is atomic in that sense).

## Examples

```jsonc
// Rename a file within the same directory
{
  "source": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/notes.md",
  "destination": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/NOTES.md"
}

// Move a file into a subdirectory (target dir must exist)
{
  "source": "/home/fred-terzi/drafts/tool-doc.md",
  "destination": "/home/fred-terzi/docs/tools/tool-doc.md"
}

// Move an entire directory (subtree moves with it)
{
  "source": "/home/fred-terzi/old-folder",
  "destination": "/home/fred-terzi/archive/old-folder"
}
```

## Gotchas & Caveats

- **Destination must not exist.** If the target path is already taken (file or
  directory), the move fails rather than overwriting. To replace, explicitly
  delete or rename the existing destination first. This protects against
  accidental data loss.

- **Parent of destination must exist** for file moves — moving into a
  non-existent subdirectory fails. Create it with `filesystem-create-directory`
  (or move an entire directory to create the grouping). Note: some implementations
  treat "move dir A into existing dir B" as placing A *inside* B (`B/A`) rather
  than renaming — verify where things land when moving directories into
  directories.

- **Cross-device / cross-volume moves** (if allowed roots span filesystems) may
  be implemented as copy+delete and can be slower for large trees; partial-failure
  risk is higher there than same-volume renames.

- **Both source and destination must be within allowed directories.** You cannot
  move a file out of the permitted root or bring one in from outside it.
