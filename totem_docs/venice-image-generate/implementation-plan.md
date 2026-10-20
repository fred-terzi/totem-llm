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

**Status:** Planned

Emit `fileDownloadCard` + `registerOutput(this.super, "ImageDownload", …)` per image (pattern verified in 0.5), with payload `{ filename: <sandbox-relative display name>, storageFilename: <sanitized storage name>, fileSize }`.

**Deviations from the original draft:**

- **Correction to Step 2 (from Step 0 finding 0.6):** `agentFileServer.js` only serves `storage/generated-files/` with `{fileType}-{uuid}.{ext}` names. For sandbox images the card must deep-link to the File Explorer's file view for the image's sandbox path (already shipped in the file-explorer workstream), so the user clicks through to the image preview and downloads from there. If, during implementation, the file-explorer route is not addressable from the agent socket payload, fall back to adding a narrow authenticated read endpoint for sandbox files under `/api/agent-skills/sandbox-file/` — decided at implementation time, recorded here either way.

**Smoke-test evidence:** *(pending)*

---

## Step 3 — Registration + whitelisting

**Status:** Planned

- `plugins/index.js`: import `veniceImage`, add named export and `[veniceImage.name]` alias (verified contract, 0.7).
- Confirm the skill appears in the admin agent-skills UI and is opt-in (not in `default_agent_skills`).
- No frontend changes required (N7): download cards and File Explorer image previews already render.

**Deviations from the original draft:** *(none yet)*

**Smoke-test evidence:** *(pending)*

---

## Step 4 — Tests

**Status:** Planned

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

**Deviations from the original draft:** *(none yet)*

**Smoke-test evidence:** *(pending)*

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
| 2 | Download card dead-link risk (generated-files endpoint can't serve sandbox files) | High (user-visible) | Identified in Step 0 (0.6); Step 2 resolves the link target before merge; card must never render without a working target |
| 1 | "Always allow" users get no approval card, so spend relies on the conversational contract (F11) | Accepted (by design) | User explicitly opted into auto-generation; F11 refine-and-confirm + quote still mandatory in conversation (AC17), F14 billing still runs in every mode; opting out (admin whitelist removal) restores the card |
| 2 | `fileDownloadCard` frontend expects `generated-files` semantics | Medium | Verify against file-explorer card rendering during Step 2 smoke test; payload keys kept identical to create-files pattern |
| 3 | Plugin registration is mechanical but touches the shared plugin index (all skills) | Low, mechanical | Single-line additions following the verified 0.7 contract; Step 4 test suite is the merge gate |
| 4–5 | Real API spend during testing | Low | Use cheapest model (`z-image-turbo`) for smoke tests; single-image runs only |
| All | Accidental key leakage in error messages | Low | Never interpolate `VENICE_API_KEY` into errors; follow web-browsing's truncation discipline if key-bearing params ever appear in an error |

## PR / status log

| PR | Scope | Status |
|----|-------|--------|
| — | Steps 1–5 (single PR: `feat(agents): venice-image-generate skill with credits billing + refine-and-confirm flow`) | Planned |
