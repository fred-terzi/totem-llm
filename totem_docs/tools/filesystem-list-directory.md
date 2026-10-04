# filesystem-list-directory

## Purpose

Get a detailed listing of all files and subdirectories directly inside a given
directory (one level deep, non-recursive). Results clearly distinguish entries
with `[FILE]` and `[DIR]` prefixes. Optionally includes file sizes and can sort
by name or size. This is the essential tool for understanding what's in a
directory before deciding which files to read, search within, or manipulate.

**When to use:** Exploring directory structure, finding candidates to operate on,
checking whether a path exists as a file vs. directory, discovering file sizes
before reading large ones.

**When NOT to use:**
- You need recursive listing of all nested files → `terminal-access` with `find`.
- You want to find files by name pattern or content across many directories →
  `filesystem-search-files`.
- You already know the exact path and just need its content → a read tool.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ Yes | The directory to list. Must point to an existing **directory** (listing a file path fails). Within allowed directories. |
| `includeSizes` | `boolean` | Optional | If `true`, appends each entry's size in bytes. Useful for spotting large files before reading them. Defaults to off. |
| `sortBy` | `string` | Optional | Sort order for the listing: `"name"` (alphabetical) or `"size"`. Defaults to name. When sorting by size, typically largest-first is most useful — confirm implementation ordering if it matters. |

## Returns

A list of entries, one line each, formatted like:
```
[DIR]  server
[FILE] package.json        (12.4 KB)   ← size shown only if includeSizes=true
[FILE] README.md           (3.1 KB)
```
- `[DIR]` prefix = subdirectory; `[FILE]` prefix = regular file.
- Sizes appear inline when `includeSizes: true`.

On failure (path not found, path is a file not a directory, permission denied),
an error message is returned.

## Examples

```jsonc
// Basic listing of the repo root
{ "path": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm" }

// Listing with sizes to spot large files
{ "path": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/server", "includeSizes": true }

// Sort by size (find the heaviest entries)
{ "path": "~/totem-llm/storage", "includeSizes": true, "sortBy": "size" }
```

## Gotchas & Caveats

- **One level deep only.** This lists immediate children, not a recursive tree.
  To see nested contents, call it again on each subdirectory of interest (or use
  `terminal-access` with `find /path -type f`).

- **Hidden/dotfiles behavior varies by implementation.** Confirm whether entries
  like `.git`, `.env` are included when you need them. If dotfiles seem missing
  from a listing, verify with `terminal-access` (`ls -la`) — that's the reliable
  way to enumerate hidden files.

- **Not recursive → not for "find all files matching X".** For pattern-based or
  content-based discovery across a tree, use `filesystem-search-files`.
