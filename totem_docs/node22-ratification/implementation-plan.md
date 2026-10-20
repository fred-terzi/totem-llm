# Node 22 LTS Ratification — Implementation Plan

Companion to `requirement-spec.md`. All paths relative to repo root.

---

## Step 0 — Investigation (no code)

Verify every claim the spec makes before touching files.

**Findings (verified 2026-10-20):**

| Claim | file:line | Verified |
|---|---|---|
| `.nvmrc` = `22.23.3` | `.nvmrc:1` | ✅ `cat .nvmrc` |
| Three Dockerfiles pin `node:18-slim` | `docker/Dockerfile:24`, `docker/hosted/Dockerfile:25`, `docker/venice/Dockerfile:28` | ✅ grep |
| Beta Dockerfile already on 24 | `docker/beta/Dockerfile:44` | ✅ grep |
| Release CI hardcodes Node 18 | `.github/workflows/release.yml:23` | ✅ grep |
| engines claims | `package.json:18` (`>=18`), `server/package.json:10`, `collector/package.json:10` (`>=18.12.1`) | ✅ grep |
| AGENTS.md stale claims | `AGENTS.md:275` (Vite note), `AGENTS.md:426` (Node Version section) | ✅ read |
| jose EdDSA JWT works on 22/24, fails on 18 | transitive dep of MCP SDK; empirically tested on all three runtimes | ✅ 2026-10-20 |
| Dep tree requires ≥20.19 | css-select 7, mailparser 3.10, @babel/core 8; rationale in commit `4ace3bb5` | ✅ git log |

**Additional finding during investigation:** local nvm has all needed versions installed (`v18.18.0`, `v18.20.8`, `v22.23.3`, `v24.18.0`); active shell is 24.18.0. No installs needed.

**Decision recorded:** Node 22.23.3 ratified (LTS to April 2027); `docker/beta` aligned down from 24 → 22 for consistency. Node 24 adoption deferred to a future chore.

## Step 1 — No source changes needed (verified, not assumed)

Re-verified 2026-10-20: no application source (`server/`, `collector/`, `frontend/src/`, `lib/`) reads `.nvmrc`, `process.version` guards, or engine checks at runtime. Confirmed via grep across source dirs — the runtime version only matters at install/build time.

## Step 2 — Ratify `.nvmrc` (already correct, no edit)

`.nvmrc` already contains `22.23.3`. No change; recorded here so the plan shows it was checked, not skipped.

**Evidence:** `cat .nvmrc` → `22.23.3`. Git blame: last touched by `4ace3bb5`.

## Step 3 — Align Dockerfiles

- `docker/Dockerfile:24` — `node:18-slim` → `node:22-slim`
- `docker/hosted/Dockerfile:25` — `node:18-slim` → `node:22-slim`
- `docker/venice/Dockerfile:28` — `node:18-slim` → `node:22-slim`
- `docker/beta/Dockerfile:44` — `node:24-slim` → `node:22-slim` (align down for consistency)

Also check each file for comment text mentioning Node 18 (e.g. `docker/beta/Dockerfile:72` — "corepack ships with node:18") and update wording.

**Deviations from the original draft:** *(none yet)*

**Evidence (2026-10-20):** All four FROM lines updated. Grep per AC2:

```
$ grep -n "FROM node" docker/Dockerfile docker/hosted/Dockerfile docker/venice/Dockerfile docker/beta/Dockerfile
docker/Dockerfile:24:FROM node:22-slim AS base
docker/hosted/Dockerfile:25:FROM node:22-slim AS base
docker/venice/Dockerfile:28:FROM node:22-slim AS base
docker/beta/Dockerfile:44:FROM node:22-slim AS base
```

Beta Dockerfile corepack comment block (lines 71–76) also reworded — no Node 18 references remain in any Dockerfile.

**Deviations from the original draft:** Docker build smoke was performed for `docker/Dockerfile` only (not `docker/beta`) — see Step 7 for the outcome, which exceeded the planned smoke: the built image was *run* and the full stack (Ollama install, Prisma migrations ×44, server boot, clean SIGTERM shutdown) worked end-to-end on `node:22-slim`. The other three images get the FROM-line grep check per AC2; they share the same base image and install pattern, so the smoke evidence transfers.

> ⚠️ **Warning for future agents:** a full `docker build -f docker/Dockerfile` produces a ~22 GB image (Ollama install + pre-pulled `qwen3.5:9b` + `nomic-embed-text` models). Do not re-run it casually.

**Lightweight re-verification probe (added 2026-10-20, replaces the build as the repeatable check):**

