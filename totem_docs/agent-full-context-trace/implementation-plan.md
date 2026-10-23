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
| 0.2 | Where reasoning content is captured and whether it survives into subsequent calls within a turn. | `providers/helpers/tooled.js` (`tooledStream` — `reasoningText` accumulation), provider `stream()` implementations | 2026-10-23 | `tooledStream` accumulates `reasoningText` and wraps it in `<thought>` tags streamed to the client, but the *returned* `textResponse` includes the thought text and the function-call branch of the loop **never surfaces reasoning separately to `handleAsyncExecution`** — when a tool call is requested, `textResponse` may be empty and the reasoning is streamed-only. Provider-specific `injectReasoningContent` exists for DeepSeek-style fields. Need per-provider audit in Step 1. |
| 0.3 | The finalize path: what `reply()` returns and how `chat-history` receives it. | `aibitat/index.js#reply` → `newMessage({...route, content})` → `plugins/chat-history.js#onMessage` (second listener) | 2026-10-23 | Confirmed — `reply()` returns only the final string; the history plugin sees `aibitat.chats.slice(-2)` = `[USER msg, final agent string]`. Trace must be attached to `aibitat` (e.g. `aibitat._traceBuffer`) before `newMessage` fires, and drained in `_store`/`_storeSpecial`. |
| 0.4 | The two-phase save: pre-register + upsert by `trackedChatId`. | `plugins/chat-history.js` (`onMessage` first listener, `_store`, `_storeSpecial`, `_cleanup`) | 2026-10-23 | Confirmed. `WorkspaceChats.upsert(trackedChatId, {...})` overwrites `response` wholesale — trace keys must be added inside the same upsert payload. `_cleanup()` clears `_pendingCitations`/`_pendingOutputs`/surveys; trace buffer must be cleared there too. |
| 0.5 | How history is loaded into the *next* invocation. | `server/utils/agents/index.js#chatHistory` (limit 20 in `createAIbitat`) | 2026-10-23 | Confirmed — reads `include:true` rows, emits only `prompt` / `response.text` pairs. This is the reconstruction injection point: expand each pair to include tool-call assistant/tool messages built from the row's trace. |
| 0.6 | Native provider message formatting: can it accept interleaved assistant/tool messages for *history* turns? | `providers/helpers/tooled.js#formatMessagesForTools` | 2026-10-23 | Already handles `role:"function"` + `originalFunctionCall` → synthesizes `assistant.tool_calls` + `role:"tool"` pairs. **Key design decision:** if the next-turn history emits real aibitat messages with `originalFunctionCall` metadata, `formatMessagesForTools` converts them *for free* — no provider-format changes needed. Anthropic provider has an analogous converter (verify in Step 1). |
| 0.7 | UnTooled collapse behavior. | `providers/helpers/untooled.js#cleanMsgs` | 2026-10-23 | Confirmed — concatenates `function` content into the previous assistant message with no call labels. F8 fix lands here (label injection in `cleanMsgs` or in history expansion). |
| 0.8 | Frontend agent event pipeline & historical message rendering contract (what fields `response` JSON the UI reads). | `frontend/src/components/WorkspaceChat/...` (`HistoricalMessage`, `PromptReply`, `ThoughtContainer`) | 2026-10-23 | **Verified — and it contradicts the Step 7 draft.** The server-side serializer `convertToChatHistory` (`server/utils/helpers/chat/responses.js:184-230`) does **not** return the whole `response` JSON — it whitelists fields (`text`, `sources`, `type`, `attachments`, `metrics`, `outputs`, `clarifyingQuestions`) and drops everything else. Both history endpoints use it: `server/endpoints/workspaceThreads.js:113-136` (thread chats) and `server/endpoints/workspaces.js:465` (workspace chats). **Correction to Step 7:** exposing `trace` requires an explicit passthrough added to `convertToChatHistory` — "no server endpoint changes" was wrong. Second finding: rows whose `data.text` is not a string are **skipped entirely** (`responses.js:197-202`) — an abort-save row with an empty `text` would be invisible to the UI; the abort save must always set `text` to at least `""`. Frontend side is additive-safe: `HistoricalMessage` destructures known props only (`HistoricalMessage/index.jsx:30` `sources = []`, etc.) and ignores unknown keys. |
| 0.9 | Abort path end-state. | `aibitat/index.js#abort`, `chat-history.js` (`if (aibitat._aborted) return`) | 2026-10-23 | Confirmed — on abort the second listener returns early; the placeholder row stays `include:false` forever. F9 requires a new abort-time upsert. Verify where `abort()` is invoked from (socket close handler) to hook the partial-save. |
| 0.10 | Credit debit placement relative to any new save path. | `chat-history.js#_debitCredits`, `_storeSpecial` | 2026-10-23 | Debits happen inside `_store`/`_storeSpecial` after upsert. An abort-time save (F9) must NOT re-run debit against partially-billed usage unless session usage is available at that point (verify `providerInstance.getSessionUsage()` state at abort — partial usage may already be recorded via `recordUsage`). Decide: debit-on-abort if and only if usage > 0 and row not already debited (idempotency guard needed). **Resolved same day (see 0.13):** `getSessionUsage()` (`ai-provider.js:667-671`) returns the accumulated `_sessionUsage`, which only grows via `recordUsage` — and `recordUsage` is called from the usage-bearing chunk of each stream (`tooled.js` `chunk?.usage` arrives on the *final* chunk). A stream aborted before its final chunk contributes **zero** recorded usage for that call; completed tool-loop rounds are fully counted. So abort-time debit is safe against double-charging *completed* rounds only if an application-level guard exists (Credits has none — 0.13) and debits only when session usage > 0. |
| 0.11 | Flush target mechanics: can we upsert `response.trace` on the placeholder row without flipping `include`? | `models/workspaceChats.js#upsert`, `chat-history.js` placeholder creation | 2026-10-23 | Verified — `WorkspaceChats.upsert(id, {...})` takes an explicit payload; passing only `response` does not touch `include`. The placeholder row is created before the first LLM call (first `onMessage` listener), so `trackedChatId` exists before any tool call can complete → flushes always have a row to target. Must serialize the full buffer on every flush (last-write-wins), and flushes must NOT call `_debitCredits` / `_autoRenameThread`. |
| 0.12 | Crash-recovery detection point: when the next invocation loads history, what distinguishes an orphaned flushed row from a normal ghost? | `AgentHandler.#chatHistory` (`include:true` filter), `WorkspaceChats.where` | 2026-10-23 | Verified — orphaned flushed rows are invisible to `#chatHistory` (`include:false`) but findable via a direct `where(workspaceId, threadId, { include: false, hasTrace: true })`-style query at the start of a new invocation in the same thread. Promotion must happen exactly once (guard: only promote rows with non-empty `response.trace` and no `stopReason`). |
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
(`server/utils/agents/aibitat/providers/helpers/trace.js`).

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

