# Default-User Inference Options — Requirement Spec

**Status:** Draft — approved (all open questions resolved 2026-10-19)
**Scope:** Inference-option selection for `default`-role users in multiuser mode. Because these users only ever chat via the **agent path**, routing is anchored in `AgentHandler` (`server/utils/agents/index.js`), not the chat-path `resolveProviderConnector()`. Covers routing override, credit billing, the option write/read endpoints, and the frontend picker. The standard SSE chat path is touched only to skip the credit gate for the free option; its missing per-usage debit is explicitly out of scope (see Out of scope).
**Depends on:** Multiuser mode (`User` model, `Credits` ledger), `VeniceLLM` provider, `OpenRouterLLM` provider, `AgentHandler` provider resolution, `Workspace.supportsNativeToolCalling()`, the existing chat model selector (frontend `LLMSelector`), workspace `chatProvider`/`chatModel`/`agentProvider` storage

---

## 1. Problem

In multiuser mode, users with the `default` role have no way to choose how their chats are executed — and every chat they send runs through the **agent path**. `AgentHandler.#providerSetupAndCheck()` (`server/utils/agents/index.js:463`) resolves the provider from `workspace.agentProvider` or, via `#getFallbackProvider()` (`:401`), from `workspace.chatProvider`/`chatModel`, then the system `LLM_PROVIDER`. The user's role plays no part.

Every such chat is credit-gated in `server/endpoints/chat.js` (`:47`, `:140` — 402 with `action: "buy_credits"` at zero balance) and debited after the run by the `chat-history` plugin's `_debitCredits()` (`server/utils/agents/aibitat/plugins/chat-history.js:247`) → `Credits.debitUsage()` at hardcoded e2ee rates in `server/models/credits.js` (single `MODEL = "e2ee-glm-5-3-flash"`, 0.5 µ$/input, 1.0 µ$/output token — with a standing `TODO: per-model rates keyed on model`).

Consequences:

- Default users pay credits at the **most expensive** rate on every agent chat even though a cheaper/free tier exists.
- Default users cannot trade privacy against speed/cost — there is exactly one execution mode and they cannot see or choose it.
- Operators cannot route default users to OpenRouter's free tier to offload cost.
- A default user's selection is currently **impossible to persist**: the only selector write path, `POST /workspace/:slug/update` (`server/endpoints/workspaces.js:72`), is gated to `ROLES.admin | ROLES.manager` — a default user saving a model choice gets a 403.

## 2. Goal

Default-role users in multiuser mode get a choice of exactly three inference options — **Totem Free** (OpenRouter free tier), **Totem Anon** (Venice, standard server path), and **Totem e2ee** (Venice `e2ee` private-compute variant) — presented through the existing chat model selector, modified so default users see only these three options (with the underlying model shown for reference). The selection is stored per workspace as an option key and takes **priority over** `agentProvider`/`agentModel`/`chatProvider` when resolving the agent-path provider for a default-role user. Credit billing is keyed on the resolved model: Totem Free debits nothing; Totem Anon and Totem e2ee debit credits at per-model rates.

## 3. Requirements

### Functional

