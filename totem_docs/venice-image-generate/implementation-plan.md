# Venice Image Generation Skill — Implementation Plan

**Companion to:** [requirement-spec.md](requirement-spec.md) — read the spec first for F#/N#/AC definitions.
All paths are relative to repo root (`totem-llm/`).

---

## Step 0 — Investigation (verify every dependency chain, no code)

**Status:** Complete (2026-10-20)

| # | Chain to verify | Finding (file:line) | Verified |
|---|----------------|---------------------|----------|
| 0.1 | `VENICE_API_KEY` is available server-side and already used by an existing provider | `server/utils/AiProviders/venice/index.js:47,55` — reads `process.env.VENICE_API_KEY`; key present in `server/.env` (line: `VENICE_API_KEY=…`). Confirmed also referenced in `server/utils/agents/index.js` and `aibitat/providers/venice.js`. | ✅ 2026-10-20 |
| 0.2 | Per-user sandbox resolution | `server/utils/agents/aibitat/plugins/filesystem/lib.js:844-864` — `getFilesystemFor(userId)` returns cached `FilesystemManager` with allow-list `$STORAGE_DIR/totemllm-fs/users/<userId>/`; `userId == null` → shared default instance rooted at `$STORAGE_DIR/totemllm-fs/`. Exports `module.exports.getFilesystemFor`. | ✅ 2026-10-20 |
| 0.3 | How existing filesystem tools obtain userId | `plugins/filesystem/write-text-file.js:52-54` — `getFilesystemFor(this.super.handlerProps?.userId)`. This is the identity chain our tool will reuse verbatim. | ✅ 2026-10-20 |
| 0.4 | Sandbox write API surface | `FilesystemManager` exposes `validatePath(relPath)` and `writeFileContent(path, content)` (used by write-text-file). **Binary write:** `validatePath` + Node `fs` on the validated absolute path is required for Buffer payloads — `writeFileContent` is text-oriented. Plan: use `validatePath()` to resolve/validate the target, then `fs.writeFile(validatedAbsolute, buffer)`. Must confirm `validatePath` creates missing parent dirs or call its `ensureInitialized()` + explicit `mkdir` first (implemented in Step 3; verified during smoke test). | ✅ 2026-10-20 (API surface; binary-write pattern confirmed in Step 3) |
| 0.5 | Download-card emission pattern | `plugins/create-files/text/create-text-file.js:129-139` — `this.super.socket.send("fileDownloadCard", { filename, storageFilename, fileSize })` then `createFilesLib.registerOutput(this.super, "TextFileDownload", { … })`. `registerOutput` at `create-files/lib.js:174-186` pushes into `aibitat._pendingOutputs`. | ✅ 2026-10-20 |
| 0.6 | How download cards are served | `server/endpoints/agentFileServer.js:29` — `GET /agent-skills/generated-files/:filename` serves **only** `{fileType}-{uuid}.{ext}` files from `storage/generated-files/` (defense-in-depth format check via `parseFilename`). ⚠️ **Gap:** our images live in the sandbox, not `generated-files/`. **Correction to Step 2 (recorded below):** the download card for sandbox images must link through the File Explorer's file route (or a small sandbox-file read endpoint), NOT the generated-files endpoint. Resolved in Step 2's deviation note. | ✅ 2026-10-20 (gap identified pre-implementation) |
| 0.7 | Plugin registration contract | `plugins/index.js` — every plugin has a named export + a `[name]` slug alias; admin whitelist UI lists registered plugins (`agent_skill_whitelist`). | ✅ 2026-10-20 |
| 0.8 | Approval gate availability | `plugins/filesystem/write-text-file.js:57-70` — `this.super.requestToolApproval({ skillName, payload, description })` pattern. **Implementation:** `plugins/websocket.js:114` — `aibitat.requestToolApproval` emits a `toolApprovalRequest` socket event, blocks up to 2 min (`TOOL_APPROVAL_TIMEOUT_MS`), resolves `{ approved, message }`; timeout resolves as rejection. **Auto-approval paths:** `skillIsAutoApproved` (`server/utils/helpers/agents.js:11`, env `AGENT_AUTO_APPROVED_SKILLS` incl. `<all>`) and `AgentSkillWhitelist.isWhitelisted(skillName, userId)` (`server/models/agentSkillWhitelist.js:75`, per-user via `user_<id>_whitelisted_agent_skills` system setting) both short-circuit to approved. **Frontend:** `ToolApprovalRequest/index.jsx` renders the card (description + expandable payload + Approve/Reject + "Always allow" checkbox that calls `addToWhitelist`). **Consequence for our design:** "Always allow" is the designed auto-generate opt-in (F10) — once the user checks it, the skill is whitelisted for that user and the gate auto-approves silently from then on. That is intended behavior, not a tradeoff to work around: the card is the consent surface, "Always allow" is the user explicitly delegating consent, and the conversational refine-and-confirm (F11) plus billing (F14) still run in every mode. | ✅ 2026-10-20 |
| 0.9 | Real user sandbox exists on disk | `server/storage/totemllm-fs/users/` contains `1,6,9,12,13,14,15` — per-user dirs live; user 6 has `test.txt`, `test-subdir/`. `images/` does not exist yet anywhere — created lazily by our tool. | ✅ 2026-10-20 |
| 0.10 | Venice request/response contract | `totem_docs/../venice-image-generate` SKILL reference (attached): `POST https://api.venice.ai/api/v1/image/generate`, Bearer auth, JSON body, response `{ id, images: [base64…], timing, request }`; errors 400/401/402/415/429/5xx. | ✅ 2026-10-20 |

