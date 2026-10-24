# Plan: `filesystem-summarize-file`

Status: **Spec** (approved 2026-10-24; ready for implementation PR).
Owner: Fred Terzi
Target branch: `dev-totem`

## Goal

Add a new filesystem tool, `filesystem-summarize-file`, that reads a file
(the same way `filesystem-read-text-file` does — including the Collector
parser pipeline, per-user sandbox scoping, and image handling) but **runs an
internal summarization LLM call first** and returns only the condensed
summary. The goal is that when the model only needs the *gist* of a file it
can get ~500 tokens back instead of ~50,000, saving context and reducing the
chance that `truncateContentForContext` cuts off content the model actually
needed.

`filesystem-read-text-file` remains for cases where the model needs the full
verbatim content (code edits, line-precise questions, etc.). The new tool is
an **alternative** entry point, not a replacement.

---

## 1. Scope

### In scope

- New plugin file `server/utils/agents/aibitat/plugins/filesystem/summarize-file.js`.
- Registration in the existing `filesystemAgent` plugin list
  (`server/utils/agents/aibitat/plugins/filesystem/index.js`).
- Reuse of existing primitives:
  - `getFilesystemFor(userId)` (per-user sandbox)
  - `filesystem.validatePath()` (security gate)
  - `filesystem.isImageFile()` / `readImageAsAttachment()` (images)
  - `filesystem.readFileContent()` (Collector parse + raw fallback)
  - `summarizeContent()` in `server/utils/agents/aibitat/utils/summarize.js`
    (already used by the `document-summarizer` plugin)
- Optional extensions to `summarizeContent()` to accept `focus`, `maxWords`,
  and `format` (backward-compatible; `document-summarizer` output unchanged —
  see §4 backward-compat guarantee).
- Admin UI row in the FileSystem skill panel + i18n strings in
  `frontend/src/locales/en/common.js` (other locale files optional — the i18n
  loader falls back to English).
- Test file mirroring `per-user.test.js`.
- One tool doc file at `totem_docs/tools/filesystem-summarize-file.md`
  (this file, promoted from "Plan" → "Spec" after review).

### Out of scope

- Replacing or renaming `filesystem-read-text-file`.
- New feature flag (inherits `filesystemAgent` gate).
- Summarizing **multiple** files in one call — that is already covered by
  `filesystem-read-multiple-files` for the raw-content case, and we can add a
  `paths` variant later if demanded.
- Summarizing images (images are attached, not summarized — the main model
  sees the image directly and can describe it).
- Streaming the summary to the frontend mid-generation (the summarize chain
  already runs as one opaque LLM call; streaming is a separate concern).
- Billed-usage attribution for the internal summarization LLM call (see §9).

---

## 2. Tool contract

### Name
`filesystem-summarize-file`

### Description (draft — will be finalized in code)

> Produce a concise summary of a file's contents instead of returning the
> full text. Use this when you only need the gist (purpose, key sections,
> API surface, decisions, errors) rather than verbatim lines. Use
> `filesystem-read-text-file` when you need the exact content (e.g. to edit
> it or quote a specific line). Image files are attached for you to view —
> you can describe them after. Only works within allowed directories.

### Parameters (JSON-Schema)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to the file to summarize. Relative to the allowed directory or absolute within it."
    },
    "focus": {
      "type": "string",
      "description": "Optional. What the summary should emphasize (e.g. 'errors and stack traces', 'public API surface', 'architecture decisions'). If omitted, produce a general summary."
    },
    "max_length": {
      "type": "number",
      "minimum": 50,
      "maximum": 4000,
      "description": "Optional target summary length in words. Default ~300. Hard-capped at 4000."
    },
    "format": {
      "type": "string",
      "enum": ["bullets", "narrative", "structured"],
      "description": "Optional output shape. 'bullets' (default) — short bullet list. 'narrative' — 2-3 paragraphs. 'structured' — sections: Purpose, Key points, API/symbols, Warnings, Next steps."
    }
  },
  "required": ["path"],
  "additionalProperties": false
}
```

### Return value

- **Text file, small (≤ SUMMARY_BYPASS_TOKENS, default 1500):** the raw
  content verbatim, prefixed with a one-line note:
  `"(file is small — returning full content instead of a summary)"`.
  Rationale: summarizing a 50-line file wastes an LLM call and loses fidelity
  with no context savings.
- **Text file, large:** the summary string produced by the internal LLM call.
- **Image file:** the file is attached via `addToolAttachment` and the
  tool returns:
  `"Image file \"<name>\" has been attached and is now visible in the
  conversation. You can describe what you see in the image."`
  (Same UX as the image branch of `filesystem-read-text-file` — no extra
  LLM call.)
