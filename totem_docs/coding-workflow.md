# Totem LLM — Coding Workflow

Recommended workflow for making code changes to the Totem LLM repo (or any project) using the agent's built-in tools. The key principle: **keep your working copy inside `totemllm-fs/`** so all filesystem tools can reach it directly without permission issues or path gymnastics.

## Why a Local Repo Inside `totemllm-fs`?

The agent's file system tools (`filesystem-edit-file`, `filesystem-write-text-file`,
`filesystem-search-files`, etc.) operate within an allowed directory tree rooted at:

```
/home/fred-terzi/totem-llm/totemllm-fs/
```

Anything under this path is readable, writable, and editable with zero friction.
The `terminal-access` tool can also `cd` into any subdirectory of the same tree to run commands (builds, tests, git ops).

If your repo lives **outside** this tree (e.g., a fresh clone in `~/projects/`), you'll hit permission errors on every file tool call and have to fall back to raw shell commands for edits — which is less safe, harder to review, and doesn't produce diffs.

## Setup

```bash
# From the terminal-access tool:
cd /home/fred-terzi/totem-llm/totemllm-fs

# Clone or move your project here (example):
git clone <remote-url> my-project
# OR if you already have it elsewhere:
cp -r ~/projects/my-project ./my-project
```

Now the full path is `/home/fred-terzi/totem-llm/totemllm-fs/my-project` and every tool works natively.

## The Workflow at a Glance

| Step | Tool(s) Used | Purpose |
|------|-------------|---------|
| 1. Orient | `filesystem-list-directory`, `filesystem-search-files` | Find relevant files, understand structure |
| 2. Read | `filesystem-read-text-file`, `filesystem-read-multiple-files` | Understand current code before changing it |
| 3. Plan | *(reasoning)* | Decide which lines/functions to change and how |
| 4. Edit (dry run) | `filesystem-edit-file` with `dryRun: true` | Preview the diff, verify correctness |
| 5. Edit (apply) | `filesystem-edit-file` with `dryRun: false` | Commit the change to disk |
| 6. Verify | `terminal-access` (`yarn test`, `yarn lint`, etc.) | Run tests/lint/builds to confirm nothing broke |
| 7. Iterate | Repeat 3–6 as needed | Fix issues, refine changes |
| 8. Commit | `terminal-access` (git commands) | Stage, commit, push when ready |

## Detailed Tool Selection Guide

### Finding & Reading Code

- **`filesystem-search-files`** (glob mode): Find files by name/pattern. Use this *first* when you don't know where something lives.
  ```jsonc
  { "pattern": "*.test.js", "mode": "glob" }
  { "pattern": "workspace_threads", "mode": "content" }
  ```

- **`filesystem-list-directory`**: See what's in a directory. Good for getting your bearings before diving into specific files.

- **`filesystem-read-text-file`**: Read one file. Use `head`/`tail` params to limit output on large files.
  ```jsonc
  { "path": "/home/fred-terzi/totem-llm/totemllm-fs/my-project/server/index.js", "head": 50 }
  ```

- **`filesystem-read-multiple-files`**: Read several known files in one call. Useful when you need to see how modules interact.

### Making Edits

**Prefer `filesystem-edit-file` over full rewrites.** It produces a diff, is surgical, and fails loudly if your match doesn't line up.

- **For targeted changes** (change a function body, add an import, rename a variable in one place):
  ```jsonc
  {
    "path": ".../server/utils/chats/chat.js",
    "dryRun": true,
    "edits": [
      { "oldText": "const topN = 5;", "newText": "const topN = 10;" }
    ]
  }
  ```

- **For new files** (new module, test file, config): use `filesystem-write-text-file`.
  ```jsonc
  { "path": ".../server/__tests__/utils/newFeature.test.js", "content": "// your code here" }
  ```

- **For directory structure changes**: `filesystem-create-directory`, `filesystem-move-file`, `filesystem-copy-file`.

**Rule of thumb:** If you can describe the change as "replace this block with that block," use `edit-file`. If you're writing a file from scratch, use `write-text-file`.

### Running Commands (Terminal)

Use `terminal-access` for anything that requires executing a program:

```bash
# Navigate and run tests
cd /home/fred-terzi/totem-llm/totemllm-fs/my-project && yarn test

# Lint + format
cd /home/fred-terzi/totem-llm/totemllm-fs/my-project && yarn lint

# Git operations
cd /home/fred-terzi/totem-llm/totemllm-fs/my-project && git status
cd /home/fred-terzi/totem-llm/totemllm-fs/my-project && git diff --stat
cd /home/fred-terzi/totem-llm/totemllm-fs/my-project && git add -p

# Install dependencies after adding new packages to package.json
cd /home/fred-terzi/totem-llm/totemllm-fs/my-project && yarn install
```

**Note:** The working directory persists between terminal calls within a session, but environment variables and shell state do not. Always use `cd /absolute/path && command` for safety.

## Build Order (Totem LLM Repo Specifically)

When editing the main Totem LLM repo at `/home/fred-terzi/totem-llm/totemllm-fs/totem-llm/`:

```bash
# After making code changes, always run in this order:
cd /home/fred-terzi/totem-llm/totemllm-fs/totem-llm

# 1. Lint (mutates files — auto-fixes formatting)
yarn lint

# 2. Test (verify nothing broke after lint mutations)
yarn test

# 3. Git: review what changed, commit
git diff --stat
git add -A
git commit -m "feat(scope): description of change"
```

## Gotchas

- **`oldText` must match byte-for-byte.** If an edit fails with "not found," re-read the file and copy the exact text rather than reconstructing it from memory. Whitespace and indentation matter.

- **CJS vs ESM boundary.** Server files use `require()`, root/lib/frontend use `import`. Don't accidentally introduce a wrong module system when editing across the `server/` boundary.

- **No `yarn.lock` in git.** It's in `.gitignore`. After adding dependencies to `package.json`, run `yarn install` locally but don't commit the lockfile.

- **Frontend feature flags are baked at build time.** If you're working on profile-specific UI (e.g., terminal access, agent mode), make sure `TOTEM_BUILD_PROFILE=source` is set when running dev servers, or those features won't render even if server-side logic is correct.

- **Terminal working directory persists** between calls in a session but NOT between sessions. Always use absolute paths with `cd /path && cmd` to avoid confusion.

## Checklist Before Committing

- [ ] Edits applied (not just dry-run)
- [ ] `yarn lint` passes (or at minimum doesn't introduce new errors)
- [ ] `yarn test` passes
- [ ] No accidental changes outside the intended scope (`git diff --stat`)
- [ ] Commit message follows Conventional Commits format: `type(scope): description`