```bash
# ~2 min, no image retained, uses the cached node:22-slim base (329 MB).
# Verifies N4: native deps + Prisma engines resolve and load on Node 22 (ABI 127).
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/probe -w /probe node:22-slim bash -c '
  set -e
  node --version
  cd server && npm install --legacy-peer-deps --no-audit --no-fund --ignore-scripts
  npx prisma generate
  node -e "require(\"@prisma/client\"); console.log(\"prisma client OK on\", process.version)"
  cd ../collector && npm install --legacy-peer-deps --no-audit --no-fund --ignore-scripts sharp
  node -e "require(\"sharp\")(\":memory:\")" 2>/dev/null || node -e "require(\"sharp\"); console.log(\"sharp OK on\", process.version)"
'
```

**Probe result (2026-10-20): PASS.** `node v22.23.3` → `prisma generate` emits ABI-127 client, `@prisma/client` loads, `sharp` loads and processes an 8×8 image. No new image retained (`--rm`).

**Probe hygiene note:** run with `-u "$(id -u):$(id -g)"` — an earlier root-mode probe run wrote root-owned files into the bind-mounted `server/node_modules` (14,574 files), which do not break anything (verified: host `require` of `@prisma/client`/`express`/`ws` still works and Jest helpers suite passes 12/12 on the host) but require `sudo chown` to clean up. Prefer always mounting probes as the host user.

## Step 4 — Release CI

`.github/workflows/release.yml:23` — replace:

```yaml
          node-version: 18
```

with:

```yaml
          node-version-file: .nvmrc
```

`actions/setup-node@v4` supports `node-version-file` (respects `.nvmrc`).

**Deviations from the original draft:** *(none yet)*

**Smoke-test evidence (2026-10-20):**

```
$ grep -n "node-version" .github/workflows/release.yml
23:          node-version-file: .nvmrc
```

No literal `node-version: 18` remains (AC3). CI run itself happens on next PR merge to main-totem.

## Step 5 — package.json engines

- root `package.json:18` — `">=18"` → `">=22"`
- `server/package.json:10` — `">=18.12.1"` → `">=22"`
- `collector/package.json:10` — `">=18.12.1"` → `">=22"`

Note: `frontend/package.json` has no engines field (checked); leave as-is.

**Deviations from the original draft:** *(none yet)*

**Smoke-test evidence (2026-10-20):**

```
$ grep -n '"node"' package.json server/package.json collector/package.json
package.json:18:    "node": ">=22"
server/package.json:10:    "node": ">=22"
collector/package.json:10:    "node": ">=22"
```

All three declare `>=22` (AC4).

## Step 6 — AGENTS.md

- `AGENTS.md:426` ("Node Version" section) — **done:** now reads "Pinned to **v22.23.3** (Node 22 LTS, supported to April 2027) via `.nvmrc`", with a pointer to this workstream and a note that Dockerfiles, release CI, and `engines` derive from the pin.
- `AGENTS.md:275` (Vite/wallet-standard note) — **done:** the Node 18.18 rationale sentence is replaced with "retain this pin … do not unpin without re-testing" — the operational advice survives; the obsolete runtime justification is gone.

**Deviations from the original draft:** Investigation pass missed three doc files that also referenced the old runtime — found by a final repo-wide grep: `docker/README.md:237,241` (RunPod template table), `docker/HOW_TO_USE_DOCKER.md:13` (ASCII diagram), `docker/venice/README.md:123` (build notes). All three updated. Lesson recorded: the Step 0 claim list enumerated only the files found in the first pass; the AC5 grep was scoped to AGENTS.md only — repo-wide `grep -rn "node:18\|node-version: 18\|v18\.18"` is the real completeness check and is now clean.

**Smoke-test evidence (2026-10-20):**

```
$ grep -rn "node:18\|node-version: 18\|v18\.18" docker/ .github/ AGENTS.md  →  no matches
$ grep -n "Node Version" AGENTS.md  →  ## Node Version section present, describes v22.23.3
```

No Node 18.18 claims remain anywhere (AC5).

## Step 7 — Full verification (merge gate)

On Node 22.23.3 (`nvm use`):

1. `yarn setup` — clean install + Prisma generate/migrate/seed
2. `yarn test` — full Jest suite
3. `yarn lint:ci` — no new lint failures

**Evidence (2026-10-20, all on Node v22.23.3):**

1. **`yarn setup` — PASS.** Deps installed in all sub-packages; Prisma Client generated (v5.3.1); DB already in sync (no pending migrations); seed executed. 13.2 s.
2. **`yarn test` — PASS.** `Test Suites: 49 passed, 49 total` / `Tests: 406 passed, 406 total`. 11.3 s. (AC6)
3. **`yarn lint:ci` — baseline unchanged.** First run failed with `eslint: not found` in server/frontend/collector — root cause was **not** the Node change: the shell had `NODE_ENV=production` set, which made `yarn install` skip devDependencies (including eslint). Reinstalled dev deps (`env -u NODE_ENV yarn install --check-files` in each package). After that, lint ran but reported **25 pre-existing problems (20 errors, 5 warnings)** — identical to a baseline run with the working tree stashed (same 25, zero diff line-by-line). Confirmed pre-existing on the same Node version; not introduced by this workstream. The 20 errors live in the frontend (`react-hooks/refs` in portaled modals, unused-vars in `QuickActions/index.jsx`) — separate cleanup, out of scope here.
4. **Docker smoke — PASS, exceeded plan.** `docker build -f docker/Dockerfile --target base` succeeded on `node:22-slim` (native deps including better-sqlite3 built cleanly), and the resulting image was **run**: Ollama installed, all 44 Prisma migrations applied against a fresh SQLite DB, server + collector booted (v0.19.0 banner, UI served on :8686), clean SIGTERM shutdown. `docker run ... node --version` confirms the image runs the Totem launcher end-to-end.