- **Error:** `"Error summarizing file: <message>"` (never throws to the
  agent loop).

---

## 3. Handler flow

Mirror `read-text-file.js` line-by-line where possible so the two tools feel
like siblings:

```
handler({ path, focus, max_length, format })
  → filesystem = getFilesystemFor(this.super.handlerProps?.userId)
  → log "Using the filesystem-summarize-file tool."
  → validatePath(path)
  → if isImageFile(validPath):
        readImageAsAttachment → addToolAttachment → return confirmation
  → content = readFileContent(validPath)          // Collector + raw fallback
  → tokenCount = new TokenManager(super.model).countFromString(content)
  → if tokenCount <= SUMMARY_BYPASS_TOKENS:        // default 1500
        return "(file is small — returning full content instead of a summary)\n" + content
  → summary = await summarizeContent({
        provider: this.super.provider,
        model: this.super.model,
        content,
        focus,
        maxWords: max_length || null,             // null → util defaults to ~300
        format: format || "bullets",              // new tool always passes a valid enum
        controllerSignal: this.controller.signal, // abort support (see §7)
      })
  → addCitation({
        id: `fs-${base64url(validPath).slice(0,32)}`,
        title: basename(validPath),
        text: summary,                           // summarized text, not raw
        chunkSource: validPath,
        score: null,
      })
  → return summary
```

