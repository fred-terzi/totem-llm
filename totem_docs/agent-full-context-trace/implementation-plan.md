# Implementation Plan — Agent Full-Context Trace

Companion to `requirement-spec.md`. All paths relative to repo root.
Requirement IDs (F1–F13, N1–N12, AC1–AC21) refer to the spec.

---

## Step 0 — Investigation (no code)

Verify every chain the implementation depends on. Record findings with
`file:line` citations and verification date. Known-wrong assumptions in this
draft get a "Correction to Step N" note rather than silent edits.

| # | Chain to verify | Files | Date verified | Finding |
|---|-----------------|-------|---------------|---------|
| 0.1 | Where intermediate `role:"function"` messages are appended in streaming and sync loops; confirm the recursion's `messages` array is the single source for the live trace. | `server/utils/agents/aibitat/index.js` (`handleAsyncExecution`, `handleExecution`) | 2026-10-23 | Confirmed — both recursions append `{name, role:"function", content: result, originalFunctionCall}` before recursing. This array is captured but discarded at the end of `reply()`; only the final string returns to `newMessage()`. **Capture point = end of each recursion branch.** |
| 0.2 | Where reasoning content is captured and whether it survives into subsequent calls within a turn. | `providers/helpers/tooled.js` (`tooledStream` — `reasoningText` accumulation), provider `stream()` implementations | 2026-10-23 | **Correction (post-review):** the original finding mischaracterized `tooledStream`. Precisely: `tooledStream` accumulates `reasoningText` locally and emits it **only** via `eventHandler` stream events (`<thought>`-wrapped to the client) — it is **never** added to the returned `textResponse`. On the reasoning→content transition the code does `result.textResponse += "</thought>" + delta.content`, so a *text* turn from a reasoning model persists a **stray leading `</thought>` with no opening tag** into `response.text` — a pre-existing persistence bug the trace work collides with (fold its fix into Step 3: returning `reasoning` separately and excluding it from `textResponse` fixes it for free). On a *tool-call* turn `textResponse` is empty and `reasoningText` is reset to `""` after the transition — the reasoning is genuinely unrecoverable from the return value today; it must be threaded out as a new return field (Step 3.1). Provider-specific `injectReasoningContent` exists for DeepSeek-style fields. Need per-provider audit in Step 1. |
| 0.3 | The finalize path: what `reply()` returns and how `chat-history` receives it. | `aibitat/index.js#reply` → `newMessage({...route, content})` → `plugins/chat-history.js#onMessage` (second listener) | 2026-10-23 | Confirmed — `reply()` returns only the final string; the history plugin sees `aibitat.chats.slice(-2)` = `[USER msg, final agent string]`. Trace must be attached to `aibitat` (e.g. `aibitat._traceBuffer`) before `newMessage` fires, and drained in `_store`/`_storeSpecial`. |
| 0.4 | The two-phase save: pre-register + upsert by `trackedChatId`. | `plugins/chat-history.js` (`onMessage` first listener, `_store`, `_storeSpecial`, `_cleanup`) | 2026-10-23 | Confirmed. `WorkspaceChats.upsert(trackedChatId, {...})` overwrites `response` wholesale — trace keys must be added inside the same upsert payload. `_cleanup()` clears `_pendingCitations`/`_pendingOutputs`/surveys; trace buffer must be cleared there too. |
| 0.5 | How history is loaded into the *next* invocation. | `server/utils/agents/index.js#chatHistory` (limit 20 in `createAIbitat`) | 2026-10-23 | Confirmed — reads `include:true` rows, emits only `prompt` / `response.text` pairs. This is the reconstruction injection point: expand each pair to include tool-call assistant/tool messages built from the row's trace. |
| 0.6 | Native provider message formatting: can it accept interleaved assistant/tool messages for *history* turns? | `providers/helpers/tooled.js#formatMessagesForTools` | 2026-10-23 | Already handles `role:"function"` + `originalFunctionCall` → synthesizes `assistant.tool_calls` + `role:"tool"` pairs. **Key design decision:** if the next-turn history emits real aibitat messages with `originalFunctionCall` metadata, `formatMessagesForTools` converts them *for free* — no provider-format changes needed. Anthropic provider has an analogous converter (verify in Step 1). |
| 0.7 | UnTooled collapse behavior. | `providers/helpers/untooled.js#cleanMsgs` | 2026-10-23 | Confirmed — concatenates `function` content into the previous assistant message with no call labels. F8 fix lands here (label injection in `cleanMsgs` or in history expansion). |
| 0.8 | Frontend agent event pipeline & historical message rendering contract (what fields `response` JSON the UI reads). | `frontend/src/components/WorkspaceChat/...` (`HistoricalMessage`, `PromptReply`, `ThoughtContainer`) | 2026-10-23 | **Verified — and it contradicts the Step 7 draft.** The server-side serializer `convertToChatHistory` (`server/utils/helpers/chat/responses.js:184-230`) does **not** return the whole `response` JSON — it whitelists fields (`text`, `sources`, `type`, `attachments`, `metrics`, `outputs`, `clarifyingQuestions`) and drops everything else. Both history endpoints use it: `server/endpoints/workspaceThreads.js:113-136` (thread chats) and `server/endpoints/workspaces.js:465` (workspace chats). **Correction to Step 7:** exposing `trace` requires an explicit passthrough added to `convertToChatHistory` — "no server endpoint changes" was wrong. Second finding: rows whose `data.text` is not a string are **skipped entirely** (`responses.js:197-202`) — an abort-save row with an empty `text` would be invisible to the UI; the abort save must always set `text` to at least `""`. Frontend side is additive-safe: `HistoricalMessage` destructures known props only (`HistoricalMessage/index.jsx:30` `sources = []`, etc.) and ignores unknown keys. |
| 0.9 | Abort path end-state. | `aibitat/index.js#abort`, `chat-history.js` (`if (aibitat._aborted) return`) | 2026-10-23 | Confirmed — on abort the second listener returns early; the placeholder row stays `include:false` forever. F9 requires a new abort-time upsert. Verify where `abort()` is invoked from (socket close handler) to hook the partial-save. |
| 0.10 | Credit debit placement relative to any new save path. | `chat-history.js#_debitCredits`, `_storeSpecial` | 2026-10-23 | Debits happen inside `_store`/`_storeSpecial` after upsert. An abort-time save (F9) must NOT re-run debit against partially-billed usage unless session usage is available at that point (verify `providerInstance.getSessionUsage()` state at abort — partial usage may already be recorded via `recordUsage`). Decide: debit-on-abort if and only if usage > 0 and row not already debited (idempotency guard needed). **Resolved same day (see 0.13):** `getSessionUsage()` (`ai-provider.js:667-671`) returns the accumulated `_sessionUsage`, which only grows via `recordUsage` — and `recordUsage` is called from the usage-bearing chunk of each stream (`tooled.js` `chunk?.usage` arrives on the *final* chunk). A stream aborted before its final chunk contributes **zero** recorded usage for that call; completed tool-loop rounds are fully counted. So abort-time debit is safe against double-charging *completed* rounds only if an application-level guard exists (Credits has none — 0.13) and debits only when session usage > 0. |
| 0.11 | Flush target mechanics: can we upsert `response.trace` on the placeholder row without flipping `include`? | `models/workspaceChats.js#upsert`, `chat-history.js` placeholder creation | 2026-10-23 | Verified — `WorkspaceChats.upsert(id, {...})` takes an explicit payload; passing only `response` does not touch `include`. The placeholder row is created before the first LLM call (first `onMessage` listener), so `trackedChatId` exists before any tool call can complete → flushes always have a row to target. Must serialize the full buffer on every flush (last-write-wins), and flushes must NOT call `_debitCredits` / `_autoRenameThread`. |
| 0.12 | Crash-recovery detection point: when the next invocation loads history, what distinguishes an orphaned flushed row from a normal ghost? | `AgentHandler.#chatHistory` (`include:true` filter), `WorkspaceChats.where` | 2026-10-23 | Verified — orphaned flushed rows are invisible to `#chatHistory` (`include:false`) but findable at the start of a new invocation in the same thread by fetching the last N `include:false` rows for the workspace/thread (`orderBy id desc`, take ~5) and filtering **in JS** by parsing `response.trace` — `workspace_chats.response` is a plain String column, so Prisma cannot filter on a key inside the JSON (a `hasTrace`-style filter does not exist; see Step 3b.2). Promotion must happen exactly once (guard: only promote rows with non-empty `response.trace` and no `stopReason`). |
| 0.13 | Credits dedupe behavior: does `Credits.debit` guard against a repeated `reference` (e.g. `chat_<id>`), and is partial session usage readable at abort time? | `server/models/credits.js#debit`, `debitUsage`; `chat-history.js#_debitCredits`; `providerInstance.getSessionUsage()` / `recordUsage` at abort | 2026-10-23 | Pulled forward from Step 6 (0.10). **Verified 2026-10-23: `Credits.debit` has NO dedupe.** The `reference` (`chat_<id>`) is stored verbatim (`credits.js:186`) but never checked; `credit_transactions.reference` has no unique constraint (`schema.prisma:465-478`, only `@@index([user_id])`). A second debit with the same reference creates a second ledger row and debits again. **Consequence for Step 6:** the abort-save debit needs an application-level guard — either (a) query `credit_transactions` for an existing row with `reference: "chat_<id>"` before debiting, or (b) an `aibitat._debited` flag set by `_store`/`_storeSpecial`/abort handler. Option (a) is preferred: it survives process restarts (a crash between debit and abort-save re-debits under option (b)). Partial session usage at abort: readable via `getSessionUsage()` but only covers calls whose final usage chunk arrived (see 0.10). In-flight-call tokens are unbillable-at-abort by construction — acceptable, bounded loss. |
| 0.14 | Live-turn promotion race: can a second tab / concurrent invocation trigger promotion against a still-executing turn's flushed placeholder? | `chat-history.js` (first `onMessage` listener — placeholder creation), `AgentHandler` invocation entry, `workspace_chats.lastUpdatedAt` semantics | 2026-10-23 | The risk table (Step 9) flags this; the promotion query needs a recency guard so a placeholder flushed seconds ago by a *live* turn is not promoted. **Design decision:** promotion only targets rows with no `stopReason`, a non-empty `response.trace`, AND `lastUpdatedAt` older than a recency window (e.g. 2× max flush interval or 60 s, whichever is larger) — a live turn's placeholder is refreshed by each flush, so a stale `lastUpdatedAt` implies the turn is genuinely dead. **`lastUpdatedAt` bump verified 2026-10-23:** `WorkspaceChats.upsert`'s update branch explicitly sets `lastUpdatedAt: new Date()` (`server/models/workspaceChats.js`, upsert → `update: { ...payload, lastUpdatedAt: new Date() }`); the column exists with `@default(now())` on `workspace_chats` (`schema.prisma:196`). The recency guard is reliable. |
| 0.15 | Flush read-modify-write: does `WorkspaceChats.upsert` merge into existing `response` JSON, or overwrite the column wholesale? | `models/workspaceChats.js#upsert`, `chat-history.js` flush call site | 2026-10-23 | Per 0.4, `upsert` **overwrites** `response` wholesale — so the Step 2b flush cannot pass only `{ trace }`; it must read the row's current `response` first (or read-modify-write in a transaction) and re-serialize the merged object, or it will clobber keys written by the placeholder creation (e.g. `prompt`-side metadata). This also creates a race surface: a flush landing concurrently with the abort-save can resurrect a stale `response` and clobber `stopReason`/`aborted` — mitigated by the `_finalized` check on flushes (Step 6.3) plus last-write-wins serialization. |

