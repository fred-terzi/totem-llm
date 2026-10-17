# Release Workflow — standard-version

## Unreleased (pending next version bump)

- `feat(file-explorer)`: File Explorer & Viewer — read-only sandbox browser at `/settings/files` (dir listing, breadcrumb navigation, inline viewers for text/Markdown/image/PDF/audio/video, download for binary), powered by `GET /api/filesystem/list` + `GET /api/filesystem/read`
  - Lightweight Markdown renderer (`markdown-it` + `highlight.js` + `DOMPurify`) with Rendered/Raw toggle
  - Topbar `Files` button (all roles) in the user menu for direct access on mobile/desktop
  - Reuses existing `getFilesystemFor`/`validatePath` authz — zero new attack surface

---

Totem LLM uses [standard-version](https://github.com/conventional-software/standard-version) to manage versioning, git tags, and changelog generation from conventional commit messages.

## Prerequisites

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.)
- `commitlint` installed (optional but recommended)

## Setup (one-time)

```bash
yarn add --dev standard-version @commitlint/cli @commitlint/config-conventional
echo "* commitlint" >> .gitignore
```

## How to Release

### 1. Merge your feature PR into main-totem

Ensure all feature commits are squashed or merged so the branch is clean.

### 2. Run standard-version

```bash
# Preview what would be generated (no changes made):
npx standard-version --dry-run

# Patch release (fixes only, e.g., 0.11.1 → 0.11.2):
npx standard-version --release-as patch

# Minor release (new features, backward-compatible, e.g., 0.11.1 → 0.12.0):
npx standard-version --release-as minor

# Major release (breaking changes, e.g., 0.11.1 → 1.0.0):
npx standard-version --release-as major
```

This will:
1. Bump `package.json` version
2. Generate/append to `CHANGELOG.md`
3. Create/update `.versionrc.cjs` config (if not present)
4. Auto-commit with the version message (`chore(release): v0.12.0`)
5. Create a git tag `v0.12.0`

### 3. Push to GitHub

```bash
git push && git push --tags
```

### 4. Publish to npm (if applicable)

```bash
npm publish
```

### 5. Sync dev-totem back with main-totem (REQUIRED)

> **Why:** The version bump (step 2) is committed *only* on `main-totem`. If it is never merged back, `dev-totem`'s `package.json` version field drifts behind by one release per cycle. The next PR then hits a `package.json` version conflict and the next `standard-version` bump can collide with an already-published tag. Merging main back keeps both branches on the same version so the next release is clean.

```bash
git checkout dev-totem
git merge main-totem   # usually a fast-forward; no merge commit needed
git push
```

After this, `dev-totem` and `main-totem` point at the same commit and share the latest published version. Verify with:

```bash
git diff --stat dev-totem main-totem   # should be empty
```

## Version Bump Rules (SemVer)

| Commit type              | Bump   | Example          |
|--------------------------|--------|------------------|
| `feat:`                  | minor  | `0.11.1 → 0.12.0` |
| `fix:`                   | patch  | `0.11.1 → 0.11.2` |
| `perf:`                  | patch  | `0.11.1 → 0.11.2` |
| Breaking (`feat!:`, `breaking:`) | major   | `0.11.1 → 1.0.0` |

## Post-bump Hook

`.versionrc.cjs` includes a `postbump` script (`scripts/postversion.mjs`) that auto-commits the bump and pushes to origin + tags when run locally in an attached terminal session.

If push fails (detached HEAD, no network), the version is still bumped locally — the tag creation is manual:

```bash
git tag -a v0.X.Y -m "v0.X.Y release"
git push --tags
```

## Files Generated/Modified

| File              | Created by        | Description                          |
|-------------------|-------------------|--------------------------------------|
| `package.json` version | standard-version | Updated version number               |
| `CHANGELOG.md`    | standard-version  | Auto-generated changelog per section |
| `v*.md`           | standard-version  | Release artifacts (optional)         |