Notes:
- The new tool **always** passes a non-`null` `format` (defaulting to
  `"bullets"`) so the util's Branch-B prompt is used. Only the existing
  `document-summarizer` plugin (which doesn't pass `format` at all) reaches
  Branch-A (legacy prompt).
- `maxWords` is passed as `null` when the user omits `max_length` — the
  util's Branch-B template then says "Aim for roughly 300 words."
- The `maxWords * 1.5` post-processing cap (§4) uses `maxWords || 300` when
  the user omits the parameter, so the cap is always effective.
- No `head`/`tail` parameters — they don't make sense for a summary and would
  bloat the parameter surface. If the caller needs a window, they should use
  `filesystem-read-text-file` with `head`/`tail`.
- `SUMMARY_BYPASS_TOKENS` is a class-level constant on
  `FilesystemManager` (`FilesystemManager.SUMMARY_BYPASS_TOKENS = 1500`)
  next to the existing `CONTEXT_RESERVE_RATIO`, so it is easy to tune in
  tests.

---

## 4. Changes to `summarizeContent` (`server/utils/agents/aibitat/utils/summarize.js`)

Currently the util takes `{ provider, model, controllerSignal, content }` and
runs a generic LangChain `map_reduce` chain with a fixed
`Write a detailed summary…` prompt. Extend it (backward-compatible — every
new param is optional and defaults to the current behavior):

```js
async function summarizeContent({
  provider, model, controllerSignal, content,
  focus = null,        // string — "emphasize X"
  maxWords = null,     // number — target word count (default ~300)
  format = null,       // null (legacy prompt) | "bullets" | "narrative" | "structured"
}) { … }
```

**Prompt changes** (inside the map prompt template):

The template has **two branches** to preserve backward-compat for
`document-summarizer`:

*Branch A — `format === null` (legacy; used by `document-summarizer`):
keeps the **exact** existing prompt unchanged:

```
Write a detailed summary of the following text for a research purpose:

TEXT:
"{text}"
SUMMARY:
```

*Branch B — `format` is one of `bullets` / `narrative` / `structured`
(used by `filesystem-summarize-file`):

```
You are summarizing a file for an AI agent that needs to decide what to do
next. Write a faithful, dense summary.

{focus ? `Focus on: ${focus}.` : "Cover the main topics, structure, and any
notable decisions, errors, or warnings."}

{maxWords ? `Aim for roughly ${maxWords} words.` : "Aim for roughly 300 words."}

{format === "structured"
  ? "Use these sections: Purpose / Key points / Public API or key symbols / Warnings / Suggested next steps."
  : format === "narrative"
  ? "Write as 2–3 short paragraphs."
  : "Write as a short bullet list."}

Do not invent details that are not in the text. If the text is too short or
too noisy to summarize meaningfully, say so in one line.

TEXT:
"{text}"
SUMMARY:
```

The combine prompt similarly branches: `format === null` keeps the existing
`Here are a number of partial summaries…` template; otherwise it uses the
same `focus` / `maxWords` / `format` constraints as the map prompt so the
reduce step honours them.

**Backward-compat guarantee:** `document-summarizer` calls
`summarizeContent({ provider, model, controllerSignal, content })` — none of
the new params are passed, so `format === null` → Branch A → byte-identical
prompt to today. No output change for `document-summarizer`.

**In-scope hardening** (do in the same PR):
- Cap the summary output at `(maxWords || 300) * 1.5` words by post-processing
  (split on whitespace, truncate, snap to last sentence) — defends against
  models that ignore the length instruction. ~10 lines, cheap, protects the
  agent's context budget. When the user omits `maxWords` the cap is 450
  words (1.5 × 300).

**Optional hardening** (separate PR if time):
- Wrap the LLM call in a 60 s default timeout (`AbortController` is already
  wired via `controllerSignal`; the timeout adds a hard ceiling so a stuck
  model doesn't hang the agent session indefinitely).

---

## 5. Files to touch

| # | File | Change |
|---|------|--------|
| 1 | `server/utils/agents/aibitat/plugins/filesystem/summarize-file.js` | **New** — tool definition + handler (mirror of `read-text-file.js`). |
| 2 | `server/utils/agents/aibitat/plugins/filesystem/index.js` | `require` + add to `filesystemAgent.plugin[]`. |
| 3 | `server/utils/agents/aibitat/utils/summarize.js` | Extend `summarizeContent()` with optional `focus`, `maxWords`, `format`. Backward-compatible. |
| 4 | `server/utils/agents/aibitat/plugins/filesystem/lib.js` | Add `FilesystemManager.SUMMARY_BYPASS_TOKENS = 1500` class constant. (No other lib changes — all I/O primitives already exist.) |
| 5 | `frontend/src/pages/Admin/Agents/FileSystemSkillPanel/index.jsx` | Add a row in `getFileSystemSubSkills` under the `read` category. Pick an icon (`TextT` or `Sparkle`) and add it to the existing `@phosphor-icons/react` import list (neither is currently imported). |
| 6 | `frontend/src/locales/en/common.js` (other `common.js` locale files optional) | Add `agent.skill.filesystem.skills."summarize-file".title` and `.description` — matching the existing key convention used by the other rows (e.g. `agent.skill.filesystem.skills.read-text-file.title`). The i18n loader (`resources.js`) falls back to English for missing keys, so EN-only is fine for v1. |
| 7 | `server/__tests__/utils/agents/aibitat/plugins/filesystem/summarize-file.test.js` | **New** — Jest tests (see §8). |
| 8 | `totem_docs/tools/filesystem-summarize-file.md` | Promote this doc from *Plan* to *Spec* (flip status header, add AC list). |
| 9 | `FILE_TREE.md` | Regenerate: `yarn file-tree:generate`. |

No changes to:
- `server/utils/agents/aibitat/plugins/index.js` — the filesystem agent is
  already registered there; adding a tool inside its plugin array is enough.
- `agent_skill_whitelist` DB schema — the new tool rides the existing
  `filesystem-agent` skill slug (parent skill), so no new slug or migration
  is needed. The Admin sub-skill toggle in the panel writes to
  `systemPreferencesByFields(["disabled_filesystem_skills"])`, which is a
  per-sub-skill **opt-out** array — not a new whitelist entry. (Confirm in
  test §8.4.)
- Collector, provider wrappers, or billing.

---

## 6. Acceptance criteria

- **AC1** — Calling `filesystem-summarize-file` with a valid text path in
  the allowed directory returns a summary string of roughly the requested
  `max_length` (±50%) and does **not** return the raw file content.
- **AC2** — For an image path, the tool attaches the image and returns the
  confirmation string; no LLM call is made.
- **AC3** — For a file whose content is ≤ `SUMMARY_BYPASS_TOKENS` tokens,
  the tool returns the raw content with the "file is small" note and makes
  **no** internal LLM call (asserted by mocking `summarizeContent` and
  expecting zero calls).
- **AC4** — A path outside the allowed directories (or escaping via
  symlink) is rejected with `Access denied - …` and the tool returns the
  error string — no I/O, no LLM call.
- **AC5** — In multi-user mode, user A cannot summarize a file that only
  exists in user B's `users/<B>/` directory (per-user scoping inherited
  from `getFilesystemFor`).
- **AC6** — `focus`, `max_length`, and `format` are honoured: the returned
  text mentions the focus topic, is within the target word range, and
  matches the requested shape (bullets vs. narrative vs. structured
  headings).
- **AC7** — The tool appears as a row in **Admin → Agents → FileSystem →
  Read Actions** with a working toggle. Toggling it adds/removes
  `filesystem-summarize-file` from the `disabled_filesystem_skills`
  system-preference array (no new DB slug, no migration).
- **AC8** — All existing tests still pass (`yarn test`), including the
  `document-summarizer` tests that exercise the unmodified
  `summarizeContent()` default path.
- **AC9** — The tool appears in the agent's available tool list at runtime
  (verified via WebSocket agent session + introspect log line
  `Using the filesystem-summarize-file tool.`).

---

## 7. Edge cases & failure modes

| Case | Behaviour |
|------|-----------|
| File does not exist | `validatePath` throws (ENOENT branch validates parent dir, then `readFileContent` throws on `fs.readFile`) → caught → `"Error summarizing file: ENOENT …"`. |
| Collector offline | `readFileContent` already falls back to raw `fs.readFile` — summarization proceeds on raw text. (PDFs will be garbage but the tool still returns *something*; the agent can follow up with `filesystem-read-text-file`.) |
| Empty file (0 bytes) | `readFileContent` returns `""` → token count 0 → bypass branch returns `"(file is small — returning full content instead of a summary)\n"` with no content. Acceptable. |
| LLM summarization call fails (network, 500, timeout) | `summarizeContent` throws → caught in handler → `"Error summarizing file: <msg>"`. Suggestion appended: `"Try again or use filesystem-read-text-file with head/tail to read smaller portions."` |
| Model returns empty summary | Post-check: if `summary.trim().length === 0` → return the raw content with a warning note (safer than an empty string). |
| Very large file (multi-MB) | `readFileContent` already buffers the whole string; the summarize chain chunks it. We do **not** add streaming here — it would require rework of `summarizeContent`. Flagged as a follow-up. |
| `format` value not in enum | JSON-Schema enum rejects at the provider layer (OpenAI/Anthropic tool-call validation). If a provider lets it through, default to `bullets`. |
| User cancels the agent session mid-summary | Wire `this.controller.abort()` (see `summarize.js` plugin) — the LangChain chain already accepts a `signal`. |

---

## 8. Test plan

New file: `server/__tests__/utils/agents/aibitat/plugins/filesystem/summarize-file.test.js`
(Model on the existing `per-user.test.js`.)

1. **Happy path — large file**
   - Mock `readFileContent` to return ~50 KB of text (token count > bypass).
   - Mock `summarizeContent` to return a canned summary.
   - Assert: `summarizeContent` was called with `{ provider, model, content,
     focus, maxWords, format }`; the tool returned the canned summary;
     `addCitation` was called with the summary text and the stable
     `fs-…` id.
2. **Small-file bypass**
   - Mock `readFileContent` to return ~500 tokens of text.
   - Assert: `summarizeContent` was **not** called; the returned string
     begins with the "file is small" note and contains the raw content.
3. **Image path**
   - Use a 1×1 PNG fixture in the sandbox dir.
   - Assert: `addToolAttachment` was called with a `data:image/png;base64,…`
     string; the return value mentions the image was attached.
4. **Per-user isolation**
   - Create two `FilesystemManager` instances scoped to different user dirs
     (same pattern as `per-user.test.js`).
   - Place a file only in user B's dir.
   - Assert: user A's call fails with `Access denied - path outside allowed
     directories.` and the file's content is **not** in the response.
5. **Symlink escape**
   - Create a symlink inside the sandbox that points outside it.
   - Assert: rejected with the symlink-target error.
6. **Prompt param pass-through**
   - Call with `focus="errors"`, `max_length=120`, `format="structured"`.
   - Assert: `summarizeContent` received exactly those values (plus defaults
     for any not provided).
7. **`summarizeContent` unit tests** (extend the existing
   `server/__tests__/utils/agents/aibitat/utils/summarize.test.js` if it
   exists, otherwise create it):
   - Default call (no new params) → same prompt text as before (regression
     guard for `document-summarizer`).
   - Call with `focus`/`maxWords`/`format` → prompt template contains the
     focus phrase, the word target, and the shape instruction.
   - `format="structured"` → combine prompt asks for the five section
     headings.
8. **Abort** — fire `controller.abort()` mid-chain, expect the rejection to
   be surfaced as an error string (not an unhandled rejection).
   - *Note:* unlike tests 1–7 (which can mock `summarizeContent`), the abort
     test needs a fake `super` object with `controller`, `provider`, `model`,
     `handlerProps.userId`, `introspect()`, `addCitation()`, and
     `addToolAttachment()` — because it must exercise the real handler
     against a real (or stubbed) LangChain chain. Build the fake once and
     share it across tests 1, 3–6, and 8.

Run: `npx jest path/to/summarize-file.test.js` and
`npx jest --testPathPattern="aibitat"`.

---

## 9. Billing / cost considerations (call-out, no code change in v1)

`summarizeContent()` makes a **second** LLM call with the workspace's
provider/model. The current billing flow
(`server/models/credits.js#debitUsage`) only records the *main* chat turn's
input/output tokens — the summarization sub-call is currently free from the
user's credit-balance perspective (same as the existing
`document-summarizer` plugin).

