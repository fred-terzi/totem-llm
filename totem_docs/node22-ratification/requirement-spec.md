# Node 22 LTS Ratification

**Status:** Implemented
**Scope:** Runtime version standardization across all services, Docker images, CI, package engines, and docs. Does not change application behavior.
**Depends on:** None. Is a prerequisite workstream for `credit-payments` (which requires the jose/EdDSA JWT primitive for Coinbase checkout API auth — verified working on Node 22, broken on 18).

---

## Problem

The repo's Node version pin has already moved, but the migration is half-finished, leaving a mixed-runtime matrix that makes dependency and feature work unpredictable:

| Location | Value | State |
|---|---|---|
| `.nvmrc` | `22.23.3` | ✅ Already bumped (commit `4ace3bb5`, 2026-10-20) |
| `docker/beta/Dockerfile:44` | `node:24-slim` | ✅ Already migrated (but to 24, not 22) |
| `docker/Dockerfile:24` | `node:18-slim` | ❌ **Cannot install deps** — dep tree now requires ≥20.19 |
| `docker/hosted/Dockerfile:25` | `node:18-slim` | ❌ **Cannot install deps** |
| `docker/venice/Dockerfile:28` | `node:18-slim` | ❌ **Cannot install deps** |
| `.github/workflows/release.yml:23` | `node-version: 18` | ❌ Release CI runs standard-version on EOL runtime |
| root `package.json:18` engines | `>=18` | ❌ False claim — current dep tree violates it |
| `server/package.json:10` engines | `>=18.12.1` | ❌ False claim |
| `collector/package.json:10` engines | `>=18.12.1` | ❌ False claim |
| `AGENTS.md:426` ("Node Version") | "Pinned to v18.18.0" | ❌ Stale doc |
| `AGENTS.md:275` (Vite note) | "yarn 1 hard-fails on under our Node 18.18 pin" | ❌ Stale rationale |

**Empirical evidence the dep tree already left 18 behind** (verified 2026-10-20):

- `css-select` 7, `mailparser` 3.10, `@babel/core` 8 all declare `engines: node >=20.19` — cited in commit `4ace3bb5` as the reason `.nvmrc` was bumped. Fresh `yarn install` fails on Node 18.
- The jose library (ESM-only ≥ v6, present as transitive dep of MCP SDK) signs EdDSA JWTs via `require()` on Node 22.23.3 and 24.18.0 — **fails on Node 18.20.8** with `require() of an ES Module`. This is the exact primitive the planned Coinbase credit-payments feature needs. (`jsonwebtoken` v9 does not support Ed25519 at all.)

**Why this is wrong:** every non-trivial feature decision currently carries a hidden footnote ("may behave differently on 18/22/24"), three of four Docker images cannot build, and the release CI runs on an EOL runtime. A money-handling feature (credit payments) is about to be built on top of this ambiguity.

## Goal

Exactly one ratified Node version — **Node 22 LTS (22.23.3)** — declared consistently in `.nvmrc`, all Dockerfiles, CI, package `engines`, and docs, with a passing full `yarn setup` + `yarn test` run as smoke evidence. No application behavior change.

## Requirements

### Functional (F#)

| ID | Requirement |
|---|---|
| F1 | `.nvmrc` contains the ratified version (`22.23.3`). Already true; ratified by this spec. |
| F2 | All Dockerfiles under `docker/` use base images matching the ratified version (`node:22-slim`). |
| F3 | `.github/workflows/release.yml` derives its Node version from `.nvmrc` (`node-version-file: .nvmrc`) rather than a hardcoded literal. |
| F4 | `engines.node` in root, `server/`, and `collector/` package.jsons accurately declare the supported range (`>=22`). |
| F5 | `AGENTS.md` Node Version section and the Vite/wallet-standard note describe the ratified runtime. |
| F6 | A full `yarn setup` and `yarn test` pass on Node 22.23.3 (recorded as smoke evidence in the implementation plan). |

### Non-functional (N#)

| ID | Constraint |
|---|---|
| N1 | No application source code changes (server/collector/frontend `src/`, `lib/`). Config, CI, Docker, engines, and docs only. |
| N2 | Layer of enforcement: `.nvmrc` is the single source of truth; Dockerfiles, CI, and engines are derived/synced from it by this workstream. Future drift is a docs/CI review concern, not automated. |
| N3 | Backward compatibility: no runtime behavior change is intended on 22 vs the current dev reality (dev shell already runs 24.18.0, beta Docker runs 24, `.nvmrc` says 22). This workstream ratifies and aligns; it does not introduce a new runtime anywhere. |
| N4 | Native-module compatibility: native dependencies (`@prisma/client` query engine, `sharp`, and other native modules in the tree) must resolve and load under `node:22-slim` (verified by the plan's smoke build and lightweight probe). |

## Out of scope

- **Upgrading to Node 24** — dev shell and `docker/beta` currently run 24; aligning them down to 22 is in scope (one-line changes), but a broader 24 adoption is a future chore.
- **Credit payments feature** — its own workstream (`credit-payments`), which depends on this one.
- **Depinning/refreshing the dependency tree** — only what's needed for 22 compatibility.
- **Removing deprecated Dockerfiles** (`docker/hosted`, `docker/venice`) — aligned in place even if vestigial; removal is a separate cleanup decision.
- **Tracking `yarn.lock`** — remains untracked per existing repo convention.

## Threat model

This workstream touches no security or isolation boundaries and no identity flow.

- ✅ Prevents: supply-chain/runtime drift risk — CI and images silently building on an EOL runtime that can't reproduce dev behavior; broken Docker builds shipping unknowingly.
- ❌ Does not prevent: future engine drift (new deps raising the floor again) — mitigated only by review discipline; native-module breakage on future Node majors — each is a routine chore.
- **Missing-identity behavior:** N/A — no identity or context changes. All changes fail-safe (a wrong `engines` declaration fails loudly at install time under yarn 1's `--engine-strict`-eligible paths; a wrong Dockerfile fails at build time).

## Acceptance Criteria

| AC# | Given / When / Then | Test |
|---|---|---|
| AC1 | **Given** the repo checkout, **when** `cat .nvmrc` is run, **then** it contains `22.23.3`. | Smoke check in plan Step 2 evidence |
| AC2 | **Given** any `docker/*/Dockerfile`, **when** its base `FROM` lines are inspected, **then** every Node base image is `node:22-slim` (or a 22.x variant). | Grep check in plan Step 3 evidence |
| AC3 | **Given** `.github/workflows/release.yml`, **when** inspected, **then** `setup-node` uses `node-version-file: .nvmrc` and no literal `node-version: 18` remains. | File inspection in plan Step 4 evidence |
| AC4 | **Given** root, `server/`, and `collector/` package.jsons, **when** their `engines.node` fields are inspected, **then** all declare `>=22`. | Grep check in plan Step 5 evidence |
| AC5 | **Given** AGENTS.md, **when** the Node Version section and Vite note are read, **then** they describe Node 22 and no claim of a Node 18.18 pin remains. | Doc review in plan Step 6 evidence |
| AC6 | **Given** a clean checkout with Node 22.23.3 active, **when** `yarn setup && yarn test` runs, **then** both succeed. | Full test run recorded in plan Step 7 |

**AC → test mapping:** AC1–AC5 map to inspection/grep checks recorded as evidence in implementation-plan steps; AC6 maps to the full Jest suite (`yarn test`) plus Docker build smoke for the images touched.
