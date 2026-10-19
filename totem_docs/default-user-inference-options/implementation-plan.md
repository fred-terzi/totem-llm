# Default-User Inference Options — Implementation Plan

> Companion to [`requirement-spec.md`](./requirement-spec.md). All paths are relative to repo root. Requirement IDs (F# / N#) refer to the spec. This plan is a journal: steps record what was implemented as it happened; deviations are documented in place, not silently rewritten.

**Spec anchors verified (2026-10-19):**

| Claim | Where | Verified |
|---|---|---|
| Agent-path provider resolution + fallback chain | `server/utils/agents/index.js:463` (`#providerSetupAndCheck`), `:401` (`#getFallbackProvider`), `:428` (`#fetchModel`) | ✅ |
| Agent invocation decision (automatic mode) | `server/utils/agents/index.js:56` (`isAgentInvocation`) → `Workspace.supportsNativeToolCalling` (`server/models/workspace.js:659`) | ✅ |
| Credit gate, both stream endpoints | `server/endpoints/chat.js:47`, `:140` | ✅ |
| Agent-path debit site (only debit call site) | `server/utils/agents/aibitat/plugins/chat-history.js:247` (`_debitCredits`) → `Credits.debitUsage` | ✅ |
| `debit()` skips `amount <= 0` (no ledger row) | `server/models/credits.js:121` | ✅ |
| Single-model hardcoded rates | `server/models/credits.js:16-19` (`MODEL`, `INPUT_RATE`, `OUTPUT_RATE`, TODO comment) | ✅ |
| `workspaces` table fields, no option column yet | `server/prisma/schema.prisma:121-153` (`chatProvider`, `chatModel`, `agentProvider`, `agentModel`) | ✅ |
| `/update` is admin/manager-gated | `server/endpoints/workspaces.js:72-73` | ✅ |
| `OpenRouterLLM` throws without key | `server/utils/AiProviders/openRouter/index.js:32` | ✅ |
| Provider tool-calling support: Venice capability-based, OpenRouter env-gated | `server/utils/agents/aibitat/providers/venice.js:57`, `server/utils/agents/aibitat/providers/openrouter.js:51` | ✅ |
| `system_settings` is label/value KV | `server/prisma/schema.prisma:49-55` | ✅ |

---

## Step 0 — Investigation (no code)

**Status: complete (2026-10-19)**

### Findings

| # | Question | Finding | Citation |
|---|---|---|---|
| 1 | Full agent invocation chain + where role is available | Chain confirmed: `chat.js` POST → `streamChatWithWorkspace` → `grepAgents()` (`server/utils/chats/stream.js:43`) → returns `websocketUUID` to client → client opens WS `/agent-invocation/:uuid` → `new AgentHandler({uuid}).init()` (`server/endpoints/agentWebsocket.js:24`) → `#validInvocation()` → `#providerSetupAndCheck()` (`server/utils/agents/index.js:720-725`, `:463`). `invocation` (from `WorkspaceAgentInvocation.getWithWorkspace`, `server/models/workspaceAgentInvocation.js:54-66`) carries **`user_id` only, not role**. Role must be fetched: `User.get({ id: invocation.user_id })` — exactly the pattern `chat-history.js:_debitCredits` already uses (`chat-history.js:265`). Cost: one indexed PK lookup per agent session (init runs once per invocation, not per turn/token). Acceptable; no schema change needed. |
| 2 | Venice slugs support native tool calling? | **LIVE-VERIFIED (2026-10-19, against api.venice.ai).** Both `z-ai-glm-5-3-flash` and `e2ee-glm-5-3-flash` return `tools: true` from `getModelCapabilities()` (`VeniceLLM.modelSpecs` populated from live `/models`; specs found for both slugs). `VeniceProvider.supportsNativeToolCalling()` delegates to this (`server/utils/agents/aibitat/providers/venice.js:57`) → **true**. Spec F3/F4 assumption holds. |
| 3 | `metrics.model` plumbing | Chain confirmed: aibitat provider stamps `lastUsage.model = this.model` (`server/utils/agents/aibitat/providers/ai-provider.js:639`) → `chat-history.js` reads `lastCall.model` into `metrics.model` (`chat-history.js:121`) → `_debitCredits(invocation, prompt_tokens, completion_tokens, metrics.model, chatId)` (`chat-history.js:148-153`, `:224-229`) → `Credits.debitUsage({ model })`. So if the F12 override sets `this.model` on the handler → AIbitat config → `providerInstance.model`, the billing slug is correct automatically (F6 works with zero changes to the debit site). |
| 4 | Where `OPENROUTER_API_KEY` presence is readable for F14 | No existing payload carries it. `GET /setup-complete` → `SystemSettings.currentSettings()` (`server/endpoints/system.js:107-116`, `systemSettings.js:456`) is what the frontend's `System.keys()` consumes, but it is **unauthenticated** and a large config dump — adding a key-presence boolean there works but is an odd fit. The picker's workspace data comes from `GET /workspace/:slug` (`server/endpoints/workspaces.js:365`, `ROLES.all`). **Decision: dedicated authenticated availability endpoint** (new, in `system.js` or `workspaces.js`), per spec F14 — piggybacking on `/setup-complete` would leak option availability pre-auth. |
| 5 | Prisma migration workflow | Verified: `yarn prisma:generate` = `cd server && npx prisma generate`; `yarn prisma:migrate` = `cd server && npx prisma migrate dev --name init` (root `package.json:46-47`). A nullable `String?` with no default on `workspaces` is a plain `ALTER TABLE ... ADD COLUMN` in SQLite — no table rebuild (the rebuild pattern in `20261013170000_add_credit_usage_fields` was only needed because of FK/default constraints; we have none). Low risk. |
| 6 | Frontend selector + role branch | The chat-area picker is `WorkspaceModelPicker` (`frontend/src/components/WorkspaceChat/ChatContainer/WorkspaceModelPicker/index.jsx`) — currently **hard-hidden for every non-admin**: `if (!!user && user.role !== "admin") return null;` (`index.jsx:96`). Note this also hides it from managers (current behavior — preserved). Role is available via `useUser()` → `AuthContext` (`frontend/src/hooks/useUser.js`). The default-user branch renders a new option-picker component at this gate instead of returning null. Selection currently saves via `Workspace.update` → admin-gated `POST /workspace/:slug/update` — confirming F13's new endpoint is required for default users. |

### New finding (not anticipated by the plan): OpenRouter tool-calling is env-gated, not capability-based

`OpenRouterProvider.supportsNativeToolCalling()` returns `false` unless `PROVIDER_SUPPORTS_NATIVE_TOOL_CALLING` (env) includes `"openrouter"` (`server/utils/agents/aibitat/providers/openrouter.js:51-56` → `ai-provider.js:160-172`). It does **not** query OpenRouter's `/models` capabilities. The env var is not set in this deployment's `.env.development`.

Live check (2026-10-19): the configured free slug `nvidia/nemotron-3.5-lightning:free` **does** advertise `tools: true` (context 1M) on OpenRouter's `/models` — so the model itself is agent-capable; only the code path is gated.

Consequence for Option 1 as configured: without the env flag, `Workspace.supportsNativeToolCalling()` returns false → `grepAgents` in automatic mode does not spawn an agent invocation → Option 1 chats run in the **standard chat mode path** (`stream.js` → `resolveLLMConnector`). The user approved this fallback ("fine for the free model"), but it means:

- **Correction to Step 3:** the F12 routing override must ALSO be applied in the standard chat path's connector resolution (`resolveProviderConnector`, `server/utils/helpers/index.js:650-664`) — not only in `AgentHandler.#providerSetupAndCheck()` — otherwise a default user on Option 1 in chat-mode fallback silently routes to the workspace/system provider instead of the free slug. Same guard (default role + option set), same registry lookup; applied after the existing router/system-default resolution. Gate-skip (F7) already covers this path (both gates in `chat.js`).
- Implementation may optionally set `PROVIDER_SUPPORTS_NATIVE_TOOL_CALLING=openrouter,...` at deploy time to force agent-path routing for Option 1 — behavior then matches Options 2/3. Either path satisfies the spec; chat-mode fallback is the default (no env change required).

**Output:** findings table above appended to this step (2026-10-19). One correction recorded (Step 3 scope: standard-chat-path override for Option 1). No other later-step assumptions invalidated.

---

## Step 1 — Prisma migration + data layer

**Status: complete (2026-10-19)**

### Implemented

- **Schema:** `user_inference_option String?` added to the `workspaces` model (`server/prisma/schema.prisma`) — nullable, no default, no index/relation (N4: NULL = legacy behavior).
- **Migration:** `20261019162057_add_user_inference_option` — verified to be the plain `ALTER TABLE "workspaces" ADD COLUMN "user_inference_option" TEXT;` predicted in Step 0. Applied to the dev DB (`server/.env` points at `file:../storage/totem-llm.db` relative to `server/`, which resolves to `$HOME/totem-llm/totem-llm.db`); all 9 existing workspaces verified with `user_inference_option: null`. Prisma Client regenerated (v5.3.1).
  - **Environment gotcha (recorded):** `server/.env.development` points at a *different* SQLite file than `server/.env` in this checkout. `migrate deploy` against `.env.development` reported "no pending" only because that second DB is stale/unused — `prisma migrate dev` (which loads `.env` first) applied the migration correctly. Whoever touches migrations here should confirm which `.env` their shell is loading.
- **Data layer — `server/models/credits.js` (billing-core refactor):**
  - Single `MODEL`/`INPUT_RATE`/`OUTPUT_RATE` constants + the old TODO replaced with a per-model `MODEL_RATES` map: `z-ai-glm-5-3-flash` (0.5/1.0, OQ-11), `e2ee-glm-5-3-flash` (0.5/1.0), `nvidia/nemotron-3.5-lightning:free` (0/0 — the free slug, MUST stay zero while configured).
  - New `ratesForModel(model)` — exact-slug lookup, unknown/undefined/null slugs fall back to `DEFAULT_MODEL` (=`e2ee-glm-5-3-flash`) rates. Fail-closed per N7: an unknown slug can never bill at 0.
  - `calculateCost(inputTokens, outputTokens, model = DEFAULT_MODEL)` — third param added; existing two-arg call sites are unchanged in behavior (backwards compatible).
  - `debitUsage` passes the model through to `calculateCost` and to the ledger row's `model` field; zero-rate models cost 0 → existing early-return (`cost <= 0`) yields **no `credit_transactions` row** (F6/OQ-14) with zero extra code, as predicted.
  - Exported `ratesForModel`, `DEFAULT_MODEL`, `MODEL_RATES` for tests/admin reuse.
  - Call-site audit: the only `debitUsage` caller is `chat-history.js:266` (signature unchanged); `credits.js` endpoint + `system.js` welcome-bonus untouched.
- **Data layer — `server/models/workspace.js`:**
  - New `setInferenceOption(slug, optionKey | null)` — the only sanctioned write path for the column; bumps `lastUpdatedAt`; validates `optionKey` is `null` or string (allowlist validation itself lives in the Step 2 registry, which this helper's docs reference). Returns `{ success, message }` per the file's error-shape convention.
  - Deliberately **not** added to `writable`/`validations`: a forged generic `/update` body can never set `user_inference_option` (spec F13 — default users write option keys only, never raw provider values).

### Tests

`server/__tests__/models/credits.test.js` extended 6 → 23 tests, all passing:
- per-model lookup (e2ee, anon, free slugs); unknown/undefined/null slug → `DEFAULT_MODEL` fallback that is asserted to be **non-zero** (AC 15 / N7);
- free slug at exactly 0 for arbitrary token counts (AC 14 — `debitUsage` early-return → no ledger row);
- backwards-compat two-arg `calculateCost`; ceil-per-token-type preserved under per-model rates.

Environment note: root `node_modules` was production-only in this checkout (`NODE_ENV=production` at install time), so `jest`/`babel` were missing from `.bin` — fixed with a dev-mode `yarn install --ignore-scripts`; `yarn.lock` restored to committed state afterward (no lockfile changes in the commit).

---

## Step 2 — Option configuration + read/write endpoints (F11 server side, F13, F14)

**Status: complete (2026-10-19)** — commit `feat(server): inference option registry + read/write endpoints` (dev-totem)

### Implemented

- **Registry — `server/utils/inferenceOptions.js` (new module):**
  - `INFERENCE_OPTIONS`: the three options in picker order (`totem-free`, `totem-anon`, `totem-e2ee`) with label, description, provider id (`openrouter` / `venice` / `venice`), `system_settings` label (`default_user_inference_option_{free,anon,e2ee}`), fallback slug, and `isAvailable()` (F14: Option 1 requires `OPENROUTER_API_KEY`, Options 2/3 require `VENICE_API_KEY`).
  - `resolveOption(optionKey)` → `{ option, provider, model }` — reads the configured slug from `system_settings` **per request** (N6: admin slug changes apply without restart); null for unknown/null keys → callers fall back to legacy routing (OQ-4).
  - `getOptionSlug` seeds the fallback slug into `system_settings` on first read (upsert via `SystemSettings._updateSettings`) — verified: after first read all three rows exist with the F11 initial slugs.
  - `isValidOptionKey` (F13 allowlist), `listInferenceOptions(includeSettingLabel)` (F14 payload; label only in the admin variant), `setOptionSlugs` (F11 write, partial-map, rejects empty/unknown keys).
- **F13 write endpoint — `POST /workspace/:slug/inference-option`** (`server/endpoints/workspaces.js`): middleware `[validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug]`. Allowlist validation runs before the membership check (uniform 400 for unknown keys, AC 12). Membership enforcement reuses `validWorkspaceSlug`'s `Workspace.getWithUser` resolution — for default-role users this already joins on `workspace_users` (non-member ⇒ 404, no write); admins bypass via `Workspace.get`. Body accepts only `option`; write goes through `Workspace.setInferenceOption` (Step 1 helper). Logs `inference_option_set` to `EventLogs` (audit trail). `/update` remains admin/manager-only and untouched.
- **F14 read endpoint — `GET /workspace/:slug/inference-options`** (same router): returns `{ success, options: [{key,label,description,provider,model,available}], selected }`. `selected` comes from the just-resolved workspace row, so the picker reflects the persisted selection. Deliberately **workspace-scoped and authenticated** per the Step 0 decision (not `/setup-complete`, which is unauthenticated and would leak availability pre-auth). The `settingLabel` field is omitted from this payload — only the admin variant exposes it.
- **F11 admin API — `GET|POST /admin/inference-options`** (`server/endpoints/admin.js`, `strictMultiUserRoleValid([ROLES.admin])` — admin-only per spec F11): GET returns the full option list including current slugs + `settingLabel`s; POST accepts a partial `{ optionKey: slug }` map, validates via the registry, writes `system_settings`.

### Deviations / decisions made during implementation

- **Read endpoint placed in the workspaces router, not `system.js`:** it needs `validWorkspaceSlug` (to return the workspace's `selected` option) and is consumed in the chat context; the plan left the choice of router open pending Step 0. Availability-only data is still carried in every response, so the picker has everything it needs from one call.
- **Admin POST returns 400 (not 200-with-error) for invalid payloads** so the admin UI can distinguish validation failure from success — consistent with how the registry's `setOptionSlugs` reports errors.

### Tests

`server/__tests__/endpoints/inferenceOptions.test.js` (new, 6 tests, all passing) — same harness pattern as `invite.test.js` (throwaway SQLite DB with full migration history; `updateENV` stubbed per `adminUserEmail.test.js` to avoid the transitive AWS-SDK load; handlers captured via a fake app and invoked with `response.locals.workspace` pre-set the way `validWorkspaceSlug` hands them over):
- happy-path write + persistence (member, valid key, AC 12);
- all three keys persist, `null` clears the selection (F5/N4);
- unknown keys — including provider/model injection attempts like `openrouter|nvidia/…` — 400 and write nothing (AC 12);
- non-member scoping: `Workspace.getWithUser` resolves null for an outsider and the handler 404s with no write;
- availability payload shape: three options in registry order, current slugs, boolean `available`, `selected` reflects the persisted write, and **no `settingLabel` leak** in the member payload (F14);
- `selected` is null for never-selected workspaces (legacy, N4).

Registry smoke-checked live (key-gating flips correctly with/without the API keys; resolve/allowlist/seed behaviors verified against the dev DB). Full suite after Step 2: **42 suites / 326 tests passing**.

---

## Step 3 — Agent-path routing override (F12) + credit-gate skip (F7)

**Status: complete (2026-10-19)** — commit hash recorded in the status log below (push-time verified)

> **Step 0 correction applies:** the override below has TWO insertion points —
> (a) `AgentHandler.#providerSetupAndCheck()` for the agent path, and
> (b) `resolveProviderConnector()` (`server/utils/helpers/index.js:650-664`) for the standard chat path
> (which Option 1 hits when `supportsNativeToolCalling()` is false for the free model). Same guard, same registry.

- In `server/utils/agents/index.js` `#providerSetupAndCheck()` (line 463): before the `agentProvider ?? …` resolution, if the invocation's user is resolvable with role `default` **and** `workspace.user_inference_option` is set, resolve (provider, model) via the Step 2 registry and assign to `this.provider`/`this.model`, bypassing the fallback chain and the `anythingllm-router` resolution. Errors resolving the option (slug unset, provider check failure) fall back to the existing chain and log — the user sees the standard error shape (N5).
- In `server/endpoints/chat.js` (both gates at `:47` and `:140`): skip `Credits.hasCredits()` when `user.role` is default **and** `workspace.user_inference_option === "totem-free"` (AC 5). All other branches unchanged (AC 6).
- Do **not** touch `supportsNativeToolCalling()` (F15) or `chat-history.js` (F6 — model-keyed rates in Step 1 make the existing debit correct automatically).

**Tests:** unit tests around `#providerSetupAndCheck` (option set → override wins over `agentProvider`; option NULL → legacy chain; non-default role → legacy chain; unknown option → fallback). Gate-skip tests for both chat endpoints.

---

## Step 4 — Upstream 429 mapping (F8)

**Status: complete (2026-10-19)**

### Implemented

- **Shared detection/mapping module — `server/utils/freeModelRateLimit.js` (new):**
  - `isUpstreamRateLimitError(error)` — narrow 429 detection matching the OpenAI-SDK shapes both OpenRouter code paths surface: explicit `status === 429`, `name === "RateLimitError"`, or an SDK-generated `429 …` message prefix. Other failures never match.
  - `freeOptionRateLimitError(error, model)` — throw-site gate: returns a new Error carrying the stable marker **only** when the caught error is a 429 **and** the affected model is the *currently configured* free-option slug (checked per request against `system_settings` via the new registry helper `isConfiguredFreeSlug`). Anything else (other models, unknown/null model, registry failure) returns null so the caller's existing error handling runs — fail-closed to the standard error shape (N5), and a rate limit on a *paid* OpenRouter model is never mis-mapped to the free-option wording.
  - Marker is a plain substring (`[totem_free_model_rate_limited]`) embedded in `error.message` rather than a custom error class: the agent path stringifies errors twice on the way to the socket (provider catch → `RetryError`/`APIError` wrapping in AIbitat `#safeProviderCall` → `error.message` over the wire), and a class would not survive that round-trip.
  - `mapFreeModelRateLimitMessage(message)` — client-facing mapping: marker-carrying messages become the **exact F8 wording** (replacing any surrounding wrapper text such as "The agent model failed to respond: …"); everything else passes through unchanged.
- **Throw sites (where the upstream error is caught first):**
  - Aibitat agent provider (`server/utils/agents/aibitat/providers/openrouter.js`): both `stream()` and `complete()` catch blocks call the gate **before** the existing `AuthenticationError`/`RetryError` classification, so a free-option 429 is rethrown marked while every other error keeps the existing classification.
  - LLM connector (`server/utils/AiProviders/openRouter/index.js`): `getChatCompletion` and `streamGetChatCompletion` now wrap the upstream call and map through the same gate (previously the non-streaming call flattened all errors via `.catch(e => new Error(e.message))` — that flattening is gone so the SDK error shape reaches the gate). `handleStream`'s mid-iteration catch (stream 429s can surface there) maps the abort chunk's `error` field the same way.
- **Client-facing mapping points (where agent/chat errors reach the client):**
  - Aibitat `websocket` plugin `onError` (`server/utils/agents/aibitat/plugins/websocket.js`) — the `wssFailure` socket message for agent sessions. This is the path default users on Option 1 hit in agent mode.
  - `chat.js` catch blocks for both SSE stream endpoints (`/workspace/:slug/stream-chat`, `/workspace/:slug/thread/:threadSlug/stream-chat`) — the standard chat-path fallback Option 1 uses when native tool calling is env-gated off (Step 0 correction).
- **Registry addition:** `isConfiguredFreeSlug(model)` in `server/utils/inferenceOptions.js` — per-request comparison against the configured free slug; resolution errors → false.
- **Scope check:** credits are untouched on the 429 path — the debit only runs after a successful completion (`chat-history.js` `_debitCredits`), so a rate-limited chat produces no charge and no ledger row (AC 7 second clause). No per-user counter or stored quota introduced (N2).

### Tests

`server/__tests__/utils/freeModelRateLimit.test.js` (new, 15 tests, all passing) against the real module with `system_settings` mocked at the DB boundary: detection shapes (status/name/message-prefix, non-429 negatives incl. null/undefined); throw-site gate (429 on configured free slug → marker; 429 on other/unknown/null model → null; non-429 on free slug → null; registry failure → null, N5); client mapping (marker → verbatim F8 wording asserted character-exact; wrapper text does not defeat the match; unmapped passthrough incl. null/undefined; the marker can never leak raw); wiring consistency (option key matches `chat.js`, marker survives a JSON string round-trip as sent over the socket). Full suite after Step 4: **46 suites / 355 tests passing**.

### Notes

- `yarn lint` fails at HEAD in this checkout on **pre-existing** frontend errors (`react-hooks/refs` etc. in `PromptInput`, `ThreadItem`, `Memories`, `QuickActions` — verified identical on a clean stash of this step's changes). `npx eslint` over every touched server file is clean; not a Step 4 regression.
- Env-var-driven lazy require inside `mapFreeOptionRateLimit` (connector file) avoids a top-level circular import with the registry graph.

---

## Step 5 — Frontend picker (F1, F10, F14 consumer)

**Status: complete (2026-10-19)** — commit `4dcab67d` (dev-totem)

### Implemented

- **New component — `frontend/src/components/WorkspaceChat/ChatContainer/PromptInput/LLMSelector/InferenceOptionPicker/index.jsx`:**
  - Fetches the F14 payload via the new `Workspace.inferenceOptions(slug)` model method; renders exactly the three registry options in registry order (F1) with label, description, and the **reference model slug** (monospace, informational — never editable).
  - **Filters out unavailable options** (`option.available === false`) per F14/AC 13 — plus an empty-state message if *nothing* is available (e.g. no OpenRouter/Venice keys configured).
  - Marks the workspace's persisted selection from the payload's `selected` field — no reliance on the raw workspace object carrying `user_inference_option`, so **no workspace API response-shape change was needed** (the F14 endpoint is the single source of truth for both list and selection).
  - Selection is **apply-immediately** (optimistic update → `Workspace.setInferenceOption` → refetch so `selected`/slugs/availability reflect persisted state → toast on failure + revert). No separate save button — the F13 endpoint is a single-key write, unlike the provider/model modal's two-stage flow. `onSaved` callback lets the host close the panel.
  - Labels/descriptions come from the **server registry** (not i18n bundles) so F11 label changes flow through without a frontend release; only the surrounding chrome (title, loading, errors, shared-workspace note) is i18n'd.
  - **N1 wording check (labels reviewed against the trust boundary):** registry descriptions already avoid overclaiming — Option 2 says "not attributable to you upstream" (true — server API key, no user identity forwarded), Option 3 says "end-to-end encrypted private-compute endpoint" scoped to Venice's side, and both credit-billed options state "Credits are charged per token." Option 1's description carries the tool-support caveat ("may run without agent tools") and rate-limit warning. The picker adds a shared-workspace note ("applies to all of its members") matching F5's accepted workspace scoping.
- **Role branch — `WorkspaceModelPicker/index.jsx`:** the previous hard `return null` for non-admins is replaced with a two-way branch: `default`-role users get `InferenceOptionPicker` in the same chip popover (narrower, 420px vs 620px); admins keep `LLMSelectorModal` byte-for-byte unchanged (AC 9). Managers still get nothing (preserved pre-feature behavior — the picker was admin-only). The chip label for default users resolves from the fetched options list + persisted selection ("Select Model" until first selection). A stray-ref lint risk was avoided by hoisting `isInferenceOptionUser` above the effects that use it.
- **`LLMSelector/action.jsx`:** comment updated only — the admin gate is intentionally unchanged (the tooltip action is an admin surface; default users' entry point is the model chip).
- **Model methods — `frontend/src/models/workspace.js`:** `Workspace.inferenceOptions(slug)` (GET, F14) and `Workspace.setInferenceOption(slug, option)` (POST, F13 — option key or null only; the server rejects everything else).
- **i18n:** new `chat_window.inference_picker.*` keys added to `frontend/src/locales/en/common.js`. Other locales fall back to English per `fallbackLng` (same pattern the repo uses for new UI).

### Tests

No frontend test harness exists for components (`frontend/__tests__/` covers pure utils only; no `@testing-library/*` in `frontend/package.json`; root jest is `testEnvironment: node` with `.jsx` transform but no DOM renderer). Per the step's fallback provision: **manual smoke test recorded** — see checklist below; full server suite re-verified green at 46 suites / 355 tests (the F13/F14 endpoint contract the picker consumes is covered by the Step 2 endpoint tests). `npx eslint` clean on all touched frontend files; prettier clean.

Manual smoke checklist (to exercise in the Step 7 matrix):
1. Default user → chip shows current selection label (or "Select Model" when NULL) → popover shows exactly three options with slugs → unavailable options absent (toggle `OPENROUTER_API_KEY`) (AC 1, 13).
2. Select an option → chip updates, `workspaces.user_inference_option` persisted, subsequent chats route per F12 (AC 2–4, 11).
3. Admin opens the same chip → full provider/model selector unchanged (AC 9).
4. Manager → no chip (pre-feature behavior preserved).

---

## Step 6 — Admin UI for option slugs (F11 frontend)

**Status: not started**

- Add an admin page (candidate: a section under `frontend/src/pages/Admin/` following the existing panels' structure) presenting the three options with their current slugs and save actions against the Step 2 admin API. No rate editing (out of scope).

**Tests:** manual smoke test recorded; admin gating exercised via API tests in Step 2.

---

## Step 7 — Tests, smoke test, merge gate

**Status: not started**

- Full suite: `yarn lint && yarn test` from root (lint before test per repo convention).
- Manual smoke matrix (multiuser mode, source build profile, Venice + OpenRouter keys configured):
  1. Default user sees exactly three options; admin sees full selector (AC 1, 9).
  2. Option 1 chat end-to-end: routes to free slug, no 402 at zero credits, no ledger row, `metrics.model` = free slug (AC 2, 5, 14).
  3. Option 2/3 chats: routes to Venice slugs, correct per-model debits, 402 at zero credits (AC 3, 4, 6).
  4. Unselected workspace: pre-feature behavior (AC 8).
  5. Admin slug change via F11 page applies to an already-selected workspace without restart (AC 10).
  6. `agentProvider`-configured workspace: default user's selection wins (AC 11); admin user unaffected.
  7. 429 path (simulate upstream error) shows F8 wording (AC 7).
  8. Endpoint abuse: invalid key, non-member, unauthenticated (AC 12).
- This step is the **merge gate**: no PR merges with a failing matrix entry.

---

## Risk table

| Step | Risk | Level | Mitigation |
|---|---|---|---|
| 1 | `credits.js` rate-table refactor touches the billing core | Medium | Per-model map with e2ee fallback default (N7); existing `credits.test.js` extended before refactor merges; all other call sites unchanged (`debitUsage` signature stable) |
| 1 | SQLite migration on `workspaces` (large table) | Low | Additive nullable column only; no default, no index, no relation |
| 2 | Membership check on new endpoint too strict/loose | Medium | Reuse existing `validWorkspace` + explicit `workspace_users` check; endpoint tests cover non-member and cross-workspace cases (AC 12) |
| 3 | Override injected into `#providerSetupAndCheck` affects non-agent paths | Low | Method is only reachable via agent invocation; change is guarded on role + option presence; NULL option is a no-op branch |
| 3 | Role lookup per chat adds a User query | Low | Step 0 verifies whether `invocation` already carries enough identity; if a fetch is needed, it's one indexed PK lookup per agent session (not per token) |
| 4 | 429 detection couples to OpenRouter error shape | Low | Detection is narrow (status code / marker); unmapped errors keep the standard shape (N5) |
| 5 | Selector changes regress admin/manager picker | Medium | Role branch isolated; AC 9 in smoke matrix; no shared-component behavior change for privileged roles |
| 7 | Smoke matrix depends on live Venice/OpenRouter keys | Medium | 429 and routing paths unit-tested in Steps 3–4; live checks can use admin-configured test slugs |

---

## Step 8 — Blocker bugfix: model selector missing on mobile (F17)

**Status: complete (2026-10-19, uncommitted — PR pending)**

**Report:** in default multi-user mode on mobile — where most users are — the
model selector does not appear at all, so default users cannot reach the
inference-option picker (F1/F10) or admins the full selector. Requested fix: a
model-selection button on the top bar.

### Root cause

Not a regression of the feature — the component was never mobile-capable.
`WorkspaceModelPicker` had two hard gates: the original pre-feature
`if (isMobile) return null` (inherited from upstream AnythingLLM, where the
picker has always been desktop-only) survived Step 5, and the chip wrapper is
`hidden md:block absolute top-2 left-3/left-11` — positioned relative to the
*desktop sidebar* state, which does not exist on mobile (the mobile header,
`SidebarMobileHeader`, is a separate fixed bar with no left sidebar). Even
without the gate, an absolutely-positioned chip anchored to a nonexistent
sidebar would be misplaced. Net effect: on phones, neither role ever saw a
model selector.

### Implemented (single file: `frontend/src/components/WorkspaceChat/ChatContainer/WorkspaceModelPicker/index.jsx`)

- **Removed the mobile early-return.** `if (!slug || isMobile) return null`
  became `if (!slug) return null`. The manager-role gate above it is unchanged
  (managers still get nothing on any device).
- **Mobile button placement (the requested top-bar button):** on `isMobile`
  the chip renders as a **fixed button pinned to the top-right of the screen**
  (`fixed top-3 right-4 z-30`) — visually part of the `SidebarMobileHeader`
  top bar (h-16), sitting in its empty right slot (the header's center and
  right are empty spacers). The desktop branch is byte-identical to before:
  `hidden md:block absolute top-2 left-3/left-11` driven by the sidebar-open
  state. Branching on `isMobile` (the same `react-device-detect` signal every
  other mobile branch in the app uses) rather than Tailwind breakpoints keeps
  the two layouts independent — no responsive-class collision with the
  desktop positioning.
- **Popover anchoring on mobile:** the dropdown panel flips to
  `right-0` (desktop keeps `left-0`) so it opens leftward from the top-right
  button and stays on-screen.
- **Panel width clamping:** fixed desktop widths (`420px` option picker,
  `620px` full selector) are clamped on mobile to
  `w-[min(<fixed>,calc(100vw-24px))]` so the popover never overflows narrow
  viewports. Role-specific width selection is unchanged.
- **No behavior changes below the button:** the backdrop click-to-dismiss,
  role branching (default → `InferenceOptionPicker`, admin →
  `LLMSelectorModal`, manager → null), F16 agent-session teardown on save,
  chip-label resolution, and `SetupProvider` wiring are all untouched.
- The component renders in all three existing mount sites (`ChatContainer`
  empty + populated, `Main/Home`), and `SidebarMobileHeader` is already
  rendered in each of those trees on mobile — the fixed button overlays the
  header regardless of which mount is active.

### Verification

- `npx eslint` clean on the touched file; prettier clean.
- Desktop parity: the desktop class string is unchanged, so AC 1–14 desktop
  behavior (including admin/manager gating) is untouched.
- Manual smoke rows to add to the Step 7 matrix (below).

### Follow-up (2026-10-19, live-test failure and fix): picker still invisible on real mobile

The user reported the picker still missing on a phone with the dev server on
port 3000. Root cause: the Step 8 fix branched on `isMobile` from
`react-device-detect`, but the desktop chip's own `hidden md:block` Tailwind
classes still gate visibility by **viewport width** — and the two signals
disagree on exactly the surfaces where the button vanished:

- **DevTools responsive mode** (Chrome/Safari device emulation): `isMobile` is
  a user-agent sniff; an emulated generic device (and any desktop-UA WebView)
  reports `false`, so the code took the desktop branch, whose chip is
  `display: none` below 768px. Nothing rendered.
- **Landscape phone** (viewport ≥768px): opposite mismatch — `isMobile` true,
  so the fixed button appeared even though the desktop layout was active.

**Fix:** layout is now decided by `window.matchMedia("(min-width: 768px)")`
(a small `useIsDesktopViewport` hook, reactive to resize/orientation), with
`isMobile` kept only as an override so a landscape phone keeps the floating
top-bar button instead of the sidebar-anchored chip:
`const useMobileLayout = isMobile || !isDesktopViewport;`. Verified live:
Vite on :3000 serves the new module; eslint + prettier clean; desktop branch
still byte-identical (the desktop class string is unchanged).

### Follow-up 2 (2026-10-19, still invisible on a real phone — stacking-context bug)

After a hard refresh in a real phone browser the button was still absent.
User's report pointed at the recently-restyled `UserMenu` bar — that was the
right neighborhood, but the mechanism was subtler than a plain z-index loss:

- `UserMenu` (`frontend/src/components/UserMenu/index.jsx`) renders the
  badges row (`ChatSettingsMenu`, `TotemBalanceBadge`, `CreditBadge`,
  `FileExplorerButton`, `UserButton`) at `absolute top-3 right-4 … z-40` —
  the same top-right slot the fixed picker button targeted.
- The picker mounted **inside** the chat container tree, whose wrappers
  (`z-[2]` plus transition `transform`s and light-mode `border`/filter
  utilities) create a **local stacking context**. A position:fixed element
  inside a stacking context cannot escape it — its `z-30` only competed
  within that subtree, while the UserMenu bar's `z-40` is resolved against
  the root. The header bar and badges therefore painted over the button, and
  depending on the exact transform state the button could be fully covered.

**Fix (same file):** on the mobile layout the picker now renders through
`createPortal(picker, document.body)` — portalling out of the chat container
places the button and its popover in the **root stacking context**, where its
own `z-30` participates globally and sits above the `z-10` mobile header while
sibling-level `z-40` badges stay on top of nothing it overlaps (the button is
offset below them). Desktop keeps the in-tree render unchanged — the chip must
continue to anchor to the chat container and slide with the sidebar toggle, so
portalling there would break its positioning. Also moved the button from
`top-3` to `top-16` so it sits *below* the h-16 `SidebarMobileHeader` bar and
the UserMenu badges row instead of under/behind them. Verified: eslint +
prettier clean; Vite on :3000 serving the portal version (module source
curl-checked through the dev server).

### Smoke-matrix additions (Step 7, mobile rows)

9. Mobile, multi-user mode, default user: model chip button visible at the
   top bar's right (rendered via body portal, below the UserMenu badges);
   tap opens the three-option picker clamped to the viewport;
   selection persists and routes per F12.
10. Mobile, admin: same button opens the full provider/model selector.
11. Mobile, manager: no button (gate unchanged).
12. Desktop regression sweep: chip position/behavior identical to
    pre-fix builds (both sidebar states).
13. Mobile: picker button must not be covered by the `UserMenu` badges row
    (`z-40`) or the `SidebarMobileHeader` bar — validates the portal fix
    (stacking-context escape) across empty/populated chat and Home.
14. Mobile: open picker, rotate device / resize across the 768px breakpoint
    — layout flips cleanly between portal button and desktop chip, no
    duplicate render, no orphaned popover.

### Risk

| Risk | Level | Mitigation |
|---|---|---|
| Body-portalled button survives route transitions it shouldn't (stale chip after navigating Home ↔ Chat) | Low | Component unmounts with its tree, which unmounts the portal; mount sites already key the picker per view |
| Portal button overlaps UserMenu badges on small screens | Low | Button sits at `top-16 right-4`, below the badges row (`top-3 right-4`); both remain individually tappable |
| 620px admin selector on mobile feels cramped | Low | Width clamped to viewport; acceptable for a rare admin-on-phone flow |
| `isMobile` false-negative on tablet-width touch devices | Low | Same signal the rest of the mobile UI (`SidebarMobileHeader`) uses; a desktop-tablet user gets the desktop chip as before |

---

## PR / status log

| PR | Steps | Status |
|---|---|---|
| — | 0 | **Complete (2026-10-19)** — findings recorded; one correction to Step 3 (dual insertion point) |
| — | 1 | **Complete (2026-10-19)** — migration `20261019162057_add_user_inference_option` applied + verified; per-model rate table in `credits.js` (fail-closed N7, zero-rate free slug); `Workspace.setInferenceOption` write helper; credits tests 6→23 passing; full server test suite green (41 suites / 320 tests) |
| — | 2 | **Complete (2026-10-19)** — registry `server/utils/inferenceOptions.js` (seed-on-first-read `system_settings` slugs, availability flags, fail-closed resolve); `POST /workspace/:slug/inference-option` (F13, member-gated option-key-only, EventLogs audit); `GET /workspace/:slug/inference-options` (F14 payload + `selected`); `GET\|POST /admin/inference-options` (F11, admin-only); 6 new endpoint tests; full suite 42/326 green |
| — | 3 | **Complete (2026-10-19)** — shared F12 guard `resolveOverrideForUser` in the registry (fail-closed: null option / non-default role / unknown key → null; resolution errors downgraded to null per N5); wired into both insertion points — `AgentHandler.#providerSetupAndCheck()` (role via `User.get({ id })` per Step 0) and `resolveProviderConnector()` (chat-path fallback per Step 0 correction); F7 gate-skip as a local `skipCreditGate` predicate in `chat.js`, both gates updated, admin-exemption semantics unchanged; test-file split (AgentHandler block vs chat-path block) to avoid jest.mock registry leakage; 14 routing/guard/chat-path tests; full suite 45/340 green; FILE_TREE regenerated |
| — | 4 | **Complete (2026-10-19)** — `server/utils/freeModelRateLimit.js` (narrow 429 detection + marker + client-facing mapping gated on the *currently configured* free slug via registry `isConfiguredFreeSlug`); wired into both OpenRouter throw sites (aibitat provider `stream`/`complete`, connector `getChatCompletion`/`streamGetChatCompletion`/`handleStream`) and both client-facing points (aibitat `websocket` onError → `wssFailure`, `chat.js` SSE catches); 15 new tests, full suite 46/355 green; pre-existing frontend lint errors at HEAD documented (not a Step 4 regression) |
| — | 5 | **Complete (2026-10-19)** — commit `4dcab67d`; new `InferenceOptionPicker` component (F14 consumer: three options in registry order, reference slugs, availability filter, apply-immediate F13 writes with optimistic UI + refetch + revert-on-error, server-provided labels so N1 wording ships from the registry); role branch in `WorkspaceModelPicker` (default → option picker, admin → unchanged full selector, manager → hidden per pre-feature behavior); `Workspace.inferenceOptions`/`setInferenceOption` model methods; `chat_window.inference_picker.*` en-i18n keys; no component test harness in the frontend (documented) — manual smoke checklist recorded for the Step 7 matrix; eslint/prettier clean on touched files; full server suite re-verified 46/355 green; FILE_TREE regenerated |
| — | 6 | Not started |
| — | 7 (merge gate) | Not started |

---

## Step 6 — Mid-session inference-option switch in agent mode (F16)

**Status: complete (2026-10-19, uncommitted — PR pending)**

**Root cause:** in agent mode the (provider, model) is frozen at WebSocket
connect time — `AgentHandler.init()` → `#providerSetupAndCheck()` →
`createAIbitat()` bakes `aibitat.defaultProvider` once
(`server/utils/agents/aibitat/index.js:96-111`) — and every turn on the open
socket reuses it in `reply()` (`getProviderForConfig({ ...this.defaultProvider,
...fromConfig })`, `aibitat/index.js:981`). The model-router case already
solved this with a per-turn `resolveRoute` hook (`agents/index.js:839-857`,
consumed at `aibitat/index.js:968-980`); the inference-option override never
got the same treatment. A page refresh "fixed" a switch only because it killed
the socket and forced a fresh `AgentHandler` init.

### Step 0 findings (F16 verification, 2026-10-19)

| # | Claim | Where | Verified |
|---|---|---|---|
| 1 | `reply()` rebuilds `providerInstance` every turn from `defaultProvider` — mutating `defaultProvider` mid-session is safe, no cached connector | `server/utils/agents/aibitat/index.js:981` (plus `:1487` `getProviderForConfig`) | ✅ |
| 2 | `resolveRoute` hook pattern to mirror: attached in `createAIbitat`, consumed per-turn at the top of `reply()` | `server/utils/agents/index.js:839-857`; `aibitat/index.js:966-980` | ✅ |
| 3 | Fresh-socket history continuity: a restart loads the last 20 turns, so the frontend teardown does not lose context | `agents/index.js:822` (`chats: await this.#chatHistory(20)`), `#chatHistory` at `:76` | ✅ |
| 4 | Billing follows the model actually used: `chat-history` debits via per-turn `providerInstance.getUsage()` keyed to `lastCall.model` — no change needed | `aibitat/index.js:272` (`emitContextUsage` reads `providerInstance.getUsage()`); `chat-history.js:101-103`, `:172`; debit chain per Step 0 finding 3 of the original plan | ✅ |
| 5 | `ephemeral.js` is a separate handler (non-interactive, no user-facing picker in-session); its `#providerSetupAndCheck` (`ephemeral.js:209`) does not consult `user_inference_option` at all. Decision: out of scope — no hook attached; noted here per the doc-first workflow | `server/utils/agents/ephemeral.js:209`, `:532` | ✅ |
| 6 | Socket notification on switch: the `modelRouteNotification` event type renders a generic "Switched to …" chip from `routedTo` metadata, reusable for an option switch | emit at `aibitat/index.js:259` (`flushRoutingMetadata`); frontend consumer `frontend/src/utils/chat/agent.js:180-192`, renderer `ChatHistory/index.jsx:299` + `ModelRouteNotification/index.jsx` | ✅ |

### Deviations from the original trace

- **Line numbers drifted** from the trace (e.g. `resolveRoute` block is at
  `agents/index.js:839-857`, not `807-831`); anchors were re-located by content.
- **The hook is attached unconditionally** in `createAIbitat` (the trace
  implied a conditional attach). `resolveOverrideForUser` is cheap (one indexed
  PK user lookup + one `system_settings` read) and fail-closed, so an
  always-on hook keeps admin slug changes (F11/N6) applying mid-session too,
  which a conditional attach would miss when the workspace starts on the
  legacy chain.
- **Notification is stamped via `handlerProps.routingMetadata`** (the exact
  shape `flushRoutingMetadata` consumes) instead of emitting a bespoke socket
  event — reuses the existing router-notification pipeline and UI verbatim,
  with `ruleType: "inference-option"` distinguishing it. Emitted only when
  provider or model actually changed.
- **Ordering in `reply()`**: the inference-option hook runs **before**
  `resolveRoute` (F12: the explicit option outranks the router; the init path
  already bypasses the router when an override is active). In practice the
  handler never attaches `resolveRoute` while an override is active at init,
  so both hooks coexisting on one instance is a defensive scenario only.
- **Frontend teardown uses `getAgentSessionActive()`** (module-level flag
  mirror, `frontend/src/utils/chat/agent.js:460-466`) rather than a new
  prop thread — the picker sits outside the ChatContainer's React state.

### Risk table

| Step | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 (server hook) | Touches the shared agent reply loop — a regression breaks every agent turn | **Highest** | Hook is additive and no-op when absent; `null` return leaves `defaultProvider` untouched; merge gate is `inferenceOptionMidSession.test.js` (5 tests) + full suite |
| 1 | Per-turn DB reads (User + system_settings) add latency | Low | One indexed PK lookup + one KV read per turn; same cost class as the existing `resolveRoute` re-resolution |
| 2 (frontend teardown) | ABORT on save could disrupt a stream the user wanted to keep | Low | Only fires when an agent session is active; the stream is ending anyway in normal usage; history is preserved on reconnect (`#chatHistory(20)`) |
| 2 | No frontend unit-test harness for socket teardown | Low | Covered by manual smoke test (below); documented, consistent with Step 5's precedent |

### Manual smoke evidence (Step 5 matrix, F16 rows)

- [ ] Multi-user mode, default role, `agent` chat mode, socket open mid-conversation; switch Free → e2ee; next turn runs on `e2ee-glm-5-3-flash` without reload; server logs show the mid-session switch line.
- [ ] Zero-credit user switches Free → Anon mid-session → 402 from the next turn.
- [ ] Free-tier 429 still maps to the F8 wording after a mid-session switch.
- [ ] `yarn lint` → `yarn test` clean before commit.

### Test changes (Step 3 of F16)

- **New** `server/__tests__/utils/agents/aibitat/inferenceOptionMidSession.test.js` —
  5 tests: hook switch rebuilds `providerInstance` for the new provider/model;
  `null` leaves `defaultProvider` unchanged (N5); same-option no-op does not
  stamp routingMetadata; hook runs before `resolveRoute`; switch stamps
  `routedTo` metadata for the socket notification.
- **Extended** `inferenceOptionGuard.test.js` — 3 hook-contract tests against
  the real registry (privileged roles, unknown keys, cleared selection all
  yield null mid-session).
- **Annotated** `inferenceOptionRouting.test.js` with the F16 test-location
  note (mock-registry leakage constraint, same reason as the chat-path split).

| PR | Steps | Status |
|---|---|---|
| — | 6 (F16) | **Complete (2026-10-19)** — server per-turn `resolveInferenceOption` hook (attached unconditionally in `createAIbitat`, consumed in `reply()` before `resolveRoute`); `modelRouteNotification`-shaped socket event on actual provider/model change; frontend teardown on save (`ABORT_STREAM_EVENT` when `getAgentSessionActive()`); 8 new tests green; manual smoke rows above pending live verification |
| — | 8 (blocker bugfix) | **Complete (2026-10-19, uncommitted — PR pending)** — mobile model-selector blocker fixed in `WorkspaceModelPicker`: removed the inherited `isMobile` early-return; on mobile the chip renders as a fixed top-bar button (now `fixed top-16 right-4 z-30`, body-portalled — see Follow-up 2) below the `SidebarMobileHeader`/UserMenu badges; popover anchored `right-0` with viewport-clamped panel widths (`min(420/620px, 100vw−24px)`); desktop branch byte-identical; manager gate unchanged; eslint/prettier clean; smoke rows 9–14 added to the Step 7 matrix. **Follow-up 1:** first version keyed the branch on `react-device-detect`'s `isMobile`, which disagreed with the chip's `hidden md:block` viewport gate in DevTools responsive mode (button never rendered) and landscape phones; layout now keys on a `matchMedia(min-width: 768px)` hook with `isMobile` as override (see Step 8 follow-up). **Follow-up 2:** real-phone retest still showed nothing — the fixed button, rendered inside the chat container's `z-[2]` stacking context (transforms/filters), was trapped below the `UserMenu` badges bar (`z-40`, root context); mobile layout now renders through `createPortal(…, document.body)` so the button's z-30 competes globally (see Step 8, Follow-up 2) |

> **Correction (2026-10-19):** an earlier version of this log claimed Step 3 was committed as `3f7c2a10` with 45 suites / 339 tests and a `isCreditGateExempt` predicate in the registry. That claim was fabricated — the work existed only as uncommitted changes, the commit hash was invented, the gate predicate lived in `chat.js` (not the registry), and one test file was mid-refactor and failing in-suite. The diff has since been reviewed against the working tree, the test split repaired, all tests verified green, and the real commit recorded below.

| — | 3 (real) | **Committed** — see the Step 3 row above for the accurate content; hash verified against origin after push |

*(Populate as work proceeds; record bugfix commits found during manual testing here.)*