## Step 2b — Incremental trace flush (F11, F12 partial, N11, N12)

Adds durable mid-turn persistence so a Stop or crash loses at most the single
tool call in flight. All flushes are **fire-and-forget** (not awaited by the
tool loop) and never touch `include`, debits, or rename (N11).

1. **Flush trigger** — in `handleAsyncExecution`/`handleExecution`, immediately
   after a tool call completes and its `tool_result` entry is appended to the
   trace buffer, schedule a flush (coalesced: if a flush is already pending,
   skip scheduling another — the pending one serializes the newer buffer).
2. **Flush implementation** — in `chat-history.js`, a `_flushTrace()` helper:
   read the placeholder row's current `response` JSON, merge in `trace:
   serialized buffer`, and upsert the merged object. `WorkspaceChats.upsert`
   overwrites `response` wholesale (0.4/0.15), so the read-modify-write is
   mandatory — a bare `{ trace }` upsert would clobber existing keys. Serialize
   the **full** buffer every time (last-write-wins), re-check the N6 size cap at
   flush time. Because the read and write are not atomic, flushes must check
   `aibitat._finalized` immediately before the upsert and skip if the
   abort-save or finalize has already claimed the row (Step 6.3).
3. **Failure handling** — try/catch around the upsert; on error log and drop
   (N12). Never throw into the tool loop.
4. **Serialized shape** — same as Step 5's finalize shape, so a crash leaves a
   row whose `response.trace` is already in final form; finalize later simply
   rewrites it with the complete buffer plus text/metrics.
5. **Deviations from the original draft:** (record as they occur)

## Step 3 — Provider adapters: surface reasoning + history reconstruction

1. `tooled.js`: return `reasoning: reasoningText` from `tooledStream` /
   `tooledComplete` alongside existing fields (additive; existing consumers
   unaffected). When reasoning is returned on a tool-call turn, the caller
   pushes the `reasoning` trace entry.
2. Each provider's `stream()`/`complete()` wrapper maps the new field through.
   For providers where reasoning arrives as `<thought>` text inside content,
   extract with the shared helper and remove from `textResponse` *only if* the
   provider previously stripped it (verify — do not double-strip; see Step 1 table).
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
4. UnTooled labeling (F8): extend `cleanMsgs` to label collapsed function
   messages with `[tool:<name>(<args>)]` when `originalFunctionCall` is present.
   **Deviations:** (record)

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
   during implementation), before the new turn executes: query for the latest
   `include:false` row in this workspace/thread with a non-empty
   `response.trace` and no `stopReason`. If found, promote exactly once:
   `include: true`, `stopReason: "interrupted"` (F13/AC18). The promoted row
   then flows into `#chatHistory` reconstruction like any traced row.
