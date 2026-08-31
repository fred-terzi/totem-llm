# filesystem-search-files

## Purpose

Search for files by **name** or by **content**. This is the tool to reach for
first whenever you need to find a file but don't know its exact location. Two
modes: `glob` matches against file paths/names (like shell glob patterns), and
`content` searches inside files using regex/text (like `grep`). A powerful
option, `includeFileContents`, reads the full contents of matching files in the
same call — so you can find **and** read in one step instead of searching then
reading separately.

**When to use:** "Where is the file called X?", "Which files reference this
function/constant/string?", locating configs, finding where a symbol is defined
or used across the codebase.

**When NOT to use:**
- You already know the exact path → read it directly (`filesystem-read-text-file`).
- You want a directory's immediate children only → `filesystem-list-directory`.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | `string` | ✅ Yes | **Glob mode:** pattern to match file paths (e.g., `*.csv`, `config`, `**/*.test.js`). Simple patterns like `sales.csv` automatically match files containing that string anywhere in the path. **Content mode:** the text or regex pattern to search for inside file contents. |
| `mode` | `string` | Optional | Search mode: `"glob"` (default) matches file paths/names; `"content"` searches inside file bodies using regex. |
| `filePattern` | `string` | Optional | **Content mode only:** a glob to filter *which files* are searched (e.g., `*.js`, `*.{ts,tsx}`). Narrows the content search to relevant file types and speeds it up. |
| `excludePatterns` | `string[]` | Optional | Patterns to skip during the search (e.g., `node_modules`, `.git`, `*.log`). Highly recommended for large repos to avoid noise and slow scans of vendored/generated dirs. |
| `caseSensitive` | `boolean` | Optional | **Content mode:** whether matching is case-sensitive. Defaults to implementation-dependent (often false); set explicitly when it matters. |
| `maxResults` | `number` | Optional | Maximum number of matches to return. Prevents huge result sets from blowing up context; raise it if you suspect truncation. |
| `includeFileContents` | `boolean` | Optional | If `true`, reads and returns the **full contents** of matching files alongside their paths (limited by `maxFilesToRead`). Ideal when you need to analyze matches, not just locate them — collapses search+read into one call. |
| `maxFilesToRead` | `number` | Optional | When `includeFileContents: true`, the maximum number of files whose contents are actually read/returned. Cap this on broad searches to bound context usage. |

## Returns

- **Glob mode:** a list of matching file paths.
- **Content mode:** matches with file path and matched line(s)/context (implementation-dependent detail).
- With `includeFileContents: true`: each match also carries the full file content, so you can immediately work from it without a follow-up read.

On failure or no matches, an empty list or a "no results" message is returned.

## Examples

```jsonc
// Find all CSV files anywhere (glob mode)
{ "pattern": "*.csv", "mode": "glob" }

// Find where 'verifyPayloadIntegrity' is referenced in JS/TS files
{
  "pattern": "verifyPayloadIntegrity",
  "mode": "content",
  "filePattern": "*.{js,ts}",
  "excludePatterns": ["node_modules"]
}

// Find AND read all test files matching a pattern in one shot
{
  "pattern": "*.test.js",
  "mode": "glob",
  "includeFileContents": true,
  "maxFilesToRead": 10,
  "excludePatterns": ["node_modules"]
}

// Case-insensitive content search for a constant
{ "pattern": "STORAGE_DIR", "mode": "content", "caseSensitive": false }
```

## Gotchas & Caveats

- **Always exclude `node_modules` (and `.git`) on large repos.** Without
  `excludePatterns`, both modes can scan millions of vendored files, returning
  noise and timing out. This is the single most common mistake with this tool.

- **Glob simplicity:** a bare filename pattern like `sales.csv` matches any path
  *containing* that string — so it's a "find by name fragment," not an exact
  full-path match. Use more specific patterns (`server/data/sales.csv`) when you
  want precision.

- **Content mode is regex-capable.** Be careful with special characters; quote
  or escape them as needed depending on implementation. For literal strings,
  keep the pattern plain to avoid unintended regex interpretation.

- **`includeFileContents` bounds your context.** Each read file adds its full
  content to the response. On broad searches this can be enormous — always pair
  it with `maxFilesToRead` (and `filePattern`) so you don't pull in dozens of
  large files you didn't intend to analyze.

- **Results may be capped by `maxResults`.** If the returned count equals your
  `maxResults`, assume there are more matches; tighten the pattern or raise the cap.