This is acceptable for v1 (parity with existing behaviour) but worth
tracking:

- **Follow-up (separate PR, out of scope here):** pipe the summarize
  chain's `usage` (tokens in/out) into `debitUsage` with a `reference` of
  `agent_summarize:<sessionId>:<toolCallId>` so heavy summarization usage
  is visible in the ledger.
- **Interim:** document in the tool description that summarizing a very
  large file may take a few extra seconds (the agent already surfaces
  `introspect` lines, which the WebSocket stream renders to the user).

---

## 10. Prompt-engineering notes for the agent system prompt

Once the tool ships, update the agent system prompt (or the plugin
`description` string — the model sees both) to steer usage:

- "When the user asks a question that only needs the *gist* of a file
  ('what does this file do?', 'what are the main functions?'), prefer
  `filesystem-summarize-file` over `filesystem-read-text-file`."
- "Use `filesystem-read-text-file` when you need exact content: editing,
  quoting a line, searching for a specific token, or reading code you will
  transform."
- "If a summary is not detailed enough, follow up with
  `filesystem-read-text-file` with `head`/`tail` to drill in — do not
  re-summarize."

(Exact wording to be drafted in the PR that lands the tool.)

---

## 11. Rollout

1. **PR 1 (this change):** tool + util extension + tests + admin UI + docs.
   Conventional commit: `feat(filesystem): add filesystem-summarize-file
   agent tool` → minor version bump on merge to `main-totem`
   (automated by `standard-version`).
