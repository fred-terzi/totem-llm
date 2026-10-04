# filesystem-read-multiple-files

## Purpose

Read the contents of multiple files in a single call. This is the batch version
of `filesystem-read-text-file` — same supported file types (text, PDFs, Word
docs, audio/video transcription, images), but accepts an array of paths and
returns each file's content individually labeled with its path.

**When to use:** You already know the exact paths of several files you need
to read together — e.g., all config files in a set, multiple source files for
a code review, or a batch of documents for comparison.

**When NOT to use:**
- You don't know the file paths yet → use `filesystem-search-files` with
  `includeFileContents: true` to find **and** read them in one step (often more
  efficient than search + separate read).
- You only need one file → `filesystem-read-text-file`.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `paths` | `string[]` | ✅ Yes | Array of file paths to read. Each must be a string pointing to a valid file within the allowed directories. Can mix absolute and relative (to allowed root) paths in the same array. |

There are **no** `head`/`tail` parameters — this tool always returns full
content per file. If you need partial reads, use `filesystem-read-text-file`
per file instead.

## Returns

A collection of results, one entry per input path:
- Each entry includes the file's `path` and its extracted content (same format
  as `filesystem-read-text-file`).
- **Failed reads do not stop the operation.** If one path is invalid or unreadable,
  that entry reports the error while all other files are still returned. This makes
  it safe to batch-read a list where some files may be missing.

## Examples

```jsonc
// Read all three service entry points at once
{
  "paths": [
    "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/server/index.js",
    "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/collector/index.js",
    "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/lib/launcher.js"
  ]
}

// Read a config file and the env example together for comparison
{
  "paths": [
    "server/.env.development",
    ".env.example"
  ]
}
```

## Gotchas & Caveats

- **No partial reads.** Unlike `filesystem-read-text-file`, you cannot pass
  `head`/`tail`. For large files, prefer reading them individually with line
  limits.

- **Per-file error isolation is a feature, not a bug.** A single bad path won't
  abort the whole batch — but it also means you should scan each returned entry
  for errors rather than assuming every file read successfully.

- **Ordering.** Results correspond to the input `paths` array order, so you can
  correlate results back to requests positionally.

- **Same allowed-directory constraint** as all filesystem tools — paths outside
  the permitted root will fail (reported per-file, not globally).
