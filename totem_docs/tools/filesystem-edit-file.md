# filesystem-edit-file

## Purpose

Make **line-based, surgical edits** to an existing text file. Each edit finds
an exact block of lines (`oldText`) and replaces it with new content
(`newText`). Returns a git-style diff showing exactly what changed. This is the
preferred tool for modifying part of a file without rewriting the whole thing —
safer and more precise than read-then-overwrite via `filesystem-write-text-file`.

**When to use:** Changing specific lines/functions/sections in an existing file,
appending by matching an anchor, renaming identifiers within a bounded region.

**When NOT to use:**
- Creating a new file (it must already exist with content to match) →
  `filesystem-write-text-file`.
- You want a full rewrite of the file → `filesystem-write-text-file`.
- The change is across many scattered lines that are easier to regenerate whole.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ Yes | Path to an **existing** text file within the allowed directories. |
| `edits` | `object[]` | ✅ Yes | Array of edit operations applied in order. Each object has: <br>• `oldText` (string, required) — exact text to search for; must match the file content verbatim including whitespace and newlines.<br>• `newText` (string, required or empty) — replacement text. Use an empty string `""` to delete the matched block. |
| `dryRun` | `boolean` | Optional | If `true`, preview all changes as a git-style diff **without applying them** to disk. Great for verifying matches before committing edits. Defaults to `false`. |

### Edit object shape

```jsonc
{ "oldText": "const x = 1;", "newText": "const x = 2;" }   // replace
{ "oldText": "// TODO: remove\nlegacyCall();", "newText": "" } // delete block
{ "oldText": "</body>", "newText": "<script src=\"extra.js\"></script>\n</body>" } // insert before anchor
```

## Returns

A **git-style unified diff** showing the changes (added lines prefixed `+`,
removed `-`, context unchanged). With `dryRun: true` the same diff is returned
but nothing on disk changes. On failure, an error indicating which edit's
`oldText` was not found and where.

## Examples

```jsonc
// Bump a version string
{
  "path": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/package.json",
  "edits": [ { "oldText": "\"version\": \"1.0.0\"", "newText": "\"version\": \"1.1.0\"" } ]
}

// Preview (dry run) a multi-edit change before applying
{
  "path": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/server/index.js",
  "dryRun": true,
  "edits": [
    { "oldText": "// @ts-check", "newText": "" },
    { "oldText": "app.set('trust proxy', false)", "newText": "app.set('trust proxy', true)" }
  ]
}
```

## Gotchas & Caveats

- **`oldText` must match exactly.** Whitespace, indentation, and newline style
  (LF vs CRLF) all matter. If a match fails, re-read the file to copy the exact
  bytes rather than reconstructing from memory. This is the #1 cause of edit
  failures.

- **Ambiguous matches.** If `oldText` appears more than once in the file, which
  occurrence gets replaced depends on implementation (typically first match). To
  be safe, include enough surrounding context lines to make the block unique.

- **Edits apply sequentially.** Later edits see the result of earlier ones in
  the same call. If two edits touch overlapping regions, order matters and the
  second may fail because its `oldText` was already altered by the first.

- **File must exist.** Editing a non-existent path fails — this is not a create
  tool. For new files use `filesystem-write-text-file`.

- **Use `dryRun: true` to de-risk.** Run with dry run, inspect the diff for
  correctness (right lines, right scope), then re-run identically with
  `dryRun: false`. Cheap insurance against unintended replacements.