2. **Post-merge:** fast-forward `dev-totem` to `main-totem` per AGENTS.md.
3. **Optional PR 2 (next sprint):** billing attribution (§9) + a
   `filesystem-summarize-multiple-files` variant if usage justifies it.

---

## 12. Open questions

1. **Default `max_length`:** 300 words is a guess. Should we surface a
   per-workspace setting? (Leaning: no for v1 — keep the parameter, let
   the agent choose.)
2. **Should `format` default to `structured`** rather than `bullets`?
   Structured is more scannable for the agent but costs ~10% more tokens.
   Leaning: keep `bullets` as default (cheaper, matches how agents
   actually consume summaries).
3. **Do we need a `language` parameter?** (Summarize in French / Spanish.)
   Out of scope — the model will naturally mirror the user's language via
   the surrounding chat context.
4. **Should we cache summaries** keyed by `(path, mtime, focus, max_length,
   format)` in `cache_data` with a short TTL? Would avoid re-summarizing
   the same file in a long session. **Leaning: no for v1** — the bypass
   threshold already covers the small-file case and the agent rarely asks
   twice.

---

## 13. Checklist for the implementing PR

- [ ] New tool file created and registered in `filesystem/index.js`.
- [ ] `summarizeContent()` extended with optional params; existing call sites
      unchanged.
- [ ] `SUMMARY_BYPASS_TOKENS` constant added to `FilesystemManager`.
- [ ] Admin UI row + i18n strings added.
- [ ] Jest tests from §8 pass.
- [ ] `yarn lint` clean, `yarn test` green.
- [ ] `FILE_TREE.md` regenerated.
- [ ] This doc flipped to *Spec* with a changelog line.
- [ ] PR title uses Conventional Commits (`feat(filesystem): …`).
- [ ] Post-merge: `dev-totem` fast-forwarded to `main-totem`.