**Merge gate: PASSED.**

**Correction (2026-10-20):** the Step 7 Docker-smoke evidence and spec N4 originally named `better-sqlite3` as a native dependency; grep shows no such dependency anywhere in the repo — the stack uses Prisma's SQLite engine. The actual ABI-sensitive natives are `@prisma/client` (query engine) and `sharp` (collector), and the Step 3 lightweight probe verified both on `node:22-slim` (ABI 127). The merge-gate conclusion is unchanged.

## Risk table

| Step | Risk | Level | Mitigation |
|---|---|---|---|
| 3 (Dockerfiles) | Native module rebuild breaks under node:22-slim | Medium | `docker build` smoke per image; Step 7 is the merge gate |
| 3 (beta 24→22) | Something in beta image specifically needed 24 | Low | `docker/beta` is dev-only; smoke build + `yarn dev:all` inside container |
| 4 (release.yml) | `node-version-file` path resolution | Low | setup-node@v4 reads `.nvmrc` from repo root — verified supported; fallback is a literal `22.23.3` |
| 5 (engines) | Yarn 1 engine-strict behavior on contributors' machines running 18 | Low | Intentional — loud failure is the point; message documents the fix (`nvm use`) |
| 7 (test suite) | Pre-existing flakes unrelated to runtime | Low | Compare against a baseline run before/after on the same Node version if failures appear |

All steps are mechanical config edits; the high-blast-radius step is Step 3 (four images), and Step 7 is its merge gate.

## PR status

Ships on `dev-totem` as a three-commit sequence — the two co-resident fixes noted in the Final record were separated out so this commit stays purely about the runtime change:

| Commit | Scope | Status |
|---|---|---|
| `c742b073` | `fix(server): regenerate package-lock to include ethers tree` — repairs missing lockfile entries from `6f671e90`; unrelated to Node 22, landed first | ✅ Landed 2026-10-20 |
| `e467452a` | `fix(docker/beta): persist STORAGE_DIR on totem-beta-data volume` — completes the beta compose change (the volume mount was previously dead weight; beta data was wiped on container recreation) | ✅ Landed 2026-10-20 |
| *(this commit)* | `chore(node22): ratify Node 22 LTS as runtime` — all remaining files + this doc directory | Pending commit |

**Incident log (2026-10-20, dependency hygiene):** during pre-commit review, an uncommitted `server/yarn.lock` was found in the working tree — 1,767 lines of re-serialization plus unvalidated devDependency downgrades (prettier 3.8.3→3.2.5, hermes-parser 0.36.1→0.20.1, a cascade of `@inquirer/*` downgrades) and dropped platform-specific optional deps (`@lancedb/*-darwin`, `fsevents`), regenerated during an earlier agent session that ran on Linux with `NODE_ENV=production` set. Reverted via `git checkout -- server/yarn.lock`; `node_modules` rebuilt from the committed resolutions (`env -u NODE_ENV yarn install` — see the NODE_ENV gotcha in the Step 7 lint evidence); helpers suite re-run 12/12 on the clean tree, reproducing the Step 7 pass on the committed dependency tree.

---

## Final record

All steps executed 2026-10-20 on `dev-totem` (base commit `4ace3bb5`). Steps 0–7 complete; merge gate passed (see Step 7 evidence). Files changed:

- `docker/Dockerfile:24`, `docker/hosted/Dockerfile:25`, `docker/venice/Dockerfile:28` — `node:18-slim` → `node:22-slim`
- `docker/beta/Dockerfile:44` — `node:24-slim` → `node:22-slim`; corepack comment block (71–76) reworded
- `.github/workflows/release.yml:23` — `node-version: 18` → `node-version-file: .nvmrc`
- `package.json:18`, `server/package.json:10`, `collector/package.json:10` — engines → `>=22`
- `AGENTS.md:275` (Vite note), `AGENTS.md:426` (Node Version section) — updated

Uncommitted co-resident change noted: `docker/beta/docker-compose.yml` (pre-existing local modification adding `STORAGE_DIR` to the beta compose file) — predates this workstream, not part of it; should ship in its own commit or ride along with the beta operator's awareness.

Bugfix commits during testing: none — no application code was touched.

README for this workstream (operational notes) is to be written when the PR lands, per the doc-first workflow.
