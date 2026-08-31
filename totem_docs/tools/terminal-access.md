# terminal-access

## Purpose

Execute shell commands with working-directory tracking and safety guards. Runs
commands through a **login bash** (so `~/.bashrc` / `~/.profile` are loaded).
The current working directory **persists between calls** — you can `cd` once
and subsequent commands run from there. This is the tool for anything that
requires executing a program: running tests, builds, git operations, installing
packages, invoking scripts, and any task no dedicated filesystem tool covers.

**When to use:** `yarn test`, `git status/diff/commit`, `npm install`, build
steps, running node/python scripts, system inspection (`ls -la`, `du`, `find`),
anything that needs a real process.

**When NOT to use:** Prefer dedicated filesystem tools for simple file ops —
reading, writing, listing, searching, moving, copying files are faster and safer
through their specific tools. Reserve the terminal for execution and for things
those tools can't do (permissions, symlinks, git, network via `curl`, etc.).

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `command` | `string` | ✅ Yes | The shell command to execute. Use absolute paths or prefix with `cd /path && cmd` for explicit navigation. Commands run in a login bash; complex one-liners, pipes, and `&&`/`;` chains are supported since it's a real shell. |

## Returns

The combined **stdout + stderr** of the command (implementation-dependent
separation), typically with an exit-code indicator. Non-zero exit codes surface
in the output so you can detect failures. Long-running or interactive commands
should be avoided — see caveats below on timeouts and interactivity.

## Examples

```jsonc
// Run tests from a specific directory
{ "command": "cd /home/fred-terzi/totem-llm/totemllm-fs/totem-llm && yarn test" }

// Git workflow — working dir persists, so cd once then chain
{ "command": "cd /home/fred-terzi/totem-llm/totemllm-fs/totem-llm && git status && git diff --stat" }

// Install a dependency
{ "command": "yarn add some-package -W" }

// System inspection
{ "command": "ls -la ~/totem-llm/storage/" }

// Recursively find files (no dedicated tool for recursive listing)
{ "command": "find . -name '*.env*' -not -path './node_modules/*'" }
```

## Gotchas & Caveats

- **Working directory persists; environment variables do NOT.** `cd` carries over
  to the next call, but `export FOO=bar` does **not** persist — each call is a
  fresh login shell that reloads rc files. Set env inline per command:
  `FOO=bar mycmd`. Don't assume state from one call survives to the next except
  for the cwd (and on-disk effects like created files or git status).

- **Prefer absolute paths / explicit `cd … && cmd`.** Because cwd persistence is
  a footgun across long sessions, anchoring each important command with an
  absolute path removes ambiguity.

- **Destructive commands need care.** This tool can run anything the shell user
  can — including `rm -rf`, force-pushes, and package installs that mutate the
  environment. In agent mode, dangerous patterns are gated by per-command
  approval (see AGENTS.md "Terminal access" safety layers). Still: confirm intent
  before issuing irreversible commands; take a backup or verify with a dry run
  first where possible (`git diff`, `rm -n` dry lists, etc.).

- **Avoid interactive / long-running commands.** Prompts that wait for input
  (sudo password, `yarn` prompts, `ssh`) will hang until timeout. Prefer
  non-interactive flags (`--yes`, `-y`, `CI=true`). Very long builds should be
  run in the background with logging if the environment supports it, since there's
  a per-command timeout that kills the process group and truncates output.

- **Output can be truncated.** Extremely verbose commands (full test suites, big
  `cat`s) may have their tail cut off. Pipe through filters (`| head`, `| grep`)
  or redirect to a file and read selectively with the filesystem tools.
