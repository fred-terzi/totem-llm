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

## Design & Spec Documents

Planning and design documents for features live in subdirectories:

| Topic | Files | Status |
|-------|-------|--------|
| Per-user filesystem isolation | [per-user-filesystem/](per-user-filesystem/) | ✅ Implemented |
| File Explorer & Viewer | [file-explorer/](file-explorer/) | ✅ Implemented |
| Default-user inference options (incl. F16 mid-session switch in agent mode) | [default-user-inference-options/](default-user-inference-options/) | 🚧 In progress (Steps 0–5, F16 server + frontend complete; smoke matrix pending) |
| Implementation planning workflow (method/skill) | [implementation-planning/SKILL.md](implementation-planning/SKILL.md) | ✅ Active |
| Venice image generation agent skill | [venice-image-generate/](venice-image-generate/) | 🔲 Planned (spec + plan drafted) |
| Credit units (1 credit = $0.001 display unit over µ$ ledger) | [credit-units/](credit-units/) | 🔲 Drafted (spec + plan, not started) |
| Node 22 LTS ratification (runtime pin across Docker/CI/engines/docs) | [node22-ratification/](node22-ratification/) | ✅ Implemented |

Each topic directory holds a `requirement-spec.md` (what & why, threat model,
acceptance criteria) and an `implementation-plan.md` (step-by-step, against the
current code). See `AGENTS.md` §5 and
[implementation-planning/SKILL.md](implementation-planning/SKILL.md) for the
implementation-planning workflow.

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