## Step 1 — Per-provider reasoning/trace audit

Audit each agent-capable provider wrapper (`aibitat/providers/*.js`) for:
- what `stream()`/`complete()` return in the tool-call branch (is reasoning text recoverable?),
- whether `reasoning_content` is preserved on assistant messages it emits into history,
- the Anthropic message converter's handling of tool-use/tool-result pairs for history turns.

Deliverable: a table in this file (appended as findings, not a rewrite) mapping
provider → reasoning capture point → required adapter tweak. Providers needing
tweaks get them in Step 3.

**Risk:** some providers return reasoning only inside `<thought>`-tagged text
mixed with content; parsing that back out needs a shared helper
(`server/utils/agents/aibitat/providers/helpers/trace.js`). This applies to
**non-tooled provider paths only** — the tooled path (`tooledStream`) needs
threading, not stripping (see 0.2 correction). The Step 1 audit table must
also explicitly record the **stray-`</thought>` artifact** (0.2): a text turn
from a reasoning model persists a leading `</thought>` with no opening tag
into `response.text`; its fix folds into Step 3 (returning `reasoning`
separately and excluding it from `textResponse`).

### Step 1 findings — per-provider reasoning/trace audit (2026-10-24)

**Provider wrapper topology (verified):** 33 of 37 provider files inherit
`InheritMultiple([Provider, UnTooled])` (`helpers/classes.js`); 4 are direct
`Provider` subclasses with hand-rolled tool calling (`anthropic.js`,
`gemini.js`, `openai.js`, plus `index.js` which is the base class). Of the
UnTooled inheritors, 14 also call `tooledStream`/`tooledComplete` when
`supportsNativeToolCalling()` is true (azure, cerebras, deepseek,
dockerModelRunner, genericOpenAi, groq, lemonade, litellm, lmstudio,
localai, minimax, novita, openrouter, venice). Bedrock has its **own**
native path (LangChain `bindTools` + `tool_call_chunks`, not the shared
tooled helper). Ollama has its own native path against the native Ollama
SDK (`chunk.message.thinking`, `chunk.message.tool_calls`). Every path
collapses to one of **five capture behaviors**:

| # | Path (providers) | Reasoning capture today | Recoverable for trace? | Stray-`</thought>` artifact? | Required adapter tweak (Step 3/4) | Capability flag `supportsReasoningHistory` |
|---|------------------|-------------------------|------------------------|------------------------------|-----------------------------------|--------------------------------------------|
| A | **Shared tooled path** — `tooledStream`/`tooledComplete` (`helpers/tooled.js`), used by: azure, cerebras, deepseek, dockerModelRunner, genericOpenAi, groq, lemonade, litellm, lmstudio, localai, minimax, novita, openrouter, venice (when `supportsNativeToolCalling()` true; venice additionally gates on the model's reported `tools` capability) | `reasoningToken = choice.delta?.reasoning_content ?? choice.delta?.reasoning` (`tooled.js:245`) accumulated into local `reasoningText`, emitted **only** via `eventHandler` `<thought>`-wrapped stream events. Never added to `textResponse`. On tool-call turns the accumulator is discarded on return; on text turns only the stray closing tag + content survive (`tooled.js:270-278`). `tooledComplete` captures **no reasoning at all** (non-stream response `message.reasoning_content` is ignored). | **No** — must thread out. `tooledStream` needs a new `reasoning` return field (trim the leading `<thought>` wrapper); `tooledComplete` needs to read `completion.reasoning_content ?? completion.reasoning`. Additive; all 14 call sites keep working. | **Yes (text turns only)** — `result.textResponse += "</thought>" + delta.content` (`tooled.js:271`) persists an unmatched closing tag into the saved `response.text`. Fix in Step 3.1: keep emitting the combined chunk to `eventHandler` (live UI rendering depends on it) but stop appending it to `textResponse`; return `reasoning` separately. | Thread `reasoning` from both helpers; each of the 14 wrappers already returns the helper's object verbatim, so **no per-provider edits needed** for the tooled branch. | `true` only for providers that set `injectReasoningContent` (today: deepseek thinking models, `deepseek.js:76`). Generic OpenAI-compatible providers get `reasoning_content: ""` injection only when that option is passed — flag stays `false` for the rest (assistant-history reasoning fields risk 400s on strict endpoints). |
| B | **Shared UnTooled tool-pick path** — `streamingFunctionCall`/`functionCall` in `helpers/untooled.js`, inherited by all 33 UnTooled providers on their non-native fallback (incl. bedrock/ollama fallbacks which override the chat callbacks only) | Same pattern: `reasoning_content ?? thinking ?? reasoning` deltas (`untooled.js:209`) → `eventHandler` only; `textResponse` gets the stray `</thought>` + content on text turns (`untooled.js:234-240`). Returns `{toolCall, text, uuid}` — **no reasoning field**. | **No** — thread a `reasoning` field out of `streamingFunctionCall`'s two return shapes (`{toolCall}` and `{text}`), mirroring Step 3.1. Note: reasoning is recoverable on the tool-call branch here (it's parsed-from-text flow), unlike path A. | **Yes** (text branch) — same fix as A. | Add `reasoning` to `streamingFunctionCall` returns; base `stream()`/`complete()` must pass it through to the final return object. | `false` by default — UnTooled providers speak plain prompt/text; reasoning history replays as `<thought>`-tagged assistant text (Step 4 fallback). |
| C | **Shared UnTooled plain-chat fallback** — `untooled.js` `stream()` no-functions branch (`untooled.js:380-428`) and `complete()` fallback | Same `<thought>` tagging into `completion.content` — here reasoning **is** persisted into `textResponse` (with tags), i.e. the opposite artifact of A/B: tags are saved but never stripped server-side. | **Yes but polluted** — reasoning arrives embedded in `textResponse` with `<thought>…</thought>` tags. The Step 1 risk note's shared parse helper (`helpers/trace.js#extractThought`) applies here: split `textResponse` into `{ text, reasoning }` at the aibitat layer rather than changing 30+ provider returns. | **No** (opposite: tags persist, matched pair, rendered as collapsible thought by the frontend `ThoughtContainer`). But the tags must be **stripped before trace persistence** (trace entries carry raw `reasoning`/`llm_text`, not tag soup). | No provider edits; the shared `extractThought` helper parses `textResponse` in `handleAsyncExecution`/`handleExecution` when the provider returned no `reasoning` field and `<thought>` tags are present. | `false` (text-tag fallback per Step 4). |
| D | **Anthropic** (`anthropic.js`, direct `Provider` subclass, native tool calling always) | **Zero reasoning capture.** `stream()` reads only `content_block` `text`/`tool_use`/`input_json_delta` (`anthropic.js:290-330`); `complete()` reads `content[].type === "text"` and stuffs the chain-of-thought into a synthesized `messages.push(thought)` for API-shape reasons (`anthropic.js:398-425`) but never surfaces it. No `thinking`/`budget_tokens` request param is ever sent, so extended thinking is off — reasoning blocks cannot appear. `reasoning_content`/`thinking` grep: 0 hits. | N/A — nothing to capture until thinking is enabled (out of scope for this workstream). | **No.** | **None required for Step 3.** Anthropic's converter `#prepareMessages` (`anthropic.js:111-206`) already normalizes aibitat `role:"function"` + `originalFunctionCall`... **with one caveat**: it looks up the `tool_use` id by scanning the **immediately preceding assistant message's content array** for `item.type === "tool_use"` (`anthropic.js:129-135`) — aibitat's assistant messages are plain strings, so the lookup finds nothing and the tool_result is **silently dropped** for in-turn rounds too (Anthropic tolerates it today only because consecutive-same-role merging hides the gap). History reconstruction (Step 3.3) must emit the assistant tool-call message with an **Anthropic-shaped content array** (`[{type:"text"…},{type:"tool_use", id…}]`) or teach `#prepareMessages` to synthesize the `tool_use` block from `originalFunctionCall` — pick the latter in Step 3.3; it also fixes the in-turn drop. Also note `#prepareMessages` filters out empty-text blocks and drops leading non-user messages — reconstruction must not emit a function message first. | `false`. Anthropic thinking blocks require signatures + strict alternation; until extended thinking is requested, there is nothing to retain. |
| E | **OpenAI** (`openai.js`, direct subclass, **Responses API** — not chat.completions) | **Zero reasoning capture.** Streams `response.output_text.delta` only; no `response.reasoning_summary_text.delta` handling, and `store:false` discards server-side reasoning state between calls (`openai.js:149-158`). `#formatToResponsesInput` has no reasoning input field. GPT-5/o-series reasoning summaries are simply never requested. | N/A. | **No.** | None for capture. **History reconstruction caveat:** the Responses API synthesizes function-call items from `originalFunctionCall` via `#formatToResponsesInput` (`openai.js:54-80`) — same free conversion as `formatMessagesForTools`, but note it re-serializes arguments with `JSON.stringify` and requires the `call_id` to match a preceding `function_call` item; reconstructed messages must preserve `originalFunctionCall.id` (trace entries already do). | `false` (reasoning persists server-side only when `store:true` + `previous_response_id`, which this wrapper never uses). |
| F | **Gemini** (`gemini.js`, direct subclass, native chat.completions-shape against the Gemini endpoint) | **Zero reasoning capture**, but **thought signatures are preserved**: `functionCall.extra_content` carries Gemini's `thought_signature` through `stream()` (`gemini.js:307-308`) and back via `#formatMessages` (`gemini.js:151-153`). Gemini 400s in multi-turn tool conversations if the signature is missing. | N/A (reasoning is encrypted server-side; only the signature round-trips). | **No.** | **None for capture.** **History reconstruction hard requirement (Step 3.3):** reconstructed `tool_call` assistant messages must carry `extra_content` (thought_signature) from the trace, and `tool_result` reconstruction must go through `#formatMessages`' `originalFunctionCall` branch which prefixes names with `gtc__` (`gemini.js:137-141`) — the reconstruction must emit the **stripped** tool name and let `#formatMessages` re-prefix, exactly as in-turn messages do. Malformed pairs (missing `originalFunctionCall`) are logged-and-skipped (`gemini.js:135-143`), which matches the AC21 degrade-to-plain-text policy. | `false`. |
| G | **Ollama** (`ollama.js`, native Ollama SDK, own tooled + UnTooled paths) | **Three different behaviors in one file** — the only provider with an internal inconsistency: 1. Native tooled `stream()` (`ollama.js:364-470`): `chunk.message.thinking` is appended **into `textResponse`** wrapped in `<thought>` tags (`ollama.js:407,414`) — reasoning persists but tag-polluted (path-C-style), on tool-call turns too. 2. UnTooled `streamingFunctionCall` override (`ollama.js:257-356`): thinking → `eventHandler` only, **excluded** from `textResponse` (cleanest behavior in the codebase; matches path A's target shape). Discarded on return. 3. UnTooled plain-chat fallback (`ollama.js:548-586`): uses **`<think>` tags, not `<thought>`** (`ollama.js:561-576`) — inconsistent with every other path and with the frontend's thought regex, which matches `thought|thinking|think` (frontend `ThoughtContainer` accepts `think`, so this renders, but the shared `extractThought` helper must accept both tag spellings). | Mixed: (1) recoverable by parsing tags out of `textResponse`; (2) not recoverable without threading; (3) recoverable by parsing `<think>` tags. | **Yes** in (1) and (3) (matched tag pairs persisted into `textResponse`); no in (2). | Step 3: thread `reasoning` out of the native tooled `stream()` return and the `streamingFunctionCall` override; normalize (1) to the A-shape (reasoning out of `textResponse`) and (3)'s `<think>` → `<thought>` emission for consistency. The shared `extractThought` helper must still accept `<think>`/`</think>` for legacy rows persisted before the fix (AC11 — legacy rows must load clean). | `true` when the model supports thinking + `think` level is enabled (`ollama.js` `thinkLevel` → `requestPayload.think`); Ollama accepts assistant `thinking` fields in history for thinking models. Set the flag dynamically off the same `thinkLevel`/capability check used to set `requestPayload.think`. |
| H | **Bedrock** (`bedrock.js`, own native path via LangChain `bindTools`) | **Zero explicit reasoning capture.** `stream()` concatenates `chunk.content` strings and `tool_call_chunks` (`bedrock.js:327-352`); LangChain may interleave `thinking` content blocks for some models but the wrapper only handles string content. No reasoning field in returns. | N/A. | **No.** | None for capture. History reconstruction: `#convertToLangchainPrototypesWithTools` must tolerate reconstructed `role:"function"` + `originalFunctionCall` messages the same way it does in-turn ones (it already processes in-turn messages of that exact shape, so no change expected — verify in Step 3.3 test). | `false`. |
| I | **All remaining UnTooled-family providers** (togetherai, fireworksai, xai, zai, sambanova, moonshotAi, cometapi, giteeai, ppio, privatemode, dellProAiStudio, foundry, mistral, perplexity, apipie, koboldcpp, localai, textgenwebui, nvidiaNim — native-tool-calling subset routes to path A, the rest to paths B/C) | Inherited from paths A/B/C above. No per-provider reasoning code exists in any of them (grep `reasoning|thinking` across the directory: only deepseek's `injectReasoningContent` and ollama's `chunk.message.thinking`). | Per path A/B/C. | Per path A/B/C. | **None beyond the shared-helper changes.** This is the load-bearing finding: the trace feature is implemented once in `tooled.js`, `untooled.js`, `trace.js`, and `aibitat/index.js`, not once per provider. | `false` for all, except the deepseek/ollama dynamics noted above. |

**Cross-cutting conclusions:**

1. **Reasoning is recoverable for the trace in every path after exactly two helper edits** (`tooled.js` thread-out, `untooled.js` thread-out) plus Ollama's native `stream()` — no per-provider surface changes are needed for 30+ providers. The shared `extractThought` helper handles the tag-polluted paths (C, G-1, G-3) and legacy rows.
2. **`reasoning_content` is never preserved on emitted assistant messages today.** The only mechanism that touches assistant reasoning in history is `injectReasoningContent` in `formatMessagesForTools`, which **synthesizes empty strings** — it exists to satisfy DeepSeek's API requirement, not to carry reasoning. Step 4's in-turn retention is greenfield, not a refactor. For path A providers the retention field is `reasoning_content` (OpenAI-compatible convention, already wired through `formatMessagesForTools` when the option is on); everything else falls back to `<thought>`-tagged assistant text.
3. **Anthropic converter gap (row D) is the only true blocker** for F4 history reconstruction — the in-turn `tool_use` lookup assumes a content-array assistant message that aibitat never produces. Fix in `#prepareMessages` (synthesize the `tool_use` block from `originalFunctionCall`) and assert it in `agent-history-reconstruction.test.js` alongside the `getOrFormatNodeChatHistory` survival asserts.
4. **Gemini is the only provider with a cryptographic round-trip requirement** (thought_signature). Trace entries must carry `extra_content` verbatim from `functionCall` and reconstruction must feed it back through `#formatMessages` unmodified, with the stripped tool name.
5. **Stray-`</thought>` artifact inventory (0.2 follow-up):** paths A and B persist a lone closing tag into `textResponse` on text turns; paths C, G-1, G-3 persist matched tag pairs; path G-3 uses the wrong tag spelling. All four resolve via Step 3.1's separate-`reasoning` return; `extractThought` handles already-persisted legacy rows.
6. **Deviations from the Step 1 draft:** (a) the draft assumed reasoning arrives as `<thought>`-tagged text mixed with content for non-tooled paths — true for the plain-chat fallback (C) and Ollama's native stream, but the UnTooled tool-pick path (B) behaves like the tooled path (eventHandler-only, discarded); (b) `tooledComplete` was assumed to parallel `tooledStream`'s capture — it captures nothing; (c) Ollama's `<think>` tag inconsistency was unknown; (d) the Anthropic `#prepareMessages` tool_use-lookup drop was unknown and is a pre-existing in-turn bug the trace work should fix opportunistically.

## Step 2 — Trace buffer on AIbitat

Implement `aibitat._traceBuffer` (array of ordered entries):

```
{ type: "reasoning", llmCall: n, text: string }
{ type: "tool_call", llmCall: n, callId, name, arguments }
{ type: "tool_result", callId, name, content }
{ type: "llm_text", llmCall: n, text: string }   // pre-tool assistant text
```

- Append points: in `handleAsyncExecution`/`handleExecution` at the same sites
  the `role:"function"` messages are appended (0.1), plus reasoning capture
  added in the provider layer (Step 3) via a new optional return field
  (`reasoning`) threaded up from `tooledStream`/`tooledComplete`.
- Bump `llmCall` counter at each `providerInstance.stream/complete` call.
- Cap enforcement (N6): append-time running size check against
  `AGENT_TRACE_MAX_BYTES` (default 2 MB); over cap → push single
  `{ type: "truncation_marker" }` and stop appending.
- Public accessors: `aibitat.getTrace()`, `aibitat.clearTrace()`.
- **Deviations from the original draft:** (record as they occur)

### Step 2 deviations (implemented in commit `416da428`, 2026-10-24)

1. **Buffer fields are private with method-level accessors, as drafted — plus
   running-size accounting.** `_traceBytes` tracks the running serialized size
   (sum of `Buffer.byteLength(JSON.stringify(entry))` per entry, computed at
   append time; unserializable entries count as 0 bytes rather than throwing).
   The N6 cap check compares `running + entry size > AGENT_TRACE_MAX_BYTES`
   (default 2 MB, env-tunable, parsed in `AIbitat.traceMaxBytes()`).
2. **`llmCall` counter placement:** `_nextTraceLlmCall()` is called at the top
   of both `handleAsyncExecution` and `handleExecution` — *before* the provider
   call, not after — so an aborted/in-flight final call still consumes an index.
   Harmless (the index is only stamped on entries that actually get appended).
3. **Reasoning/llm_text capture reads optional return fields now, threading
   later.** The handlers append `reasoning` / `llm_text` entries whenever the
   completion object carries a non-empty `reasoning` string (and non-empty
   `textResponse` for `llm_text`). Providers do not return `reasoning` yet
   (that is Step 3), so these entries are dormant until then — the append sites
   are already correct and tested via fake providers.
4. **Entry shape:** `tool_call.callId` is taken from
   `completionStream.functionCall?.id ?? null` — aibitat does not synthesize
   call IDs for providers whose functionCall lacks one (UnTooled paths). The
   trace stores `arguments` verbatim from the provider (string or object);
   parsing stays in the tooled helpers, per the existing division of labor.
5. **Unknown-function branch is traced too:** a call to a nonexistent tool
   appends the `tool_call` plus a `tool_result` with the
   `Function "<name>" not found.` error content — matching the `role:"function"
   message the recursion actually sees.
6. **Flush plumbing lives on aibitat, persistence in the plugin (ownership
   split):** `aibitat.scheduleTraceFlush()` owns coalescing (`_traceFlushPending`)
   and throttling (`_traceFlushLastRunAt` vs `AGENT_TRACE_FLUSH_INTERVAL_MS`,
   default 500 ms) and calls the blind optional hook `this.flushTrace?.()`;
   the chat-history plugin attaches `aibitat.flushTrace = () =>
   this._flushTrace(aibitat)` at setup. The draft implied the plugin would
   own scheduling too — it does not; the scheduler stays dumb so it never
   throws into the tool loop and works in deployments without the plugin.
7. **Step 5.1/5.2 landed early with Step 2** (same commit): finalize
   (`_store`/`_storeSpecial`) drains the trace into the upsert payload via
   `_serializeTrace` (fail-open → `trace: null`, N10), and `_cleanup()` calls
   `clearTrace()` alongside the other pending buffers. See Step 5 deviations
   for what that changed.

## Step 2b — Incremental trace flush (F11, F12 partial, N11, N12)

Adds durable mid-turn persistence so a Stop or crash loses at most the single
tool call in flight. All flushes are **fire-and-forget** (not awaited by the
tool loop) and never touch `include`, debits, or rename (N11).

1. **Flush trigger** — in `handleAsyncExecution`/`handleExecution`, immediately
   after a tool call completes and its `tool_result` entry is appended to the
   trace buffer, schedule a flush (coalesced: if a flush is already pending,
   skip scheduling another — the pending one serializes the newer buffer).
   Flushes are additionally throttled to a **default-on** minimum interval of
   500 ms (cheap insurance on SQLite's single-writer; the pending flush
   serializes the newest buffer, so throttling costs only latency, never data).
2. **Flush implementation** — in `chat-history.js`, a `_flushTrace()` helper:
   read the placeholder row's current `response` JSON, merge in `trace:
   serialized buffer`, and upsert the merged object. `WorkspaceChats.upsert`
   overwrites `response` wholesale (0.4/0.15), so the read-modify-write is
   mandatory — a bare `{ trace }` upsert would clobber existing keys. **Where
   clause (review finding):** `WorkspaceChats.upsert` matches on
   `{id, user_id: data.user?.id || null}` — the flush helper must pass
   `user: {id: invocation.user_id || null}` consistently or the where won't
   match and the upsert will silently create-branch-fail. Serialize
   the **full** buffer every time (last-write-wins), re-check the N6 size cap at
   flush time. Because the read and write are not atomic, flushes must check
   `aibitat._finalized` immediately before the upsert and skip if the
   abort-save or finalize has already claimed the row (Step 6.3); the helper
   must also guard explicitly on `aibitat.trackedChatId` being present — a
   coalesced flush scheduled just before finalize fires after `_cleanup()`
   calls `clearTrackedChatId()`, and the `_finalized` check alone does not
   cover every ordering.
3. **Failure handling** — try/catch around the upsert; on error log and drop
   (N12). Never throw into the tool loop.
4. **Serialized shape** — same as Step 5's finalize shape, so a crash leaves a
   row whose `response.trace` is already in final form; finalize later simply
   rewrites it with the complete buffer plus text/metrics.
5. **Deviations from the original draft:** (record as they occur)

### Step 2b deviations (implemented in commit `416da428`, 2026-10-24)

1. **Flush target resolution uses `WorkspaceChats.get` + explicit
   `user_id` matching** per the review finding: the flush reads the row via
   `WorkspaceChats.get({ id, user_id: invocation.user_id || null })` and passes
   the same `user: { id }` shape to `upsert`, so the where-clause matches the
   placeholder row the way the finalize path does.
2. **Graduated write-time truncation added to `_serializeTrace`** (beyond the
   plan's "re-check cap at flush time"): if the serialized trace still exceeds
   the max despite append-time capping (e.g. the env cap was lowered between
   appends and flush, or accounting drift), the serializer first trims
   `tool_result.content` strings to 1024 chars; if still over, it degrades
   tool_result contents to `"[truncated]"` skeletons — always preserving the
   entry list and `llmCalls`, and marking `truncated: true` (N6/AC).
3. **Cap constant duplicated, not imported:** `_serializeTrace` mirrors
   `AIbitat.traceMaxBytes()`'s default locally (with the same env override)
   instead of requiring aibitat from the plugin — the comment marks it
   deliberate (avoids a plugin→core require-direction wrinkle). If the env var
   changes between aibitat and plugin reads they agree, since both parse the
   same variable; drift risk is noted here for the record.
4. **Double ownership check:** `_flushTrace` checks `_aborted || _finalized`
   *before* doing any DB work **and re-checks both plus
   `trackedChatId === chatId` after the read await** — the post-await recheck
   closes the read-modify-write window where finalize/abort claims the row
   while the flush holds a stale read (plan Step 6.3 / 0.15 race).
5. **`_finalized` is pre-wired but not yet set anywhere** (as of this commit).
   The flag is checked by the flush guards per plan Step 6.3, but the writers
   that would set it (abort save, and optionally `_store`) are Step 6 scope.
   Until then the guards are effectively `_aborted` + `trackedChatId` only —
   which is complete for the current writer set, because finalize's upsert is
   synchronous with the tool loop unwind (no pending flush can interleave
   after `_cleanup()` clears `trackedChatId`, and the trackedChatId guard
   covers exactly that ordering).
6. **Flush upsert deliberately omits `include`** (N11) with a code comment
   explaining that the create-branch default (`true`) never applies because
   the placeholder row is guaranteed to pre-exist (plan 0.11) — deviation in
   documentation only; behavior matches the plan.

## Step 3 — Provider adapters: surface reasoning + history reconstruction

1. `tooled.js`: return `reasoning: reasoningText` from `tooledStream` /
   `tooledComplete` alongside existing fields (additive; existing consumers
   unaffected). When reasoning is returned on a tool-call turn, the caller
   pushes the `reasoning` trace entry.
2. Each provider's `stream()`/`complete()` wrapper maps the new field through.
   **Correction (0.2 review):** for the tooled path there is **nothing to
   strip** — `tooledStream` never puts reasoning in `textResponse`; the work is
   threading `reasoningText` out of the stream loop as the new return field
   (Step 3.1), which also fixes the stray-`</thought>` artifact for text turns
   for free. The shared `<thought>`-parsing helper (Step 1 risk note) applies
   only to non-tooled provider paths where reasoning arrives as `<thought>`
   text mixed into content; extract with the helper and remove from
   `textResponse` *only if* the provider previously stripped it (verify — do
   not double-strip; see Step 1 table).
3. History reconstruction for the next turn (F4): in
   `AgentHandler.#chatHistory` (`server/utils/agents/index.js`), for each loaded
   row, expand the flat `USER/assistant` pair into:
   - USER message (unchanged),
   - per trace entry: reasoning → assistant message with reasoning content
     (provider-appropriate), tool_call → assistant message with
     `originalFunctionCall` (so `formatMessagesForTools` synthesizes the OpenAI
     pair for free, and Anthropic's converter does likewise),
     tool_result → `role:"function"` message with matching `originalFunctionCall.id`,
   - final assistant text message (unchanged).
   Respect N5: truncate oversized `tool_result.content` at reconstruction time
   with a `[truncated]` marker (full text stays in the DB).
   **Required touchpoint (review finding):** reconstructed messages will NOT
   flow through for free by injecting them into `aibitat._chats`. The pipeline
   is `AgentHandler.#chatHistory` → AIbitat constructor `chats` →
   `getHistory()` → **`getOrFormatNodeChatHistory()`** (`aibitat/index.js`) →
   provider messages, and `getOrFormatNodeChatHistory` currently maps every
   chat to `{role, content}` (+attachments), **dropping `originalFunctionCall`
   and any intermediate-message shape**, and assigns roles via
   `c.from === route.to ? "user" : "assistant"` — a reconstructed `tool_result`
   message (also `from: WORKSPACE_AGENT`) would come out as a second
   "assistant" role, not a function message. Without fixing this, the entire
   F4 mechanism is dead on arrival. Either (a) update
   `getOrFormatNodeChatHistory` to pass through messages carrying
   `originalFunctionCall`/trace metadata unchanged, or (b) inject reconstructed
   messages at `reply()`'s message-array build instead of into `_chats`.
   `agent-history-reconstruction.test.js` must assert survival through
   `getOrFormatNodeChatHistory`, not just `formatMessagesForTools`.
4. UnTooled labeling (F8): extend `cleanMsgs` to label collapsed function
   messages with `[tool:<name>(<args>)]` when `originalFunctionCall` is present.
   **Deviations:** (record)

### Step 3 deviations (recorded 2026-10-26; Step 3 code committed as 3d2ece02)

1. **Provider scope narrowed for validation: Ollama, Venice, OpenRouter only.**
   The Step 3 implementation and its testing target exactly three providers.
   The architecture keeps the work provider-agnostic by construction (per the
   Step 1 load-bearing finding), so the scope restriction costs nothing:
   - **Venice / OpenRouter** are `InheritMultiple([Provider, UnTooled])`
     wrappers that return the shared helpers' objects verbatim — the
     `tooled.js` / `untooled.js` reasoning-threading edits **are** their
     implementation; no per-provider file changes are made or needed.
   - **Ollama** is the only one of the three with its own adapter work
     (native tooled `stream()` normalization to the A-shape,
     `streamingFunctionCall` override threading, `<think>` legacy-tag
     acceptance in `helpers/trace.js#extractThought`).
   - All other providers keep the uniform `reasoning: ""` return shape
     (shape-uniformity stubs only, ~7 lines each) but their native reasoning
     capture is **untested and unsupported** until/unless explicitly widened.
     The capability flag `supportsReasoningHistory` stays `false` for everyone
     except the three validated providers (Step 4 scope shrinks accordingly).
2. **Anthropic `#prepareMessages` tool_use synthesis is included despite the
   narrowed scope** — it is the Step 1 finding #3 fix (row D) the plan already
   committed to: `#prepareMessages` now synthesizes the `tool_use` block from
   `originalFunctionCall` when the preceding assistant message has no
   content-array, fixing the pre-existing in-turn tool_result drop. Kept
   because history reconstruction would otherwise be silently broken for that
   provider and the fix is small, self-contained, and audit-mandated. If the
   PR is later scoped strictly to the three providers, this is the one chunk
   to split into its own commit.
3. **Reasoning-threading shape confirmed per 0.2/Step 1 table:**
   `tooledStream` accumulates a clean `fullReasoning` (returned as `reasoning`)
   while keeping the live `<thought>` tag-state stream for the UI, and stops
   appending the closing-tag chunk to `textResponse` — fixing the
   stray-`</thought>` artifact (0.2) as a side effect, exactly as planned.
   Path C (tag-embedded plain-chat fallback) is deliberately left untouched;
   the handler layer splits it via `extractThought`.
4. **`#chatHistory` → public `chatHistory`** (testability): JS private methods
   enforce a brand check that makes them unreachable from test scaffolding
   (subclass or `Object.create` receivers throw "Receiver must be an instance
   of class AgentHandler"). The method was made public with a JSDoc note
   marking it internal-but-testable; behavior is identical and the call site
   is unchanged.
5. **F8 label tests landed inside `tooled.trace.test.js`** rather than the
   separate `untooled.labels.test.js` listed in the Step 8 test table — the
   label injection is exercised through the same handler scaffolding as the
   reconstruction tests, so a separate file would duplicate the mock setup
   (mock paths, `formatMessageWithAttachments` borrowing, real-`
   AgentHandler` construction). Coverage is identical.
6. **Handler test scaffolding requirements** (for future test authors): the
   handler must be a real `AgentHandler` instance (private-method brand
   check), aibitat node registration must use `WORKSPACE_AGENT.name`
   (`"@agent"` prefix), history must be routed via the `reply()` direction
   for `getOrFormatNodeChatHistory`, and standalone `UnTooled` instances
   must borrow `Provider.prototype.formatMessageWithAttachments` (that
   method lives on the base class and `cleanMsgs`/`streamingFunctionCall`
   call it unconditionally).

## Step 3b — Stop reason (F12) + crash recovery promotion (F13)

1. **`stopReason` plumbing** — AIbitat gains a `stopReason` field, set at every
   exit path:
   - `completed` — set in the finalize path (`_store`/`_storeSpecial` default
     when no other reason was set).
   - `user_abort` — set in the abort handler (Step 6) before the abort upsert.
   - `provider_error` — set wherever a provider/tool exception escapes
     `reply()` and ends the turn (verify exact catch sites in Step 0 follow-up;
     the turn still saves via the error path today).
   - `interrupted` — never set in-process; written only by promotion (below).
   Persisted inside `response.stopReason` in every save that writes the row
   (finalize, abort save, and flushes may carry the in-progress `null`).
2. **Promotion on next invocation** — in `AgentHandler` (or `chat-history`'s
   first `onMessage` listener, wherever thread-scoped setup happens — decide
   during implementation), before the new turn executes: fetch the last N
   `include:false` rows for this workspace/thread (`orderBy id desc`, take ~5)
   and filter **in JS** by parsing `response.trace` —
   `workspace_chats.response` is a plain String column, so Prisma cannot
   filter on a key inside the JSON (`hasTrace`-style filters don't exist; do
   not reach for raw SQL or a schema change — the bounded fetch + JS filter is
   cheap, and the recency guard from 0.14 slots directly into the JS filter).
   Target the latest row with a non-empty
   `response.trace` and no `stopReason`. If found, promote exactly once:
   `include: true`, `stopReason: "interrupted"` (F13/AC18). The promoted row
   then flows into `#chatHistory` reconstruction like any traced row.
3. **Guard** — promotion must be idempotent (the `stopReason` field doubles as
   the promoted-marker) and must not run for brand-new threads with no prior
   rows.
4. **Deviations:** (record)

### Step 3b deviations (recorded 2026-10-26; Step 3b code committed as 6af915d9)

1. **`_finalized` writers landed here, not in Step 6.** The flag that Step 2b
   pre-wired (and whose guards the flushes already honor) now has its writers:
   `_store`/`_storeSpecial` set it before their upserts, so pending flushes
   stand down once the turn row is claimed. This closes the Step 6.3 race
   surface early; Step 6's abort-save writer remains the only missing piece.
2. **Error-path save (AC17) added as a new `onError` listener in the
   chat-history plugin (`_storeError`)** — the plan drafted this as Step 6
   scope ("the turn still saves via the error path today" was verified false
   for turns that die before finalize: the placeholder row stayed
   `include:false` forever, indistinguishable from an abort ghost). It landed
   with 3b because it is the `provider_error` stop-reason's persistence half.
   The save is fail-open, carries the trace-so-far, debits recorded session
   usage, and never claims a row after finalize/abort.
3. **Promotion runs in `AgentHandler.chatHistory()`** (the decision the plan
   left open between AgentHandler and the plugin's first listener): it is
   thread-scoped first-read work, it keeps the reconstruction tests at the
   single injection point the Step 3 deviations already documented (public
   method, brand-check-safe), and the plugin's first listener has no access to
   the workspace/thread scope without duplicating invocation plumbing.
4. **`"completed"` default set in `_store`/`_storeSpecial` via the existing
   payload** — `stopReason` defaults to `"completed"` exactly when no other
   reason was recorded (first-writer-wins makes this safe); flushes carry the
   in-progress `null` and never write a stop reason.
5. **Test placement deviates from the Step 8 table:** stop-reason persistence
   tests live in `trace-buffer.test.js` (which already owns the aibitat +
   chat-history-plugin scaffolding the AC17 tests need) rather than a separate
   `stop-reason.test.js`; promotion coverage lives in `tooled.trace.test.js`
   alongside the reconstruction block rather than `crash-recovery.test.js`.
   A separate file would duplicate the handler mock setup (see Step 3
   deviation 6). Coverage is identical.
6. **Reconstruction test harness change:** the `WorkspaceChats.where` mock is
   now clause-aware (`include:false` promotion lookup vs `include:true`
   history load) because `chatHistory()` now runs promotion first on every
   call.

## Step 4 — In-turn reasoning retention (F5)

In `handleAsyncExecution`/`handleExecution`, when building `newMessages` for the
next recursion, include prior reasoning from the trace buffer for providers that
accept assistant thinking history (per Step 1 table: e.g. DeepSeek
`reasoning_content` injection, Anthropic thinking blocks with signatures).
Providers that reject such fields get plain assistant-text fallback (the
`<thought>`-tagged text as an assistant message). Gate per provider via a
capability flag on the provider instance
(`supportsReasoningHistory: true/false`) set in Step 1's audit.

### Step 4 deviations (implemented 2026-10-26, commit `d6968fde`)

1. **Capability flag is three-valued, not boolean.** The plan drafted
   `supportsReasoningHistory: true/false`; implemented as
   `true` (native reasoning field retention), `"text"` (`<thought>`-tagged
   assistant-text fallback), or `false` (base default — today's behavior,
   byte-for-byte). The three-valued shape lets the base class express the
   fallback mode explicitly instead of inferring it from `!== true`, and keeps
   `false` semantically identical to pre-Step-4 behavior for all providers
   outside the three validated ones.
2. **Carrier via the `role:"function"` message, not `newMessages` surgery.**
   Rather than rewriting prior assistant messages in `newMessages`, each
   round's function-result message carries that round's reasoning as an
   `__inTurnReasoning` marker; `#applyReasoningRetention` translates markers
   per capability immediately before every provider call (native →
   `__reasoningField`/`__reasoningText` carrier, `"text"` →
   `<thought>`-wrapped content prefix, `false` → stripped). Markers never
   reach a provider.
3. **Retention merge happens in the tool-call converters.**
   `formatMessagesForTools` (covers Venice/OpenRouter tooled paths, and runs
   before DeepSeek's `injectReasoningContent` so a real carrier can't be
   overwritten by the empty-string synthesis) merges the carrier onto the
   synthesized assistant tool-call message; Ollama's
   `#formatMessagesForOllamaTools` merges it as Ollama's native `thinking`
   field.
4. **Flag enablement (validation scope: Ollama/Venice/OpenRouter only):**
   Ollama — dynamic off `thinkLevel` (boolean `false` "off" excluded), field
   `thinking`; Venice — `reasoning` flag from the cached capabilities report
   (fail-closed); OpenRouter — default off, env-gated opt-in via
   `PROVIDER_SUPPORTS_REASONING_HISTORY` (upstream model variance makes
   default-on unsafe). All other providers inherit the base `false`.
5. **Test-harness note:** `reply()` rebuilds `providerInstance` via
   `getProviderForConfig` every turn — capabilities and message capture must
   be injected through the class-level provider mock (`_capabilities` applied
   in the constructor, static `seenMessages`), not assigned per-instance.
   Suite: 62 suites / 572 tests green; server lint clean.

## Step 5 — Persist the trace (F1–F3, F12, N2, N6, N10)

1. In `chat-history.js` `_store` / `_storeSpecial`: drain
   `aibitat.getTrace()` into the upsert payload:
   `response.trace = { entries, llmCalls, truncated }` and
   `response.stopReason = aibitat.stopReason || "completed"`.
2. Clear the buffer in `_cleanup()` alongside `_pendingCitations` etc.
3. Size-cap guard re-checked at write time (N6): serialize, cap, mark truncated.
4. Wrap the trace portion in try/catch (N10): on failure, save the row with
   `trace: null` and log — never block the primary save. (Wording note: there
   is a single `response` column, so "split the write" means serialize the
   trace in its own try/catch and fall back to `trace: null` so a trace
   serialization failure cannot abort the whole upsert.)
5. `models/workspaceChats.js` — no schema change required if the trace lives
   inside the existing `response` JSON column. **Decision point (record in
   deviations):** keep-in-JSON (chosen — avoids a migration and preserves N3
   trivially) vs. a dedicated `trace` TEXT column (rejected for now: migration
   cost, and SQLite row-size characteristics favor the single JSON blob).
   Validate the JSON column can hold the capped size (2 MB default) on SQLite
   and Postgres; if not, reduce default cap.
6. Finalize **overwrites** whatever partial `response.trace` flushes wrote
   (Step 2b) with the full buffer — the finalize write remains the single
   authoritative version of the turn.

### Step 5 deviations (items 5.1/5.2/5.4 landed in `416da428`; completed 2026-10-26 — see below)

Items 5.1, 5.2, and 5.4 landed with Step 2 (same commit) since the finalize
path is where the buffer gets drained; the rest of Step 5 is unaffected.

1. **5.1 done, with one shape choice:** `_store`/`_storeSpecial` call the
   plugin's `_serializeTrace(aibitat)` and put the result under
   `response.trace` in the upsert payload. The serialized shape is
   `{ entries, llmCalls, truncated }` exactly as drafted — except that
   `response.stopReason` is **not yet written** (Step 3b scope; the plan's
   Step 5.1 draft bundled it, it is deferred to its own step).
2. **5.2 done:** `_cleanup()` calls `aibitat.clearTrace?.()` first, then
   `clearTrackedChatId()` — the ordering matters because a coalesced flush
   firing after cleanup is caught by the `trackedChatId` guard.
3. **5.4 done, wording resolved as the plan's note suggested:** the trace is
   serialized in its own try/catch (`_serializeTrace` returns `null` on any
   error and logs `[AgentTrace]`), so a trace failure can never abort the
   primary upsert — the row saves with `trace: null`. Covered by the
   "trace serialization failure is fail-open" test.
4. **5.3 partially superseded:** the append-time cap (Step 2) plus the
   graduated flush-time truncation (Step 2b deviation 2) make a separate
   finalize-time size check redundant — `_serializeTrace` applies the same
   write-time guard on every write path (flush and finalize alike).
5. **5.5 decided:** keep-in-JSON confirmed (no schema change made;
   `response` remains a plain String column — Prisma serializes the payload
   object). 2 MB cap validated in tests via small `AGENT_TRACE_MAX_BYTES`
   values; no SQLite/Postgres size issue at that cap.

### Step 5 completion (2026-10-26)

Step 5 is now **fully complete**. Items 5.1/5.2/5.4 landed early (above);
the remainder needed no new production code — it was already satisfied by
design choices made in Steps 2/2b/3b, verified rather than re-implemented:

1. **5.3 fully superseded (confirmed):** the append-time cap (Step 2) plus
   the graduated flush/finalize-time truncation (`_serializeTrace` applies
   the same write-time guard on every write path) make a separate
   finalize-only size check redundant. No code added.
2. **5.6 verified + test added:** finalize's upsert writes the full
   `response` payload (including `trace`) wholesale — `WorkspaceChats.upsert`
   overwrites the column, so a stale partial trace from Step 2b flushes is
   replaced, never merged. A regression test
   ("finalize overwrites a stale flushed partial trace with the full
   buffer", Step 5.6) was added to `trace-buffer.test.js` to pin the
   last-write-wins contract.
3. **`response.stopReason` (the 5.1 deferred piece) landed with Step 3b**
   (`6af915d9`): `_store`/`_storeSpecial`/`_storeError` all persist
   `stopReason` (`completed` default / `user_abort` / `provider_error`),
   first-writer-wins via `aibitat.stopReason`.
4. **Step 8 test-table note:** `chat-history.trace.test.js` does not exist
   as a separate file — its coverage (trace in upsert payload, `_cleanup`
   clears buffer, N10 failure isolation, N2 same-row upsert) lives in the
   "Trace persistence at finalize (Step 5)" block of
   `trace-buffer.test.js`, which owns the aibitat + plugin scaffolding
   (same consolidation pattern as the Step 3b test-placement deviation).

## Step 6 — Abort-time partial save (F9, F12, AC8)

1. Hook the abort path. **Prerequisite (elevated from a footnote):** verify
   where `abort()` is invoked from (socket close handler) — the `"abort"`
   event fires *before* the tool loop unwinds, so saving inside the event
   handler is unreliable; save in the unwind path instead (the terminate branch
   of `chat()` / the abort returns in `handleAsyncExecution`). Note that
   `#safeProviderCall` rethrows abort errors, so the in-flight call's partial
   `textResponse` never returns to `handleAsyncExecution` — either accumulate
   a `_partialText` buffer on aibitat from `textResponseChunk` events (planned
   mechanism for "whatever partial text reached the client") or commit to
   `text: ""` for the in-flight call (prior rounds' text survives in the trace
   as `llm_text` entries either way). When the abort save runs (after in-flight
   work unwinds), set
   `aibitat.stopReason = "user_abort"`, then upsert the current row:
   `include: true`, `response.aborted: true`, `response.stopReason:
   "user_abort"`, `response.text` = whatever partial text reached the client
   (or empty), plus the trace-so-far.
   **Correction from Step 0 (0.8):** the abort save must always set `text` to
   a **string** (empty string is acceptable) — `convertToChatHistory` skips
   rows whose `data.text` is not a string (`responses.js:197-202`), so a
   non-string/missing `text` would make the aborted turn invisible in UI
   history.
2. Idempotency: an `aborted` row must not be re-finalized later, and must not
   double-debit (see 0.10). Guard with a flag on the row write
   (e.g. only upsert abort state if `trackedChatId` exists and
   `!aibitat._finalized`) and set `aibitat._finalized` in both `_store` and the
   abort handler. **Race note:** there is a window where normal finalize
   (`_store`) and the abort handler can both observe `!_finalized`.
   **Correction:** the abort save must gate on `!aibitat._finalized` **only** —
   do NOT include `_aborted` in the abort save's guard, because `_aborted` is
   always set by the time the abort save runs (it is set by `abort()` itself,
   before the unwind path reaches the save; see 0.9) and would skip the save
   every time. The `_aborted` check belongs to the other writer: `_store`
   already skips when `aibitat._aborted` is set (`chat-history.js:61`).
   Ownership contract: if `_aborted` is set, the abort handler owns the row
   and `_store` defers; the abort handler, in turn, only writes when the row
   has not been finalized. Pending flushes are a third writer and must check
   **both** flags — skip when `_aborted || _finalized` (a flush firing between
   `abort()` and the abort upsert would otherwise win the write and clobber
   `stopReason`/`include`; see the flush guard in Step 2b).
3. Pending flushes scheduled at abort time must be cancelled or made harmless
   (the abort upsert already serializes the final buffer; a later flush must
   not clobber `stopReason`/`include` — the flush helper writes `trace` only
   and must check `_finalized`).
4. Debit decision from 0.10 **resolved via 0.13**: `Credits.debit` performs no
   dedupe on `reference` (`server/models/credits.js#debit` stores but never
   checks it), so the abort path must not blindly re-call `_debitCredits`.
   Record as deviation: use a DB-backed guard — check
   `credit_transactions` for `reference: "chat_<id>"` before the abort debit
   (option (a) in 0.13; survives crashes) — and debit only when
   `providerInstance.getSessionUsage()` totals are > 0. Completed
   tool-loop rounds have usage already recorded; the in-flight aborted
   stream has zero recorded usage and is unbillable at abort by construction.
   If the reference-dedupe query races with the finalize debit in a
   concurrent-abort scenario, accept last-write-wins on the row but add the
   `_debited` in-process flag as a second guard (both guards together).

### Step 6 deviations (implemented 2026-10-26)

1. **Save points: three unwind sites, not two.** The plan drafted the abort
   save around (a) the terminate branch of `chat()` and (b) the abort returns
   in `handleAsyncExecution`. Implementation found a third, critical path the
   plan's own Step 6.1 note implies but does not enumerate: `#safeProviderCall`
   **rethrows abort errors verbatim** (never wrapped into `APIError`), so an
   abort during the in-flight LLM call never reaches the terminate branch at
   all — the error unwinds through `chat()`→`reply()` and is only caught at
   the websocket session boundary. If the save ran only in the terminate
   branch, that path (Stop pressed mid-stream, the most common abort) would
   persist nothing. Resolution: the abort save fires at all three sites —
   the post-tool abort branch in `handleAsyncExecution`/`handleExecution`,
   and inside `#safeProviderCall`'s abort-error rethrow. All three call the
   same idempotent hook (`aibitat.abortSave()`), so overlap is harmless.
   Verified by a test that aborts inside the provider script and asserts the
   save fired.
2. **`_partialText` accumulation lives on the execution eventHandler** — the
   per-round handler in `handleAsyncExecution` appends every
   `reportStreamEvent` `textResponseChunk` content to `aibitat._partialText`,
   and the buffer is reset at each round's start (fresh window per LLM call;
   prior rounds' text survives in the trace as `llm_text` entries either
   way). The sync `handleExecution` path does not accumulate (nothing
   streams incrementally; `text: ""` applies, per the plan's fallback).
3. **Debit guards landed in `_debitCredits`, not in the abort save.** The
   plan Step 6.4 drafted the reference-dedupe check + `_debited` flag as
   abort-save logic; implementation centralized both guards in
   `_debitCredits` (now taking `aibitat` as its first argument) so they
   protect **every** writer — finalize (`_store`/`_storeSpecial`/`_storeError`)
   AND the abort save — against each other, not just the abort direction.
   The DB-backed check is a new `Credits.hasDebitReference(userId,
   reference)` (`credit_transactions.findFirst` on `type:"debit"`,
   `reference: "chat_<id>"`) — option (a) in 0.13, crash-safe. `_debited`
   (on aibitat, initialized in the constructor) is the second guard. Both
   must pass before any `debitUsage` call.
4. **The abort save always debits recorded session usage** (not "only > 0
   totals") — the >0 condition is enforced naturally: `_debitCredits`
   early-returns on `(!inputTokens && !outputTokens)`, so a zero-usage
   abort (in-flight stream only) performs no debit without special-casing.
   Test-pinned.
5. **`response.aborted: true` is written alongside `stopReason:`
   `user_abort`** per plan Step 6.1's upsert shape. `text` is
   `aibitat._partialText || ""` — always a string (0.8).
6. **Test placement deviation (same pattern as 3b/5):** the abort-save tests
   live in `trace-buffer.test.js` (9 new tests, 30 total in the file) rather
   than a separate `abort-save.test.js` from the Step 8 table — the file
   already owns the aibitat + chat-history plugin scaffolding, including the
   provider mock (which gained a static-overridable `getSessionUsage` and
   `models/credits` + `models/user` mocks for the debit assertions).
   The existing "flush is skipped once the run is aborted" test was updated:
   with the abort save now real, that turn produces exactly one include:true
   write (the abort save) instead of zero upserts.

## Step 7 — Frontend additive exposure (F7)

- **Correction from Step 0 (0.8):** history endpoints do **not** return the
  full `response` JSON. `convertToChatHistory`
  (`server/utils/helpers/chat/responses.js:184-230`) whitelists response keys
  (`text`, `sources`, `type`, `attachments`, `metrics`, `outputs`,
  `clarifyingQuestions`) and silently drops everything else; both thread and
  workspace history endpoints route through it
  (`server/endpoints/workspaceThreads.js:113-136`,
  `server/endpoints/workspaces.js:465`). Exposing `trace` therefore requires
  an explicit additive passthrough: add
  `...(data?.trace ? { trace: data.trace } : {})` to the assistant object in
  `convertToChatHistory`, mirroring the existing `outputs` pattern.
- Render contract: `HistoricalMessage`/`PromptReply` must tolerate the new key
  (they ignore unknown fields today — verified, 0.8). A minimal read-only
  "tool timeline" may be added in this workstream only if trivial; otherwise
  the follow-up UI workstream owns it (see spec Out-of-scope). Record decision.
- Add one test to `trace-exposure.test.js` asserting the passthrough survives
  the serializer (not just the DB row).

## Step 8 — Tests (merge gate)

All in `server/__tests__/utils/agents/`:

| Test file | Covers |
|-----------|--------|
| `trace-buffer.test.js` | Step 2: append ordering, llmCall numbering, cap/truncation marker, clear. |
| `providers/helpers/tooled.trace.test.js` | Step 3: `reasoning` surfaced on tool-call and text branches; no double-strip. |
| `agent-history-reconstruction.test.js` | Step 3.3: next-turn messages contain synthesized tool_calls/tool pairs; N5 truncation marker; AC21 strict-shape provider receives only valid pairs (malformed pairs degrade to plain text). |
| `untooled.labels.test.js` | AC7: labeled collapse format. |
| `chat-history.trace.test.js` | Step 5: trace in upsert payload, `_cleanup` clears buffer, N10 failure isolation, N2 same-row upsert. |
| `server/__tests__/utils/helpers/trace-exposure.test.js` (lives under `helpers/`, not `agents/` — it tests `server/utils/helpers/chat/responses.js`) | AC20 (F7): workspace thread history fetch returns `response.trace` intact for traced rows. |
| `trace-flush.test.js` | Step 2b: flush after each completed tool call keeps `include:false`, no debit, full-buffer last-write-wins serialization, failure is swallowed (AC16, AC19). |
| `stop-reason.test.js` | Step 3b/5/6: `completed` on finalize, `user_abort` on abort, `provider_error` on provider exception (AC17). |
| `crash-recovery.test.js` | Step 3b: orphaned flushed row promoted once with `stopReason: "interrupted"` on next invocation; promotion excluded for rows without trace (AC18). |
| `abort-partial-save.test.js` | AC8: aborted row upserted once, include:true, no double-debit. |
| `regeneration.trace.test.js` | AC9: superseded trace excluded from context, retained on row. |
| `credits.unchanged.test.js` | AC10: debit math identical for same usage. |
| `legacy-rows.test.js` | AC11/AC15: rows without trace load clean; standard chat row shape unchanged. |

Run: `npx jest server/__tests__/utils/agents` plus full `yarn test` before merge.

## Step 9 — Risk table

| Step | Risk | Level | Mitigation |
|------|------|-------|------------|
| 3 (history reconstruction) | Blows context window / provider rejects mixed message shapes | **High** | N5 truncation + per-provider capability flags; Step 1 audit gates every provider before reconstruction is enabled for it. Feature-flag the reconstruction (`AGENT_TRACE_RECONSTRUCTION=1` default-on post-audit) so a bad provider can be exempted without redeploy. |
| 3 (Anthropic converter) | Anthropic tool_use/tool_result pairing requires strictly alternating, signed thinking blocks | High | Validate pair integrity in reconstruction; drop malformed pairs to plain text (fail-open to today's behavior) with a logged warning. |
| 2 (trace buffer) | Unbounded growth mid-turn | Medium | Cap check on every append (N6). |
| 5 (JSON size) | `response` column size limits on SQLite/Postgres | Medium | Cap default; verify in Step 0.5/5. |
| 6 (abort save) | Double-debit / double-finalize races | Medium | `_finalized` flag; **Credits has NO reference dedupe (0.13)** — guard requires both a `credit_transactions` reference check and the `_debited` in-process flag; test in `abort-partial-save.test.js`. |
| 6 (abort save) | Abort fires mid-stream, partial text saved and shown as complete in UI | Medium | `aborted: true` + `stopReason: "user_abort"` markers distinguish the row; frontend ignores them for final rendering (verify in Step 7). |
| 2b (flush) | Flush write latency contends with tool execution on SQLite (single-writer) | Medium | Flushes are fire-and-forget and coalesced (max one pending per turn) with a **default-on** minimum-interval throttle of 500 ms (the pending flush serializes the newest buffer, so throttling costs latency only, never data); failure is swallowed (N12). Re-serializing the full capped buffer (2 MB) per flush is acceptable at that rate; tighten further only if measured contention demands it. |
| 2b/3b (flush + promotion) | A promoted crash row double-counts with the new turn's own debit, or promotion races a still-alive turn (e.g. second tab) | Medium | Promotion only targets rows with no `stopReason`, a non-empty trace, and a stale `lastUpdatedAt` (recency window, 0.14) — a live turn's placeholder is refreshed by each flush, so staleness implies a dead turn; worst case the promoted row is simply visible history, which is safe. |
| 2b (flush) | Non-atomic read-modify-write races the abort-save / finalize upsert; a stale flush resurrects old `response` keys or clobbers `stopReason` | Medium | Flushes re-check `_finalized` immediately before the upsert and skip if claimed (Step 6.3); last-write-wins means finalize always rewrites with the full buffer (Step 5.6); worst case is a lost flush, which is bounded data loss by design (F11). |
| 7 (frontend) | Trace dropped by the server-side history serializer before it reaches the browser | **Resolved (0.8)** | `convertToChatHistory` whitelists keys and would silently drop `trace`; Step 7 now explicitly adds the passthrough and a serializer-level test. |
| 8 (tests) | Provider matrix drift (new providers added without trace support) | Low | Capability-flag default `false` → provider degrades to today's behavior, never breaks. |

## Step 10 — PR / status log

| PR | Contents | Status |
|----|----------|--------|
| (pending) | Steps 1–2 (audit + buffer) | Step 1 ✅ commit `9e0671f2`; Step 2 (+2b, +5.1/5.2/5.4) ✅ commit `416da428` — PR not yet opened |
| (pending) | Steps 2b, 3b (flush, stop reason, crash promotion) | 2b ✅ (landed early, `416da428`); 3b ✅ committed (`6af915d9`, 2026-10-26): stop reason plumbing (first-writer-wins; `user_abort` in `abort()`, `provider_error` in `newError()`, `completed` default at finalize), `_finalized` writers landed (flush guards now fully armed), error-path turn save (AC17, `_storeError`), crash-recovery promotion (F13/AC18); see Step 3b deviations. Suite: 62 suites / 584 tests green; server lint clean. |
| (pending) | Steps 3–4 (providers + reconstruction + in-turn retention) | 3 ✅ committed (3d2ece02, 2026-10-26): reasoning threading (tooled/untooled/ollama), reconstruction, trace.js helper, Anthropic fix; see Step 3 deviations — **validation scope: Ollama/Venice/OpenRouter only**. Suite: 62 suites / 566 tests green; server lint clean. 4 ✅ committed (`d6968fde`, 2026-10-26): in-turn reasoning retention (three-valued capability flag, function-message carrier, converter merge; see Step 4 deviations). Suite: 62 suites / 572 tests green; server lint clean. |
| (pending) | Steps 5–7 (persistence + abort + frontend exposure) | 5 ✅ complete (2026-10-26): 5.1/5.2/5.4 landed early (`416da428`); `stopReason` persistence landed with 3b (`6af915d9`); 5.3 superseded by the Step 2/2b write-time guards; 5.6 keep-in-JSON decided + last-write-wins finalize verified with a new regression test in `trace-buffer.test.js` (21 tests). No new production code required. 6 ✅ committed (2026-10-26): abort-time partial save (F9/AC8) — unwind-path `abortSave` hook at three sites (post-tool branch ×2 + `#safeProviderCall` abort rethrow), `_partialText` accumulation on the streaming eventHandler, `_storeAborted` (include:true, `aborted:true`, `stopReason:user_abort`, string text, trace-so-far, idempotent via `_finalized`), centralized double-charge guards in `_debitCredits` (`Credits.hasDebitReference` DB check + `_debited` flag; see Step 6 deviations). Suite: 62 suites / 594 tests green; server lint clean. 7 🔲 |
| (pending) | Step 8 tests + docs (README) | trace-buffer.test.js ✅ (14 tests, in `416da428`); remaining files 🔲 |