---

## Step 1 — Create the plugin skeleton and lib (`venice-image/lib.js`, `pricing.js`)

**Status:** Complete (2026-10-20)

Create `server/utils/agents/aibitat/plugins/venice-image/` with three files:

- `pricing.js` — **single source of truth for cost (N4, F13):**
  - `STANDARD_MODEL = "z-image-turbo"` and `COST_PER_IMAGE` (display-credit integer, pinned from Venice `GET /models` `pricing.generation.usd` for that model — see Step 0.10 follow-up below for the exact value).
  - `quote(params)` → `COST_PER_IMAGE × Math.min(params?.variants ?? 1, 4)` — the only v1 variable is variants.
  - Schema designed for growth: an `operations` map keyed by operation name (`generate` today; `edit`, `upscale`, `video` later), each with a `costFor(params)` function. Size-, resolution-, and duration-dependent costs slot in there without touching tools or the confirmation flow. The `generate-image` tool and README quote text read only `quote()` — never a literal number.
- `lib.js` — `VeniceImageManager` class:
  - `isToolAvailable()` → `!!process.env.VENICE_API_KEY`.
  - `buildRequestBody(params)` → merges `{ model: STANDARD_MODEL, prompt, return_binary: false, format }` with only the supplied optional fields (`negative_prompt`, `width`/`height` **or** `aspect_ratio`/`resolution`, `cfg_scale`, `steps`, `seed`, `variants`, `style_preset`, `safe_mode`). Never sends both sizing idioms; never sends the deprecated `inpaint` field. Model is **never** a parameter (F13).
  - `generate(params)` → fetch + error mapping per F6 (402/429/400/401/415/5xx → human-readable messages; content-policy 400s surface the API's error string). Returns `{ images, requestId }` so the debit reference can carry the Venice request id (F14b).
  - `sanitizeSlug(prompt)` → lowercase, strip non-ASCII/unsafe chars, truncate to ~48 chars, for filename construction per N5.
  - `saveToSandbox({ userId, buffer, filename })` → `getFilesystemFor(userId)` → `validatePath("images/" + filename)` → `fs.writeFile(validated, buffer)` (parent dir created recursively first). Returns the validated absolute path + sandbox-relative name.
- `index.js` — plugin object `name: "venice-image-generate"` exposing two tools: `generate-image` (parameters per F1, examples per web-browsing style) and `list-image-styles` (no parameters). Both handlers follow the house pattern: availability check → `introspect` → approval gate (F10) → work → `introspect` result → string return.

**Tool-description refine-and-confirm mandate (F11):** the `generate-image` description must carry explicit instructions, e.g.:

> "Before calling this tool: (1) refine the user's idea into a detailed image prompt covering subject, style, composition, lighting, and aspect ratio; (2) present that prompt to the user along with the exact credit cost (quote via `pricing.quote`, do not invent a number); (3) wait for the user's confirmation. Never call this tool in the same turn the idea is first proposed. This refine-and-confirm contract applies to EVERY user, including users who have enabled auto-generation via the approval card's 'Always allow' option — that option removes the approval card, not this conversation. Pass the confirmed refined prompt as `prompt`."

Also add an example exchange demonstrating the confirm-then-generate turn split, in addition to the parameter-call examples.

**Handler billing flow (F14 + F10), in order:** availability check → `pricing.quote(params)` → **approval gate** (`requestToolApproval` with payload `{ prompt, credit_quote, variants, … }` and description naming the cost — rejection/timeout returns the gate's message before any API call, AC15) → if `userId != null`: `Credits.hasCredits(userId, quote)` (fail → "insufficient credits, this image costs N credits", no API call) → `generate()` → save files → if `userId != null`: `Credits.debit(userId, quote, \`venice-image-generate:${requestId}\`)` → download cards → result string includes the debited amount. Any failure after pre-flight returns before the debit (AC13). The gate runs **before** pre-flight so the user is never shown an internal balance error before seeing the card; pre-flight then protects the API call.

**Step 0.10 follow-up — pin the cost:** ✅ DONE (2026-10-20). Ran real `GET /models?type=image` against the deployment's `VENICE_API_KEY`. Returned for `z-image-turbo`: `model_spec.pricing.generation.usd = 0.01`. Display-credit conversion: this deployment's `users.credits_balance` stores microdollars and the CreditBadge renders that integer directly, so **1 display credit = 1 microdollar** → `COST_PER_IMAGE = 0.01 × 1_000_000 = 10_000 credits per image`. Pinned in `pricing.js` as `GENERATION_COST_USD = 0.01` + `MICRO_PER_USD` (not a magic literal), so the derivation is auditable.

> ⚠️ **SUPERSEDED — credit unit redefinition (2026-10-22).** Commit `235767cb` later redefined the customer-facing credit: **1 credit = $0.001 = 1 000 µ$** (`server/utils/credits/units.js`, `CREDITS_PER_DOLLAR = 1000`). The "1 display credit = 1 microdollar" assumption above no longer holds. `pricing.js` now exports `COST_PER_IMAGE_MICRO` (µ$ billing unit, fed to `Credits.hasCredits`/`debit` — unchanged at 20 000 µ$) and `COST_PER_IMAGE` (display credits via `units.microToCredits` — now **20 credits**). The smoke-test figures below are historical evidence from before the redefinition.

**Deviations from the original draft:**

- **Admin billing exemption (F14 amendment):** implementation revealed the existing credit gate exempts admins (`server/endpoints/chat.js:66-69` passes `user.role` and `hasCredits` auto-passes admins, `models/credits.js:135`). The handler now resolves the session user's role and skips pre-flight + debit for admins, matching house convention. Spec F14 amended accordingly.
- **`registerOutput` call shape:** the plan assumed `createFilesLib.registerOutput` would be reused, but that helper only pushes into `aibitat._pendingOutputs` — the same shape `ephemeral.js#GetPendingOutputs` and `chat-history.js` consume. The handler pushes `{ type: "ImageDownload", payload }` into `aibitat._pendingOutputs` directly via an optional `this.super.registerOutput?.(...)` shim, keeping the consumed contract identical without importing create-files into this plugin.
- **Download-card payload carries `sandboxFile: true` + sandbox-relative `storageFilename`:** Step 2's correction (0.6) applies — the frontend `FileDownloadCard` currently fetches via `/agent-skills/generated-files/:filename`, which cannot serve sandbox files. Step 2 must make the card resolve sandbox files through `GET /filesystem/read?path=…&raw=true` (endpoint exists, `filesystem.js:436`, authenticated, sandbox-scoped). Until Step 2, the card's download button would 400 on these files — expected interim state, gated before merge.

**Smoke-test evidence (2026-10-20, all via `node -e` against the real repo):**

- `pricing.quote({})` → `10000`; `quote({variants:3})` → `30000`; `quote({variants:99})` → `40000` (cap 4 ✓).
- `buildRequestBody`: `aspect_ratio:"16:9"` + `width/height` supplied together → body contains ONLY `aspect_ratio` (idiom exclusivity ✓); minimal params → `{model:"z-image-turbo", prompt, return_binary:false, format:"png"}` and nothing else ✓; no `inpaint` field possible ✓.
- `sanitizeSlug('../../etc/passwd lighthouse at dusk')` → `etc-passwd-lighthouse-at-dusk`; emoji/quotes prompt → safe slug ✓ (AC9 construction half).
- `saveToSandbox` with `userId: 9999` (nonexistent user) → created `users/9999/images/…png` lazily via `validatePath` + `mkdir(recursive)`; file size verified on disk; cross-user check — `getFilesystemFor(13).validatePath()` on user 9999's path throws `Access denied` ✓ (AC3, N1).
- Plugin registration: `AgentPlugins['venice-image-generate']` slug + `.veniceImage` named export both resolve; `setup()` registers both tools.
- Full handler dry-run (mocked fetch returning 2 base64 images, mocked `Credits`, real sandbox, real gate stub): approval card fired FIRST with description `"Generate an image via Venice AI — costs 20000 credits (2 images)"` and payload `{prompt, credit_quote: 20000, variants: 2, …}` (F10/F12 ✓) → pre-flight `hasCredits(9999, 20000)` → 2 files saved to `users/9999/images/` with `-1`/`-2` suffixes (F9 ✓) → 2 download cards + 2 `ImageDownload` outputs → exactly one `debit(9999, 20000, "venice-image-generate:req_test_123")` (F14b ✓) → success string reports debited amount. Test sandbox cleaned up after run.
- Regression guard: existing server test suite (`server/__tests__` filesystem-related, 42 suites / 324 tests) still green after `plugins/index.js` edit.

---

## Step 2 — Download-card wiring for sandbox files

**Status:** Complete (2026-10-20)

Emit `fileDownloadCard` + `registerOutput(this.super, "ImageDownload", …)` per image (pattern verified in 0.5), with payload `{ filename: <sandbox-relative display name>, storageFilename: <sanitized storage name>, fileSize }`.

**What was implemented:** a third option — neither of the two originally listed. The card payload from Step 1 already carries `sandboxFile: true` + sandbox-relative `storageFilename`; Step 2 taught the **existing** `FileDownloadCard` component to route such payloads through the already-shipped, already-tested sandbox read endpoint (`GET /filesystem/read?path=…&raw=true`, `server/endpoints/filesystem.js` — session-authenticated, `resolveFsForRequest`-scoped, streams with `Content-Disposition: inline`). No new server endpoint and no file-explorer deep link needed.

Changes:

- `frontend/src/models/files.js` — `StorageFiles.download(storageFilename, sandboxFile = false)`: when `sandboxFile` is true, fetches `/api/filesystem/read?path=<encoded>&raw=true` (session `baseHeaders()` auth) instead of `/agent-skills/generated-files/…`.
- `frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/FileDownloadCard/index.jsx`:
  - destructures `sandboxFile` from the card payload and routes the download through the new flag (`!!sandboxFile`) — legacy create-files cards (no flag) are unaffected.
  - for sandbox images, fetches the blob once on mount and renders a 48x48 **inline thumbnail preview** in place of the extension badge (blob object URL, revoked on unmount). Server-side sandbox scoping is the only authorization check — the card cannot read files the session's sandbox doesn't own (403/404).
  - adds an `IMG` badge case + `isImageFile()` helper (png/jpg/jpeg/webp/gif/bmp).
- `server/__tests__/endpoints/filesystem.test.js` — two new tests covering the exact card path: (1) `images/…png` streams with `Content-Type: image/png`, `Content-Disposition: inline`, and intact PNG magic bytes; (2) cross-user isolation — user B requesting user A's generated image via the same raw URL gets 404.

**Deviations from the original draft:**

- **Correction to Step 2 (from Step 0 finding 0.6):** `agentFileServer.js` only serves `storage/generated-files/` with `{fileType}-{uuid}.{ext}` names. Resolved by routing sandbox-file cards through the existing `GET /filesystem/read?raw=true` endpoint rather than the two originally listed options (file-explorer deep link vs. new sandbox-file endpoint) — the raw-read endpoint shipped with the file-explorer workstream already provides everything the deep-link option wanted, without coupling the card to File Explorer routing state.
- **Thumbnail preview added (scope addition):** a download card showing only an "IMG" badge for an image felt like a dead end for a media file; the inline preview costs one extra already-authenticated fetch per card and makes the chat card immediately meaningful. Documented here as a deliberate UX addition; spec F3 requires "no dead link" — the preview is strictly additive.
- **Test-harness note:** `callRead(..., { raw: "true" })` awaits a stream `finish` event that never fires on the JSON error branch (404), so the cross-user isolation test invokes the captured handler directly — same pattern as the existing T10 symlink test.

**Smoke-test evidence (2026-10-20):**

- Endpoint contract verified against source: `/filesystem/read` route registered, `raw === "true"` streaming branch, `Content-Disposition: inline` — all present in `server/endpoints/filesystem.js`.
- URL construction matches the endpoint exactly: `images/20261020-090000-lighthouse-at-dusk.png` -> `/api/filesystem/read?path=images%2F20261020-090000-lighthouse-at-dusk.png&raw=true`.
- Card payload parse verified: sandbox image payload (`sandboxFile: true`) routes to the raw endpoint; legacy payload (no flag) unaffected.
- `npx eslint` clean on both frontend files; `npx vite build` succeeds.
- `npx jest server/__tests__` -> **42 suites / 326 tests, all green** (was 324; +2 new endpoint tests). The new tests are the merge gate for this step's risk row ("card must never render without a working target" — the card now has a tested, session-scoped, streaming target).

---

## Step 3 — Registration + whitelisting

**Status:** Complete (2026-10-20)

- `plugins/index.js`: import `veniceImage`, add named export and `[veniceImage.name]` alias (verified contract, 0.7).
- Confirm the skill appears in the admin agent-skills UI and is opt-in (not in `default_agent_skills`).
- No frontend changes required (N7): download cards and File Explorer image previews already render.

**What was implemented:** the server-side registration was already in place from the Step 1 commit (`plugins/index.js` import + named export + slug alias); Step 3 verified the full enable chain and closed one real gap the plan missed — the admin agent-skills UI and the chat Tools menu list skills from hardcoded frontend registries, so without a frontend entry the skill could never be toggled on anywhere. Changes:

- `frontend/src/pages/Admin/Agents/skills.jsx` — added a `venice-image-generate` entry to `getConfigurableSkills()` (title/description via the new `agent.skill.imageGeneration` i18n keys, `GenericSkillPanel` component — it is a pure-toggle skill with no config, same panel as `create-chart` and `terminal-access` — and the `Image` phosphor icon aliased to `ImageIcon`). Being in `configurableSkills` wires it into both the **admin Agent Skills page** (list card + On/Off toggle writing `default_agent_skills`) and the **chat Tools menu** Agent Skills section (`useAgentSkillsState` treats every configurable skill as enabled-iff-present-in-`default_agent_skills`), matching the server's `agentSkillsFromSystemSettings()` exactly.
- `frontend/src/locales/en/common.js` — added `agent.skill.imageGeneration.title` / `.description`.

**Deviations from the original draft:**

- **Frontend change required after all (N7 amendment):** the plan's "no frontend changes required" held for download cards and File Explorer previews (Step 2 covered those), but NOT for the enable surface — the admin agent-skills UI and chat Tools menu enumerate skills from `frontend/src/pages/Admin/Agents/skills.jsx`, which is a hardcoded registry, not a reflection of `plugins/index.js`. Without this entry the skill is registerable server-side but invisible/unreachable in every UI. Recorded as a deviation; spec N7 amended to "no frontend changes beyond skill-registry + locale entries and the Step 2 download-card support".

**Smoke-test evidence (2026-10-20):**

- Registration contract (0.7) re-verified live: `AgentPlugins.veniceImage` resolves; `AgentPlugins['venice-image-generate'] === AgentPlugins.veniceImage` (slug alias); `plugin().setup` registers both tools (`generate-image`, `list-image-styles`) via `aibitat.function()`; `generate-image` description carries the F11 refine-and-confirm mandate incl. the "Always allow" clause; `required: ['prompt']`.
- Opt-in verified against the **live DB**: `default_agent_skills` = `['terminal-access','filesystem-agent','web-browsing']` — no venice entry. `DEFAULT_SKILLS` in `defaults.js` does not name it either, so the skill is off until an admin enables it (F8).
- Enable chain simulated against the **live DB**: appended `venice-image-generate` to `default_agent_skills` via `SystemSettings.updateSettings` → `agentSkillsFromSystemSettings()` returns it (full list emitted `web-scraping, terminal-access, filesystem-agent#* ×10, web-browsing, venice-image-generate`) → `#attachPlugins` resolves it via `AgentPlugins.hasOwnProperty` → plugin loads. DB restored to the original 3-skill set afterward (verified).
- Per-user whitelist path ("Always allow", AC16) verified against the **live DB**: `AgentSkillWhitelist.add('venice-image-generate', 9999)` → `isWhitelisted` true for user 9999, **false for user 13** (per-user scoping) → same for real user 6. Test settings rows deleted afterward (verified null). This is the exact check `websocket.js#requestToolApproval` runs, so a whitelisted user's gate auto-approves with no card.
- Env auto-approve path verified: `AGENT_AUTO_APPROVED_SKILLS=venice-image-generate` and `=<all>` both make `skillIsAutoApproved` return true; unset → false.
- Translation verify diffed before/after the change: identical output (the checker's pre-existing `importData` noise is unchanged); no new missing keys in any of the 24 non-en locales (they fall back to en by design).
- `npx eslint` clean on both frontend files; `npx vite build` succeeds; `npx jest server/__tests__` → **42 suites / 326 tests, all green** (unchanged from Step 2).

---

## Step 4 — Tests

**Status:** Complete (2026-10-20)

- `server/__tests__/utils/agents/aibitat/plugins/venice-image.test.js` (CJS, Jest):
  - `pricing.quote` unit tests: 1 variant → `COST_PER_IMAGE`, 4+ variants capped at ×4, quote and debit both read the same module constant (F12, F13, N4).
  - Tool-description contract test: description contains the refine-and-confirm mandate and a quote instruction (AC10's unit-testable half).
  - `buildRequestBody` unit tests: sizing-idiom exclusivity (F1), no `model` parameter accepted, deprecated-field exclusion, format/variants defaults, `return_binary: false` always (F9).
  - `sanitizeSlug` unit tests: traversal (`../../x`), unicode, newlines → safe slug (AC9).
  - `generate` error mapping: mocked fetch for 400/401/402/429/503 (AC5).
  - `saveToSandbox`: mocked `FilesystemManager` — asserts `validatePath` is called with `images/…` and the write lands inside the sandbox root; cross-user assertion (AC3) via distinct `userId`s.
  - Handler billing tests (mocked `Credits` model): insufficient balance → no fetch, no debit (AC11); success with `userId` → exactly one debit of `quote(params)` with `venice-image-generate:<requestId>` reference (AC12); Venice failure after pre-flight → no debit (AC13); `userId == null` → no `hasCredits`, no `debit` (AC14).
  - Approval-gate tests (AC8, AC15): gate invoked **before** fetch/hasCredits with payload containing `prompt` + `credit_quote`; rejected gate → no fetch, no debit, rejection message returned; timeout treated as rejection (mock resolves `{ approved: false }`); whitelisted/auto-approved path still calls `requestToolApproval` (the gate itself short-circuits) and proceeds (AC16).
  - Refine-and-confirm description contract (AC10, AC17): the tool description string contains the refine-and-present instruction AND the "always present the refined prompt + credit quote before generating, even when auto-approved" clause — the F11 contract must hold for "Always allow" users too.
  - Handler tests: no-key disabled message (AC4), variants loop saves N files + emits N cards (AC6), approval gate called when present (AC8), gate rejection short-circuits with no fetch and no debit (AC15).
- One AC → one named test per the doc-first checklist.

**What was implemented:** `server/__tests__/utils/agents/aibitat/plugins/venice-image.test.js` (CJS, Jest, 31 tests / 10 suites, all green). Mocking strategy: `filesystem/lib.js` is mocked with a lightweight sandbox stand-in exposing the same `validatePath` contract rooted at a unique temp dir (no dependency on `~/totem-llm/`); `models/credits` + `models/user` are jest mocks (no Prisma/DB); `global.fetch` is a jest mock — **zero real Venice spend** (risk-table row "real API spend during testing"). Handlers are invoked directly against a stub `aibitat` (`function()` capture, controllable `this.super` with `requestToolApproval`/`socket.send`/`registerOutput`/`introspect` jest mocks).

Coverage by plan bullet:

- **pricing.quote unit tests (F12, F13, N4):** 1 variant → `COST_PER_IMAGE`; 4+ capped at ×4; string/non-numeric variants coalesce to 1; plus a divergence guard — the handler's actual debit call is asserted equal to `pricing.quote(params)` for the same params (quote and debit read one module constant).
- **Tool-description contract (AC10, AC17):** the `generate-image` description contains refine / present / credit / wait / "never call this tool" AND the "Always allow" + "every user" clauses.
- **buildRequestBody (F1, F9, F13):** aspect-idiom drops width/height; both-idioms-supplied case asserts the invariant that the outgoing body never carries both; `model` not overridable (always `z-image-turbo`); no `inpaint` field; defaults (`format: png`, `return_binary: false` always even when the caller tries to flip it, `variants` omitted at 1, capped at 4).
- **sanitizeSlug (AC9):** traversal (`../../etc/passwd`, backslashes) → safe flat slug; emoji/unicode/newlines/quotes → `^[a-z0-9-]+$` only, ≤48 chars; empty/hostile-only input → placeholder `image` slug in `buildFilename`.
- **generate error mapping (AC5):** mocked fetch for 400 (surfaces API content-policy string), 401, 402, 429, 503, and network failure — each mapped to its human-readable message.
- **saveToSandbox (AC3, N1, AC9):** writes land inside the requesting user's sandbox under `images/` (verified on disk via the mocked sandbox root); another user's and a third user's sandbox both get `Access denied` on the first user's image path; `../escape.png` traversal is rejected and nothing lands outside the root.
- **Handler billing (AC11–AC14 + F14 amendment):** insufficient balance → no fetch, no debit, human-readable message (AC11); success → exactly one debit of `quote(params)` with reference `venice-image-generate:req_test_123` (AC12); Venice 503 after pre-flight → no debit, "No credits were charged" (AC13); `userId == null` → no `hasCredits`, no `debit`, no admin lookup (AC14); admin role → billing-exempt (F14 amendment).
- **Approval gate (AC8, AC15, AC16):** gate invoked **before** fetch and pre-flight (asserted via `invocationCallOrder`) with payload carrying `prompt` + `credit_quote` and a description naming the cost (AC8); rejected gate → no fetch, no pre-flight, no debit, rejection message returned verbatim (AC15); timeout-as-rejection shape (`{ approved: false, message: "…timed out…" }`) short-circuits identically (AC15); auto-approved gate shape still flows through the gate call and proceeds with billing (AC16).
- **Availability + outputs (AC4, AC6):** unset `VENICE_API_KEY` → disabled message, no fetch, no debit, gate never invoked (AC4); 3-variant run → exactly 3 files on disk with `-1/-2/-3` suffixes in a **fresh per-user sandbox dir** (unique userId per test so the listing is exact), 3 `fileDownloadCard` emits + 3 `ImageDownload` outputs all carrying `sandboxFile: true` and `images/`-relative `storageFilename`, one debit of `quote({variants:3})` with the Venice request-id reference (AC6).
- **list-image-styles (F7):** names extracted from a mocked `/image/styles` payload, endpoint URL asserted.

**Deviations from the original draft:** *(none — all planned test categories shipped; two minor mechanical choices: (1) the plugin's modules are require-path-mocked rather than `jest.spyOn`'d, and (2) the AC6 saved-file listing uses a unique per-test userId instead of diffing directory state, eliminating cross-test contamination.)*

**Smoke-test evidence (2026-10-20):**

- `npx jest server/__tests__/utils/agents/aibitat/plugins/venice-image.test.js --collectCoverage=false` → **31 passed / 31**.
- Full server suite regression: `npx jest server/__tests__ --collectCoverage=false` → **43 suites / 357 tests, all green** (was 42 suites / 326 tests; +1 suite, +31 tests).
- No real network access: `global.fetch` is mocked for every test in the file — no Venice spend, no key usage (risk-table row "real API spend during testing" mitigated as planned).
- Test file is inside the server package's existing eslint ignore pattern for `__tests__` (lint run: 0 errors, file ignored by design) — consistent with the rest of the suite.

---

## Step 5 — Manual end-to-end verification

**Status:** Planned

With `TOTEM_BUILD_PROFILE=source yarn dev:all` (source profile required for agent features):

1. Enable the skill for the workspace/user via admin whitelist.
2. Prompt: *"Generate an image of a lighthouse at dusk, 16:9"* → verify the agent **presents a refined prompt + credit quote and does not call the tool** (AC10, first half) → confirm → verify: approval card appears (skill not yet whitelisted) showing the prompt and cost → approve → request shape in server logs (model is `z-image-turbo`, no `inpaint`, no `width`+`aspect_ratio` together), file at `users/<id>/images/<ts>-lighthouse-at-dusk.png`, download card renders, File Explorer shows the image, one debit row in `credit_transactions` matching the quoted amount (AC12).
3. Reject the approval card on a second run → verify no fetch, no debit, rejection message relayed (AC15).
4. Click "Always allow" on the card (or whitelist the skill in admin) and re-run → verify the card is skipped (auto-generate opt-in, AC16) while billing still works; verify the agent **still** presents the refined prompt + quote and waits for confirmation before invoking (AC17) — "Always allow" removes the card, not the conversation.
5. To restore card-on-every-generation, remove the skill from the user's whitelist in the admin panel and re-run → card returns.
6. Prompt with a style preset discovered via `list-image-styles`.
7. Unset `VENICE_API_KEY` in a scratch run → disabled message (AC4).
8. AC9 hostile-prompt filename check.
9. Billing checks (multi-user): (a) set a test user's balance below the quote via `POST /credits/grant-test` → confirm generation fails with the insufficient-credits message, no fetch to Venice, no transaction row (AC11); (b) force a Venice 503 (mock or bad-key-with-balance) after a passing pre-flight → verify no debit (AC13); (c) single-user scratch install → verify no `hasCredits`/`debit` calls (AC14).

**Deviations from the original draft:** *(none yet)*

**Smoke-test evidence:** *(pending)*

---

## Risk table

| Step | Risk | Level | Mitigation |
|------|------|-------|------------|
| 1 | Binary write bypasses a `FilesystemManager` text-oriented helper; path validation subtleties | Medium | Every write routed through `validatePath` first (defense-in-depth over construction-time sanitization); AC9 test is the merge gate for this step |
| 1 | Refine-and-confirm is instruction-level only; a non-compliant LLM could generate without presenting prompt/quote | Medium | F11 explicitly documented as soft enforcement; the approval card (F10) is the hard layer for users who have not opted into auto-generation; AC10/AC17 cover the description-contract test |
| 1 | Mis-pinned `COST_PER_IMAGE` (guessed instead of read from Venice `/models`) would over/under-charge users | Medium | Step 1 requires recording the API-returned price in the plan before merging; quote and debit read one constant so they cannot diverge (N4) |
| 1 | Debit/pre-flight race lets a concurrent spend overdraw slightly | Low | Accepted (same exposure as chat-turn billing); `Credits.debit` caps at available balance, never negative |
| 2 | Download card dead-link risk (generated-files endpoint can't serve sandbox files) | **Resolved (2026-10-20)** | Step 2 routes sandbox cards through the existing `GET /filesystem/read?raw=true` endpoint; covered by 2 new endpoint tests (image streaming + cross-user 404) |
| 1 | "Always allow" users get no approval card, so spend relies on the conversational contract (F11) | Accepted (by design) | User explicitly opted into auto-generation; F11 refine-and-confirm + quote still mandatory in conversation (AC17), F14 billing still runs in every mode; opting out (admin whitelist removal) restores the card |
| 2 | `fileDownloadCard` frontend expects `generated-files` semantics | **Resolved (2026-10-20)** | `FileDownloadCard` now branches on the `sandboxFile` flag; legacy payloads (no flag) take the unchanged `generated-files` path — verified by payload-parse smoke test |
| 3 | Plugin registration is mechanical but touches the shared plugin index (all skills) | Low, mechanical | Single-line additions following the verified 0.7 contract; Step 4 test suite is the merge gate |
| 3 | Skill registered server-side but missing from the hardcoded frontend skill registry — admin UI and Tools menu could never enable it | **Resolved (2026-10-20)** | Step 3 added the `venice-image-generate` entry to `frontend/src/pages/Admin/Agents/skills.jsx` + en locale keys; enable chain verified end-to-end against the live DB (see Step 3 evidence) |
| 4 | Handler-contract drift: tests written against the plugin's real code caught two doc-level assumptions (gate is optional via `requestToolApproval` presence; both-idiom conflict resolves to aspect_ratio) | Resolved (2026-10-20) | Step 4 suite encodes the implemented behavior; full server suite green (43/357) |
| All | Accidental key leakage in error messages | Low | Never interpolate `VENICE_API_KEY` into errors; follow web-browsing's truncation discipline if key-bearing params ever appear in an error |

## PR / status log

| PR | Scope | Status |
|----|-------|--------|
| — | Steps 1–5 (single PR: `feat(agents): venice-image-generate skill with credits billing + refine-and-confirm flow`) | Planned |
