---
name: doc-first-workflow
description: How to create and follow the three-document workflow (requirement-spec, implementation-plan, README) used for feature workstreams in totem_docs/. Use when starting a non-trivial feature, reviewing a spec/plan, or updating docs for completed work.
---

# Doc-First Workflow (spec → plan → README)

Every non-trivial workstream gets a directory under `totem_docs/<workstream-name>/`
containing exactly three files, each with a distinct audience and lifetime:

| File | Question it answers | Reader | Lifetime |
|------|--------------------|--------|----------|
| `requirement-spec.md` | **What & why** | Reviewer, future maintainer deciding whether to change it | Outlives implementation |
| `implementation-plan.md` | **How & in what order** | The implementer | Historical record — never rewritten after the fact |
| `README.md` | **How to operate it** | On-call, new contributors | Lives as long as the feature |

## When this workflow is required

Create a doc directory when the workstream:
- touches a security or isolation boundary (auth, sandboxing, tenancy, allow-lists),
- changes >3 files mechanically (blast radius needs a risk table),
- spans two or more services (server / collector / frontend), or
- changes data layout, migrations, or on-disk formats.

Skip it for one-file fixes, dependency bumps, and pure refactors with no behavior change.

## 1. requirement-spec.md

Required sections, in order:

1. **Header block** — `Status:` (Draft | In progress | Implemented), `Scope:`
   (what this workstream covers), `Depends on:` (other workstreams/models).
2. **Problem** — the current behavior and why it is wrong. Cite file:line.
3. **Goal** — one paragraph, testable.
4. **Requirements** — two tables:
   - **Functional (F#)** — observable behavior. Each row is a numbered requirement.
   - **Non-functional (N#)** — constraints (layer of enforcement, performance,
     compatibility, backward-compat guarantees).
   Requirement IDs are permanent. Every downstream artifact (tests, plan steps,
   README tables) references IDs, never prose.
5. **Out of scope** — explicit list. Anything adjacent you are choosing not to do
   goes here, with a pointer to its workstream if one exists.
6. **Threat model** — two lists:
   - ✅ Prevents: each attack the change stops.
   - ❌ Does not prevent: each residual risk, and which workstream (if any) owns it.
   **Mandatory for security-boundary changes:** state explicitly what happens when
   the identity or context is *missing* (null user, no session, background job) and
   justify fail-open vs fail-closed. A silent fallback to a shared/privileged context
   is a fail-open decision and must be argued for, not just implemented.
7. **Acceptance Criteria** — numbered, Given/When/Then form, one per testable
   requirement. Every AC must map to exactly one test.

**When implementation reveals the spec was wrong** (wrong field name, wrong
directory scheme), correct the spec text — do not just flip `Status:` to
Implemented. The spec must match shipped behavior.

## 2. implementation-plan.md

Header states it is the companion to the spec, and that all paths are relative
to repo root.

**Step 0 is always an investigation step, never code.** Before writing code,
verify every chain the implementation depends on (identity propagation, data
flow, config plumbing). Record findings in a table with `file:line` citations
and a verification date. Known-wrong assumptions in the draft get a
"Correction to Step N" note rather than silent edits.

Each subsequent step:
- states what was implemented (not what was planned — implementers update the
  step as they go),
- has a **Deviations from the original draft** subsection if anything changed
  and why,
- records smoke-test evidence.

The plan ends with a **risk table**: each step, its risk level, and mitigation.
Mark the mechanical/high-blast-radius step explicitly and make the test step
its merge gate.

Final section: status of each PR, plus any bugfix commits found during manual
testing.

**The plan is a journal.** Never rewrite it to match what actually happened —
record deviations in place. Readers trust a plan with visible corrections more
than one that appears to have been right first time.

## 3. README.md

Written last. Required sections:

1. **Header** — status, links to spec and plan.
2. **What it does** — a mode/behavior table (e.g. authenticated vs unauth).
3. **How it works** — a layered diagram or numbered layers, top-down from the
   entry point to the enforcement point.
4. **Directory / data layout** — an annotated tree if the feature adds paths.
5. **Migration / runbook** — if applicable. Every migration must state, at each
   point in the timeline, **who can access what**:
   - before the migration,
   - during (what is copied where, and what still exists where),
   - after, if originals are retained (copy-not-move means the source remains
     readable by every context that could read it before — say so).
6. **Tests** — path + how to run.
7. **Related workstreams** — table of adjacent work with status (✅ Done /
   🔲 Planned / 🔲 Future). This is the index that keeps scope honest.

## 4. Update the surrounding index

When the workstream completes:
- `totem_docs/README.md` — add/update the topic row and status.
- `RELEASE.md` — bullet under "Upcoming / Unreleased".
- Spec `Status:` → Implemented (only after the spec text matches reality).

## Review checklist

Before merging, verify against the artifacts:

- [ ] Every AC maps to a named test; every named test maps to an AC.
- [ ] Spec requirement IDs match what shipped (field names, paths, schemes).
- [ ] Threat model lists the missing-identity behavior and its fail-open/closed rationale.
- [ ] Migration docs state the access picture at every timeline point.
- [ ] "No change needed" claims about untouched code paths have been re-verified, not assumed.
- [ ] Deviations are documented in the plan, and late corrections were folded back into the spec.
- [ ] Any resource created per-request/user/connection notes its growth and eviction story.
- [ ] README describes the feature as it works today, not as it was planned.
