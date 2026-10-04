# filesystem-write-text-file

## Purpose

Create a new text file or **completely overwrite** an existing one with new
content. This is the primary "write to disk" tool for plain text and code
files. It uses proper UTF-8 encoding.

⚠️ **Destructive:** If the target path already exists, its entire contents are
replaced with no backup and no confirmation. Always read a file first (or use
`filesystem-edit-file` for targeted changes) before overwriting it.

**When to use:** Creating new files from scratch, or intentionally replacing an
existing file's full content (e.g., regenerating a config, rewriting a doc).

**When NOT to use:**
- You want to modify only part of an existing file → `filesystem-edit-file`.
- You're creating a binary/document format (`PDF`, `DOCX`, `XLSX`, `PPTX`) →
  this tool writes plain text/UTF-8 only; use the appropriate document-creation
  capability instead (see `create-files` agent plugin for office formats).

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ Yes | The destination path where the file should be created or overwritten. Parent directories **must already exist** — this tool does not create intermediate directories. If a parent dir is missing, the write fails. Create dirs first with `filesystem-create-directory`. |
| `content` | `string` | ✅ Yes | The full content to write. Written verbatim (no trailing-newline normalization beyond what you supply). Empty string produces an empty file. |

## Returns

A confirmation message on success (typically including the path and bytes
written, or a generic "Successfully wrote" note). On failure, an error message
describing the cause (missing parent dir, permission denied, etc.).

## Examples

```jsonc
// Create a brand-new markdown file in an existing directory
{
  "path": "/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/totem_docs/README.md",
  "content": "# Totem LLM — Tool Call Reference\n\nIntro text…"
}

// Overwrite an existing file completely (DANGEROUS if unintended)
{
  "path": "/home/fred-terzi/config/app.json",
  "content": "{\"theme\":\"dark\",\"verbose\":true}"
}
```

## Gotchas & Caveats

- **No automatic parent-directory creation.** `totem_docs/tools/foo.md` will
  fail if `tools/` doesn't exist. Run `filesystem-create-directory` first for
  nested paths. (Creating the directory is idempotent and safe.)

- **Overwrite is total and irreversible at this layer.** There's no undo, no
  `.bak`, no diff prompt. If you need to preserve prior content or make a small
  change, use `filesystem-edit-file` instead of reading + rewriting by hand.

- **Text only / UTF-8.** Binary data (images, compiled artifacts, office docs)
  will be corrupted if written as text here. For `.docx`, `.pptx`, `.xlsx`,
  `.pdf`, etc., use a dedicated document generator, not this tool.

- **Trailing newline.** The content is written exactly as given. If you want a
  trailing newline at end-of-file, include `\n` in your `content`. Many linters
  (Prettier) expect one — be deliberate about it for files under format checks.

- **Allowed directories only.** Writes outside the permitted root are rejected.
