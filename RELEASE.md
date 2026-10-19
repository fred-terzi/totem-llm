# Release Workflow — standard-version (CI-driven)

## Unreleased (pending next version bump)

- `feat(file-explorer)`: File Explorer & Viewer — read-only sandbox browser at `/settings/files` (dir listing, breadcrumb navigation, inline viewers for text/Markdown/image/PDF/audio/video, download for binary), powered by `GET /api/filesystem/list` + `GET /api/filesystem/read`
  - Lightweight Markdown renderer (`markdown-it` + `highlight.js` + `DOMPurify`) with Rendered/Raw toggle
  - Topbar `Files` button (all roles) in the user menu for direct access on mobile/desktop
  - Reuses existing `getFilesystemFor`/`validatePath` authz — zero new attack surface
- `feat(collector)`: markdown-mode web scraping with credit-saving truncation
- `feat(wallet)`: replace AppKit mobile login with MetaMask Connect (`@metamask/connect-evm`)
- `feat(beta)`: add beta feature profile and wire it into beta compose
- `fix(wallet)`: alias `mobile-wallet-protocol-core` to its ESM build (fixes `SessionStore.create` crash)
- `fix(wallet)`: correct `createEVMClient` config shape (hex chain IDs under `api.supportedNetworks`)
- `fix(chat)`: clear context usage bar after `/reset`
- `fix(chat-settings-menu)`: open text-size submenu to the right (Android cutoff fix)
- `chore(lint)`: remove unused imports/vars, fix useless escape, lower coverage threshold to 9%

---

Totem LLM uses [standard-version](https://github.com/conventional-software/standard-version) to manage versioning, git tags, and changelog generation from conventional commit messages.

The release is **automated by GitHub Actions** — no manual steps required.

## How It Works

### Trigger

When `dev-totem` is merged into `main-totem` via PR, the `release.yml` workflow fires automatically.

### What the workflow does

1. Checks out `main-totem` with full history (`fetch-depth: 0`)
2. Runs `yarn standard-version` — this:
   - Inspects conventional commits since the last tag
   - Bumps `package.json` version (major / minor / patch)
   - Generates/updates `CHANGELOG.md`
   - Creates the git tag (`v0.X.Y`)
   - Commits with `chore(release): vX.Y.Z [skip ci]`
3. If no release-worthy commits are found, the run is a **no-op** (exits cleanly, no commit or tag created)
4. Pushes the release commit + tags to GitHub

> The `[skip ci]` in the commit message prevents the workflow from re-triggering on its own output.

## Version Bump Rules (SemVer)

| Commit type              | Bump   | Example          |
|--------------------------|--------|------------------|
| `feat:`                  | minor  | `0.19.0 → 0.20.0` |
| `fix:` / `perf:` / `revert:` | patch  | `0.19.0 → 0.19.1` |
| Breaking (`feat!:`, `BREAKING CHANGE`) | major | `0.19.0 → 1.0.0` |

## After the Release — Sync dev-totem back

> **Why:** The version bump commit is created on `main-totem` by the GitHub Action. If `dev-totem` is never fast-forwarded, its `package.json` version field drifts behind by one release per cycle. The next PR then hits a `package.json` version conflict and the next `standard-version` bump can collide with an already-published tag. Merging main back keeps both branches on the same version.

```bash
git checkout dev-totem
git pull origin dev-totem
git merge main-totem   # fast-forward; no merge commit
git push
git diff --stat dev-totem main-totem   # must be empty
```

## Publish to npm (if applicable)

```bash
npm publish
```

> This step is still manual. If you want it automated, add an `npm publish` step to `release.yml` guarded by `if: github.event_name == 'push'` and an `NPM_TOKEN` secret.

## Files Generated/Modified

| File              | Created by        | Description                          |
|-------------------|-------------------|--------------------------------------|
| `package.json` version | standard-version | Updated version number               |
| `CHANGELOG.md`    | standard-version  | Auto-generated changelog per section |

## Config Files

| File | Purpose |
|---|---|
| `.versionrc.cjs` | standard-version config — commit type → changelog section mapping |
| `.github/workflows/release.yml` | GitHub Action that runs `standard-version` + pushes on merge to `main-totem` |

## Troubleshooting

**Workflow skipped the release**

Check that the merged commits since the last tag include at least one `feat:`, `fix:`, or `perf:` commit. `chore:`, `docs:`, `test:` commits do not trigger a version bump.

**Tag collision**

If `standard-version` fails with "tag already exists", the tag was created locally in a previous manual run. Delete it:

```bash
git tag -d v0.X.Y
git push origin :refs/tags/v0.X.Y
# Re-run the workflow: push an empty commit to main-totem
git checkout main-totem
git commit --allow-empty -m "chore: retry release"
git push
```

**`fetch-depth: 0` required**

The workflow checks out with full history. If you change this, `standard-version` will not be able to find the last tag and will default to `0.1.0`.