| # | Requirement |
|---|-------------|
| F1 | In multiuser mode, a `default`-role user is presented with exactly three inference options in the chat model selector: (1) **Totem Free**, (2) **Totem Anon**, (3) **Totem e2ee**. Each option displays the underlying provider + model for reference (e.g. `nvidia/nemotron-3.5-lightning:free`, `z-ai-glm-5-3-flash`, `e2ee-glm-5-3-flash`). Privileged roles (admin/manager) keep the existing full provider/model selection and do not see this picker. |
| F2 | Option 1 (**Totem Free**) routes the user's chats to the OpenRouter free-tier model — initial slug `nvidia/nemotron-3.5-lightning:free` (admin-configurable, F11) — by overriding the agent-path provider resolution (F12). Option 1 does not require native tool calling: if the resolved execution context lacks tool support, the chat may fall back to standard chat mode or the `UnTooled` agent path — both accepted behaviors. Upstream OpenRouter rate limits surface as a Totem-level rate-limit error (F8). |
| F3 | Option 2 (**Totem Anon**) routes the user's chats to Venice AI using model `z-ai-glm-5-3-flash` over the standard server-API-key path (no user-attributable identity forwarded upstream). Credited options always execute on tool-calling-capable endpoints (Venice native tool calling), so agent-path execution is preserved. |
| F4 | Option 3 (**Totem e2ee**) routes the user's chats to Venice AI using model `e2ee-glm-5-3-flash` — Venice's e2ee/private-compute variant, already the production default (`VENICE_MODEL_PREF`, `credits.js`). Same `VeniceLLM` call path; the slug selects Venice's private-compute route. No new encryption infrastructure (see N1). |
| F5 | The selection is stored **per workspace** in a new nullable column `workspaces.user_inference_option` (option key: `totem-free` \| `totem-anon` \| `totem-e2ee`), never as a raw provider/model value — so an admin slug change (F11) applies to already-selected workspaces on subsequent chats. NULL means "no selection" → legacy behavior (F9). Consequence: the selection is shared with other members of the same workspace (accepted — consistent with the workspace-scoped selector). |
| F6 | Credit billing is keyed on the **model actually used**, recorded from the run's metrics: per-model rates in `server/models/credits.js` replace the single hardcoded rate. Option 1's free model maps to 0/0 rates → `calculateCost` returns 0 → `debitUsage` early-returns → **no ledger row** (accepted: `Credits.debit()` already skips `amount <= 0` at `credits.js:121`; cost accounting for free chats relies on `workspace_chats.response.metrics.model`). Option 2 debits at the `z-ai-glm-5-3-flash` rate; Option 3 at the `e2ee-glm-5-3-flash` rate (0.5 µ$/input, 1.0 µ$/output token). Unknown slugs fall back to the e2ee rate (fail-closed for billing). The agent-path debit site (`chat-history.js` `_debitCredits`) already passes `metrics.model` and needs no change. |
| F7 | The credit gate (`Credits.hasCredits()` in `chat.js:47`/`:140`) is skipped only when the **requesting user is default-role and the workspace's stored option is `totem-free`**: a user with zero credits can still chat on Option 1. All other cases (no selection, Options 2/3, admin-configured workspaces) remain credit-gated with current role semantics unchanged (admin exempt). |
| F8 | There is **no Totem-side rate limit** on Option 1. Only an upstream OpenRouter rate-limit error (429 / free-tier exhausted) surfaces to the user, mapped to a Totem-level message — wording: *"The free model is rate-limited right now. Switch to Anonymous or E2EE inference to continue."* — presented as a service-level limit (not user-specific). No per-user counter, window, or stored quota is introduced. |
| F9 | Workspaces where no option has been selected (`user_inference_option` NULL) keep current behavior unchanged: `AgentHandler` resolves via the existing `agentProvider ?? chatProvider/chatModel ?? LLM_PROVIDER` chain, and debits run at the e2ee rate. No migration or backfill of existing rows. |
| F10 | The picker **is the existing chat model selector** (model chip in the chat prompt area → `LLMSelector` in `frontend/src/components/WorkspaceChat/ChatContainer/PromptInput/LLMSelector/`), modified for `default`-role users to present exactly the three F1 options (with reference model info per option, plus a "may not support agents/tools" label on Option 1) instead of the provider/model list. No new picker component or second UI surface is introduced. Privileged roles see the current full selector unchanged. |
| F11 | An **admin UI page + API** sets the model behind each of the three options: Option 1 to an OpenRouter model slug, Options 2 and 3 to Venice model slugs. Initial values: `nvidia/nemotron-3.5-lightning:free`, `z-ai-glm-5-3-flash`, `e2ee-glm-5-3-flash`. Stored in `system_settings` (no new table); because selections store the option key (F5), changes apply to **all** already-selected workspaces on subsequent chats, without a restart. |
| F12 | **Routing override (agent path).** In `AgentHandler.#providerSetupAndCheck()`, when the invoking user has role `default` and the workspace has a resolvable `user_inference_option`, the option's (provider, model) — resolved from the F11 `system_settings` slugs at request time — **replaces** `agentProvider`/`agentModel` and the fallback chain entirely. User priority over admin workspace config is accepted for default-role users only; privileged users' workspaces are unaffected. |
| F13 | **Option write endpoint.** A new endpoint `POST /workspace/:slug/inference-option` accepts `{ option: "totem-free" \| "totem-anon" \| "totem-e2ee" \| null }` (null clears the selection), is gated to authenticated workspace members (`ROLES.all` + membership check), and **only** writes `workspaces.user_inference_option`. Default users cannot write arbitrary provider/model values through it. The existing `/workspace/:slug/update` remains admin/manager-only, unchanged. |
| F14 | **Option read endpoint.** A read-only authenticated endpoint (e.g. `GET /system/inference-options`) returns the three options: key, label, description, reference model slug, and **availability** (Option 1 available only when `OPENROUTER_API_KEY` is set — `OpenRouterLLM` throws without it, `openRouter/index.js:32`). The picker filters out unavailable options; no dead-end selection is possible. The F11 admin page is the only writer of the underlying slugs. |
| F15 | `Workspace.supportsNativeToolCalling()` (`server/models/workspace.js:659`) keeps using the workspace's **configured** provider for the agent-invocation decision. It does not need to know the option: Options 2/3 are tool-calling-capable Venice models, and Option 1's non-tool-calling fallbacks (chat mode / `UnTooled`) are accepted behavior (F2). |
| F16 | **Mid-session switch (agent mode).** A completed selection takes effect on the next agent turn in an already-open session, without a page reload. The server re-resolves the option per turn (`resolveInferenceOption` hook attached in `AgentHandler.createAIbitat()`, consumed at the top of `AIbitat.reply()` — mirroring the existing `resolveRoute` model-router hook) and the frontend tears down the agent socket when a selection is saved (`ABORT_STREAM_EVENT` on save from `WorkspaceModelPicker`'s `onSaved` when an agent session is active), so the next message opens a fresh `AgentHandler` whose `#providerSetupAndCheck` reads the persisted option. Prior history is preserved (fresh sessions load the last 20 turns). Fail-closed: no selection / privileged role / unknown key / resolution error → the session's existing provider stands. The explicit option outranks `anythingllm-router` mid-session, matching the init path (F12). |

### Non-functional

| # | Requirement |
|---|-------------|
| N1 | Trust-model boundary: the Totem server composes and relays prompts in plaintext; Venice's e2ee/private-compute covers Venice's side of Option 3 (Totem e2ee). "E2EE" therefore does **not** mean private from the Totem operator. The UI wording must match this boundary and not overclaim. |
| N2 | Option 1 rate limiting is upstream (OpenRouter) only — the server maps upstream 429s to the standard error shape with the F8 wording and creates no per-user counter state. |
| N3 | Billing changes preserve the existing `credit_transactions` ledger shape; per-model rates are config/data in `server/models/credits.js`, not new tables; ledger rows carry the model slug used (already implemented in `debit()`). Free-option chats produce no ledger row (F6). |
| N4 | No migration of existing user data is required; `workspaces.user_inference_option` is a nullable column added by a single SQLite migration, NULL = "legacy behavior" (F9). |
| N5 | Provider failure of the selected option surfaces the standard chat error shape; the only rate-limit error a user can see is the Totem-level one from upstream OpenRouter (F8). No new error contract for the frontend beyond the picker itself. |
| N6 | All three option model slugs are changeable without a code release (F11 admin settings, seeded with the initial slugs). |
| N7 | Fail-closed billing: an unknown/unmapped model slug is billed at the e2ee rate, never at 0. Only the exact configured free slug bills at 0. |

## 4. Threat Model

- ✅ Prevents: default users unknowingly paying e2ee-rate credits for every message (billing transparency — the user now sees and chooses the cost/privacy tier).
- ✅ Prevents: cost blowout from default users on operator-paid Venice (Option 1 offloads to OpenRouter free tier, bounded by upstream free-tier limits; Options 2 and 3 cost is borne by the user's own credits).
- ✅ Prevents: default users writing arbitrary provider/model configs — the write endpoint (F13) accepts only the three option keys; provider/model resolution happens server-side from `system_settings` slugs.
- ✅ Fail-closed billing (N7): a misconfigured or unknown model slug bills at the e2ee rate, never free. A free ride requires the exact configured free slug.
- ❌ Does not prevent: a user leaking their own conversation content via any option; Totem Anon explicitly sends plaintext to Venice (user-visible warning required).
- ❌ Does not prevent: abuse of Option 1 beyond OpenRouter's own free-tier limits — bounded upstream, surfaced as a Totem-level rate limit (F8); no per-user enforcement exists. The credit-gate skip (F7) applies only to a workspace with an explicit `totem-free` selection.
- ❌ Missing-identity behavior: the override (F12) and gate-skip (F7) activate only for an authenticated, resolvable `default`-role user. **Fail-closed by construction** — an absent/unknown user (null `user_id`, deleted account, system/scheduled invocation) falls through to existing behavior (credit-gated where applicable, e2ee rate). No silent fallback to a free tier exists.
- ⚠️ Option 3 trust boundary: the Totem operator is inside the trust perimeter (N1); the "Totem e2ee" label must not be presented as private-from-operator, and the UI must not overclaim.
- ⚠️ User-priority override (F12): a default user's choice overrides an admin's `agentProvider`/`agentModel` on a shared workspace. Accepted per product decision ("the user decides the model for their workspace on priority") — admins retain control via the F11 slug configuration and can communicate expectations; workspace-level slugs are always operator-configured.

## 5. Acceptance Criteria

1. Given a `default`-role user in multiuser mode, when they open the chat model selector, then exactly the three named options (Totem Free, Totem Anon, Totem e2ee) are offered, each showing its underlying model for reference, and Option 1 shows a tool-support caveat.
2. Given a user selects Option 1, when they send an agent chat, then `AgentHandler` resolves the OpenRouter free-tier model (`nvidia/nemotron-3.5-lightning:free` unless admin changed it, F11) and their credit balance is unchanged.
3. Given a user selects Option 2, when they send an agent chat, then the request routes to Venice `z-ai-glm-5-3-flash` and credits are debited at that model's rate for actual token usage (rate per OQ-11).
4. Given a user selects Option 3, when they send an agent chat, then the request routes to Venice `e2ee-glm-5-3-flash` and credits are debited at the e2ee rate (0.5 µ$/input, 1.0 µ$/output token) for actual token usage.
5. Given a user with zero credits selects Option 1, when they send a chat, then the chat proceeds (no 402).
6. Given a user with zero credits selects Option 2 or 3, or the workspace has no selection, when they send a chat, then the existing 402 behavior applies.
7. Given a user on Option 1, when OpenRouter returns a rate-limit error, then the chat surfaces the Totem-level rate-limit message (F8 wording, N5 shape) and credits are unchanged.
8. Given a workspace where no option has been selected, when a default user sends a chat, then routing and debits are identical to pre-feature behavior.
9. Given an admin/manager user, when they open the model selector, then the existing full provider/model picker is shown and the three-option picker is not.
10. Given an admin, when they change an option's model slug via the F11 page, then subsequent chats by default users on that option route to the new slug and no restart is required.
11. Given a default-role user (workspace member), when they `POST /workspace/:slug/inference-option` with a valid option key, then `workspaces.user_inference_option` is set and subsequent agent chats resolve per F12 — including when `agentProvider` is configured on the workspace.
12. Given the same endpoint called with an invalid option key, a non-member session, or without auth, then the request is rejected (400/403/401) and no field is written.
13. Given `OPENROUTER_API_KEY` is unset on the server, when a default user opens the picker, then Option 1 is not offered (F14) and Options 2/3 are.
14. Given a chat on Option 1 whose model is the configured free slug, when tokens are consumed, then `calculateCost` returns 0, no `credit_transactions` row is created, and the model slug is recorded in `workspace_chats.response.metrics.model`.
15. Given an agent chat whose metrics report a model slug with no entry in the rate table, when debiting runs, then billing falls back to the e2ee rate (N7).
16. Given an active agent session on Totem Free (mid-conversation, no reload), when the user confirms Totem e2ee in the picker, then the next turn runs on Venice e2ee (`e2ee-glm-5-3-flash`) and prior history is preserved — either via per-turn re-resolution (server hook, F16) or via the agent-session reconnect the save triggers (frontend, F16); no page reload is required in either case.
17. Given the mid-session re-resolution cannot produce an override (selection cleared, privileged role, unknown key, resolution error), when the next agent turn runs in an open session, then the session's existing provider stands (fail-closed, N5).

## 6. Out of scope

- **Per-usage debit in the standard SSE chat path** (`server/utils/chats/stream.js` never calls `Credits.debitUsage()`; it gates but does not debit). Out of scope per product decision 2026-10-19 — default users are agent-only, so this path is not exercised by them. Named gap for a future workstream.
- Admin/manager free-form provider/model configuration changes (unchanged; F11 is the new admin page for the three option slugs).
- Image/audio/embedding model selection — text chat only.
- Changing per-model credit rates from the admin UI (rates live in `server/models/credits.js` per N3; F11 configures slugs only).
- Per-user (as opposed to per-workspace) selections and a profile-settings UI — dropped when storage was decided to be `workspaces.user_inference_option` (workspace-scoped picker, F5/F10).
- Forcing agent-path execution for tool-incapable free models (F2 accepts chat-mode / `UnTooled` fallback).

---

## Open Questions

| # | Question | Resolution |
|---|----------|------------|
| OQ-1 | Credit billing per option + admin model configuration | **Resolved:** Option 1 = free (OpenRouter); Options 2 & 3 = credit-billed (Venice). Admin UI page for per-option slugs (F11). Initial slugs: `nvidia/nemotron-3.5-lightning:free`, `z-ai-glm-5-3-flash`, `e2ee-glm-5-3-flash` | 
| OQ-2 | Does the selection override admin-configured workspace providers, or apply only where the workspace is on system defaults? | **Resolved:** the picker is the model-selection mechanism for default users — their selection takes priority over `agentProvider`/`agentModel`/`chatProvider` (F12). Admin/manager workspaces unaffected. |
| OQ-3 | Is the selection global per user or per workspace? Where does the UI live? | **Resolved:** workspace-scoped via `workspaces.user_inference_option` (F5); UI is the existing chat model selector only (F10), no profile-settings surface. |
| OQ-4 | Pre-selection default state | **Resolved:** legacy behavior until first selection; NULL = legacy (F9). For this deployment "legacy" = agent-path routing via the existing fallback chain, debited via `chat-history.js` at e2ee rates. |
| OQ-5 | Option 1 rate limit | **Resolved:** no Totem-side cap; upstream OpenRouter limits passed through as a Totem-level rate-limit error (F8, N2, N5). |
| OQ-6 | Option 1 model slug | **Resolved:** initial `nvidia/nemotron-3.5-lightning:free`; admin-configurable via F11. |
| OQ-7 | Option 3 e2ee mechanics | **Resolved:** same existing `VeniceLLM` path; `e2ee-glm-5-3-flash` is already the production model (`VENICE_MODEL_PREF`). No new infrastructure. Trust boundary per N1. |
| OQ-8 | Option 2 "anonymous" claim | **Resolved:** both Venice options use the single server API key; no user identity is ever forwarded upstream — anonymity by construction. |
| OQ-9 | Agent-path chats honor the selection? | **Resolved (flipped 2026-10-19):** agent path is the **primary** scope — default users only use agent mode. Routing override anchored in `AgentHandler` (F12); debit flows through the existing `chat-history.js` site (F6). |
| OQ-10 | Build-profile gating | **Resolved:** all profiles, no dedicated `requireFeature` flag. |
| OQ-11 | Option 2 credit rate | **Resolved:** same rate as Option 3 (0.5/1.0 µ$) until admin changes `credits.js`. |
| OQ-12 | Option 1 + tool-calling-incapable model | **Resolved:** accepted — free option may fall back to standard chat mode or `UnTooled`; credited options always use tool-calling endpoints (F2, F15). |
| OQ-13 | Selector write path for default users (403 on `/update`) | **Resolved:** new member-gated, option-key-only endpoint (F13). |
| OQ-14 | Free-option ledger rows | **Resolved:** none; `debit()` already skips zero amounts; cost accounting via `metrics.model` (F6). |
| OQ-15 | `OPENROUTER_API_KEY` missing | **Resolved:** server reports availability; picker hides unavailable options (F14). |
| OQ-16 | Missing debit in standard SSE chat path | **Resolved:** out of scope (named gap). |
