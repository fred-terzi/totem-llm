# Node 22 LTS Ratification — Operations

**Status:** ✅ Implemented 2026-10-20
**Spec:** [requirement-spec.md](requirement-spec.md) · **Plan:** [implementation-plan.md](implementation-plan.md)

## What it does

Exactly one ratified Node version — **Node 22 LTS (22.23.3)** — declared consistently across the repo. No application behavior change.

| Location | Before | After |
|---|---|---|
| `.nvmrc` | `22.23.3` (already bumped by `4ace3bb5`) | `22.23.3` — ratified, **single source of truth** |
| `docker/Dockerfile:24` | `node:18-slim` (deps would not install) | `node:22-slim` |
| `docker/hosted/Dockerfile:25` | `node:18-slim` (deps would not install) | `node:22-slim` |
| `docker/venice/Dockerfile:28` | `node:18-slim` (deps would not install) | `node:22-slim` |
| `docker/beta/Dockerfile:44` | `node:24-slim` | `node:22-slim` (aligned down) |
| `.github/workflows/release.yml:23` | `node-version: 18` (EOL runtime) | `node-version-file: .nvmrc` |
| `package.json:18` engines | `>=18` | `>=22` |
| `server/package.json:10` engines | `>=18.12.1` | `>=22` |
| `collector/package.json:10` engines | `>=18.12.1` | `>=22` |
| `AGENTS.md` (Node Version + Vite note) | described Node 18.18 pin | describes Node 22 |

## How it works

`.nvmrc` is the single source of truth. Everything else is kept in sync by review discipline, not automation (spec N2 — deliberate; see the spec's threat model for the drift trade-off).

```
.nvmrc (22.23.3)
  ├─→ docker/*/Dockerfile   FROM node:22-slim        (manual sync)
  ├─→ release.yml           node-version-file: .nvmrc (automatic — CI reads the file)
  ├─→ package.json engines  "node": ">=22"            (manual sync, root/server/collector)
  └─→ AGENTS.md Node Version section                  (manual sync)
```

**Drift check (run after any future Node bump):**

```bash
grep -rn "node:18\|node-version: 18\|v18\.18" docker/ .github/ AGENTS.md   # must be empty
grep -n "FROM node" docker/Dockerfile docker/hosted/Dockerfile docker/venice/Dockerfile docker/beta/Dockerfile
grep -n '"node"' package.json server/package.json collector/package.json
```

## Runbook — how to bump Node again

1. Update `.nvmrc` to the new ratified version.
2. Update all four `FROM node:` lines in `docker/{,hosted/,venice/,beta/}Dockerfile`.
3. Update `engines.node` in root, `server/`, and `collector/` package.jsons.
4. Update `AGENTS.md` (Node Version section + any affected notes) and the Docker docs (`docker/README.md`, `docker/HOW_TO_USE_DOCKER.md`, `docker/venice/README.md`).
5. Verify: repo-wide drift grep (above), then `yarn setup && yarn test`. For Docker, prefer the **lightweight native-compat probe** recorded in the plan's Step 3 over a full image build — a full `docker build -f docker/Dockerfile` produces a ~22 GB image (Ollama + pre-pulled models).

## Tests

Config-only change — no dedicated test files. Evidence lives in the implementation plan:

- **Step 7 (merge gate):** `yarn setup` clean, `yarn test` **49 suites / 406 tests passing** on Node v22.23.3, `yarn lint:ci` baseline unchanged.
- **Step 3 (probe):** `@prisma/client` + `sharp` verified loading on `node:22-slim` (ABI 127) via the plan's probe command.

## Related workstreams

| Workstream | Status | Note |
|---|---|---|
| `credit-payments` | 🔲 Planned | Depends on this one — jose EdDSA JWT signing works on 22/24, fails on 18 |
| Node 24 adoption | 🔲 Future | Dev shell already runs 24.18.0; deferred to keep one ratified version |