3. **Guard** — promotion must be idempotent (the `stopReason` field doubles as
   the promoted-marker) and must not run for brand-new threads with no prior
   rows.
4. **Deviations:** (record)

## Step 4 — In-turn reasoning retention (F5)

In `handleAsyncExecution`/`handleExecution`, when building `newMessages` for the
next recursion, include prior reasoning from the trace buffer for providers that
accept assistant thinking history (per Step 1 table: e.g. DeepSeek
`reasoning_content` injection, Anthropic thinking blocks with signatures).
Providers that reject such fields get plain assistant-text fallback (the
`<thought>`-tagged text as an assistant message). Gate per provider via a
capability flag on the provider instance
(`supportsReasoningHistory: true/false`) set in Step 1's audit.

## Step 5 — Persist the trace (F1–F3, F12, N2, N6, N10)

1. In `chat-history.js` `_store` / `_storeSpecial`: drain
   `aibitat.getTrace()` into the upsert payload:
   `response.trace = { entries, llmCalls, truncated }` and
   `response.stopReason = aibitat.stopReason || "completed"`.
2. Clear the buffer in `_cleanup()` alongside `_pendingCitations` etc.
3. Size-cap guard re-checked at write time (N6): serialize, cap, mark truncated.
4. Wrap the trace portion in try/catch (N10): on failure, save the row with
   `trace: null` and log — never block the primary save. Split the write so a
   trace serialization failure cannot abort the whole upsert.
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

## Step 6 — Abort-time partial save (F9, F12, AC8)

1. Hook the abort path: when `aibitat.abort()` fires (or the socket-close
   handler calls it), after in-flight work unwinds, set
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
   abort handler.
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
| `trace-exposure.test.js` | AC20 (F7): workspace thread history fetch returns `response.trace` intact for traced rows. |
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
| 2b (flush) | Flush write latency contends with tool execution on SQLite (single-writer) | Medium | Flushes are fire-and-forget and coalesced (max one pending per turn); failure is swallowed (N12); if contention shows up in practice, add a minimum-interval throttle (e.g. ≥500 ms between flushes) — recorded as a deviation if needed. |
| 2b/3b (flush + promotion) | A promoted crash row double-counts with the new turn's own debit, or promotion races a still-alive turn (e.g. second tab) | Medium | Promotion only targets rows with no `stopReason`, a non-empty trace, and a stale `lastUpdatedAt` (recency window, 0.14) — a live turn's placeholder is refreshed by each flush, so staleness implies a dead turn; worst case the promoted row is simply visible history, which is safe. |
| 2b (flush) | Non-atomic read-modify-write races the abort-save / finalize upsert; a stale flush resurrects old `response` keys or clobbers `stopReason` | Medium | Flushes re-check `_finalized` immediately before the upsert and skip if claimed (Step 6.3); last-write-wins means finalize always rewrites with the full buffer (Step 5.6); worst case is a lost flush, which is bounded data loss by design (F11). |
| 7 (frontend) | Trace dropped by the server-side history serializer before it reaches the browser | **Resolved (0.8)** | `convertToChatHistory` whitelists keys and would silently drop `trace`; Step 7 now explicitly adds the passthrough and a serializer-level test. |
| 8 (tests) | Provider matrix drift (new providers added without trace support) | Low | Capability-flag default `false` → provider degrades to today's behavior, never breaks. |

## Step 10 — PR / status log

| PR | Contents | Status |
|----|----------|--------|
| (pending) | Steps 1–2 (audit + buffer) | 🔲 |
| (pending) | Steps 2b, 3b (flush, stop reason, crash promotion) | 🔲 |
| (pending) | Steps 3–4 (providers + reconstruction + in-turn retention) | 🔲 |
| (pending) | Steps 5–7 (persistence + abort + frontend exposure) | 🔲 |
| (pending) | Step 8 tests + docs (README) | 🔲 |
