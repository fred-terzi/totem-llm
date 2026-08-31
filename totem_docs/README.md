# Totem LLM — Tool Call Reference

This directory contains detailed documentation for every tool available to the
Totem LLM agent at runtime. Each file in `tools/` documents one tool: its
purpose, parameters, return format, usage examples, and gotchas.

## Index

| # | Tool | File | Category |
|---|------|------|----------|
| 1 | `web-scraping` | [tools/web-scraping.md](tools/web-scraping.md) | Web / Read-only |
| 2 | `filesystem-read-text-file` | [tools/filesystem-read-text-file.md](tools/filesystem-read-text-file.md) | Filesystem / Read-only |
| 3 | `filesystem-read-multiple-files` | [tools/filesystem-read-multiple-files.md](tools/filesystem-read-multiple-files.md) | Filesystem / Read-only |
| 4 | `filesystem-write-text-file` | [tools/filesystem-write-text-file.md](tools/filesystem-write-text-file.md) | Filesystem / Write |
| 5 | `filesystem-edit-file` | [tools/filesystem-edit-file.md](tools/filesystem-edit-file.md) | Filesystem / Edit |
| 6 | `filesystem-create-directory` | [tools/filesystem-create-directory.md](tools/filesystem-create-directory.md) | Filesystem / Create |
| 7 | `filesystem-list-directory` | [tools/filesystem-list-directory.md](tools/filesystem-list-directory.md) | Filesystem / Read-only |
| 8 | `filesystem-move-file` | [tools/filesystem-move-file.md](tools/filesystem-move-file.md) | Filesystem / Move |
| 9 | `filesystem-copy-file` | [tools/filesystem-copy-file.md](tools/filesystem-copy-file.md) | Filesystem / Copy |
| 10 | `filesystem-search-files` | [tools/filesystem-search-files.md](tools/filesystem-search-files.md) | Filesystem / Search |
| 11 | `filesystem-get-file-info` | [tools/filesystem-get-file-info.md](tools/filesystem-get-file-info.md) | Filesystem / Read-only (metadata) |
| 12 | `terminal-access` | [tools/terminal-access.md](tools/terminal-access.md) | Shell Execution |
| 13 | `web-browsing` | [tools/web-browsing.md](tools/web-browsing.md) | Web / Search |

## Conventions Used in These Docs

Each tool document follows this structure:

```
# <tool-name>

## Purpose
What the tool does and when to reach for it.

## Parameters
Table of every parameter with type, required/optional, description, defaults.

## Returns
Description of the return value shape (or note if void).

## Examples
Concrete invocations showing common patterns.

## Gotchas & Caveats
Edge cases, limitations, common mistakes.
```
