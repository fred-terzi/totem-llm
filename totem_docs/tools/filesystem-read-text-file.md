# filesystem-read-text-file

## Purpose

Read the contents of a single file from the local filesystem. Supports a wide
range of file types beyond plain text: PDFs, Word documents (`.docx`), audio
and video files (transcribed to text via speech-to-text), and more. Image
files are automatically attached so you can view and analyze them visually.

**When to use:** You know the exact file path and need its contents. This is
the primary "open a file" tool.

**When NOT to use:**
- You don't know where a file lives → use `filesystem-search-files` first.
- You need to read many files at once → use `filesystem-read-multiple-files`.
- You only need metadata (size, timestamps) without content → use
  `filesystem-get-file-info`.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ Yes | The path to the file. Can be absolute or relative to the allowed directory root. Must point to a **file**, not a directory. |
| `head` | `number` | Optional | If provided, returns only the first N lines of the file. Only works on text-based files (lines are undefined for binary/transcribed formats — behavior is implementation-dependent). Useful for quickly peeking at large logs or CSV headers. |
| `tail` | `number` | Optional | If provided, returns only the last N lines of the file. Same constraints as `head`. Handy for reading recent log entries without loading the entire file. |

> **Note:** `head` and `tail` are mutually exclusive in practice — if both are
> supplied, behavior is undefined (implementation may prefer one or error).

## Returns

A string containing the file's content:
- **Text files** (`*.txt`, `*.md`, `*.js`, `*.json`, etc.): raw text content.
- **PDF / DOCX**: extracted text (layout may not be perfectly preserved).
- **Audio/Video**: transcribed text (if a transcription backend is configured).
- **Images** (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`): the image is
  attached for visual analysis rather than returned as text. You will see it
  in your context and can describe or reason about what's shown.

On failure (file not found, permission denied, unsupported type), an error
message is returned describing the issue.

## Examples

```jsonc
// Read a config file
{ "path": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/server/.env.development" }

// Peek at the first 50 lines of a large log
{ "path": "~/totem-llm/logs/session.log", "head": 50 }

// Read only the last 20 lines (e.g., latest errors)
{ "path": "/var/log/app/error.log", "tail": 20 }

// Read a PDF report — extracted text returned
{ "path": "/home/fred-terzi/reports/q3-summary.pdf" }

// View an image — attached for visual analysis
{ "path": "/home/fred-terzi/screenshots/diagram.png" }
```

## Gotchas & Caveats

- **Allowed directories only.** The tool can only access files within the
  configured allowed directory (in this setup, the repo root and its
  subdirectories). Attempting to read outside will fail with a permission error.

- **Large files.** There is no explicit size limit documented, but extremely
  large files (hundreds of MB) may be truncated or slow. Use `head`/`tail` to
  sample instead of reading the full file.

- **Binary formats require backends.** PDF extraction and audio transcription
  depend on server-side libraries being installed. If they're missing, you'll
  get an error message rather than a silent empty string.

- **`head`/`tail` are line-based.** They count newline-delimited lines. For
  files without newlines (minified JS, single-line JSON), `head: 1` returns
  the entire file. Use byte-level tools (`terminal-access` with `head -c`) for
  precise control over binary or minified content.

- **Images are attached, not returned as text.** You cannot "parse" an image
  programmatically through this tool's return value — you analyze it visually
  in your context window. If you need OCR, use `terminal-access` with a tool
  like `tesseract`.
