# Agent Full-Context Trace (Persistence of Tool Calls, Thoughts & Intermediate LLM Turns)

**Status:** Draft
**Scope:** Agent-path (`AgentHandler` / AIbitat) conversation context construction and `workspace_chats` persistence. Covers (a) in-session context fidelity — the model seeing every tool call, tool result, and its own reasoning within the current turn; (b) cross-turn persistence — what is saved to history so the *next* turn knows what already happened; (c) interruption resilience — what survives when the user stops the model mid-turn or the process dies, and how the record communicates why the turn ended.
**Depends on:** Existing chat-history plugin contract (`trackedChatId` two-phase write), workspace_chats schema, `formatMessagesForTools` reconstruction, all agent providers' `stream`/`complete` signatures, frontend agent event pipeline (`reportStreamEvent`), credit debiting (billing must stay accurate).

---

## 1. Problem

Agents lose information at exactly two boundaries, and both cause observable model misbehavior:

### P1 — The model forgets its own intermediate thoughts *across turns* (and after reload)

Only one row per turn is persisted: `{ prompt, response: { text, sources, ... } }`
(`chat-history.js` → `_store()` / `_storeSpecial()` → `WorkspaceChats.upsert`). The
entire intermediate trace of a turn — every `role:"function"` message, every tool
argument, every streamed `<thought>` block — lives only in the transient
`aibitat._chats` array, which is built fresh each invocation from `#chatHistory()`
(`AgentHandler.#chatHistory` → `WorkspaceChats.where(... include:true)` → pairs of
`prompt` / `response.text` only).

Consequences observed in practice:

1. **Repetition.** The model re-derives facts it already established, re-reads
   files it already read, re-runs tools it already ran, because the next turn's
   history contains only `USER → assistant-text` pairs. From the model's point of
   view, the previous turn's work *never happened* — it only sees the polished
   conclusion.
2. **"Did I hallucinate that tool call?"** When the user asks "wait, did you
   actually write that file?" the model has no record of its own tool call. It
   either falsely denies (hallucination accusation against itself), falsely
   confirms, or re-runs the tool to check — wasting time and side effects.

### P2 — The model forgets its intermediate state *within* a long turn

The per-turn `messages` array built by `handleAsyncExecution`/`handleExecution`
recursion *does* carry every tool result correctly
(`aibitat/index.js`, `handleAsyncExecution` — each recursion appends
`{ role:"function", content: result, originalFunctionCall }`). This part is sound
for providers that support native tool calling (`tooled.js` →
`formatMessagesForTools` reconstructs `assistant.tool_calls` + `role:"tool"` pairs
faithfully). But:

- Reasoning content (`reasoning_content` / `<thought>` blocks) captured by
  `tooledStream` is streamed to the frontend but **not appended to `messages`**,
  so on the next LLM call within the same turn the model's prior reasoning is
  gone — it literally cannot remember "having that thought", which the user
  reports as the model repeating itself mid-turn.
- For **UnTooled** providers (`untooled.js` → `cleanMsgs`), all `role:"function"`
  messages are *collapsed* into the preceding assistant message's text. Tool
  identity (which function, which arguments) is destroyed; only the raw output
  text survives, unlabeled. Prompt-based tool-calling models therefore cannot
  reliably tell which of their previous calls produced what — a direct cause of
  "did I already do that?" loops and duplicate calls.
- On **regeneration** (`chat-history.js` `onMessage`, `@agent:` branch), the
  `_chats` array is pruned to the last real user message *specifically so*
  prior tool results don't leak in — correct for re-running, but it reinforces
  that the trace was never meant to survive anywhere.

### P3 — No durable record for debugging or UI

Because intermediate calls are never persisted, there is no way to inspect a
past turn's tool trace in the UI, no way to debug "why did the agent decide X"
after the fact, and no data foundation for future features (trace replay,
tool-run auditing, context-window analytics).

### P4 — A stopped or crashed turn leaves a hole in history

Today an interrupted turn (user Stop, socket close, process death) either leaves
only an `include:false` placeholder row (abort path) or nothing at all (hard
crash — the in-memory trace dies with the process and the placeholder stays a
ghost forever). Even with trace-at-finalize (F1–F3), the user's stated intent —
"stop the model mid-turn, but it must still remember everything that happened"
— requires that partial activity is durably saved *close to when it happens*,
not only at finalize, and that every saved turn states *why* it ended so both
the model and the UI can distinguish a completed turn from an interrupted one.

---

## 2. Goal

Give the agent model a complete, faithful view of its own activity — every tool
call, every tool result, every reasoning block — both within a turn and across
turns, by (1) persisting the full intermediate trace of each turn and (2)
reconstructing that trace into the message history sent to the LLM on every
subsequent call, while leaving standard (non-agent) chat, billing accuracy, the
two-phase `trackedChatId` save contract, and all existing provider adapters
working unchanged.

Testable statement: after this workstream, a user can ask an agent in a later
turn "what tool did you call in the previous turn and what did it return?" and
the model answers correctly from context, without re-executing the tool; a
multi-tool turn no longer repeats already-completed tool calls mid-conversation;
and a turn stopped mid-flight (or killed by a process crash) is still remembered
— the next turn sees the completed tool calls and thoughts, tagged with the
reason the turn ended.

---

## 3. Requirements

### Functional

| ID | Requirement |
|----|-------------|
| F1 | Every tool call executed during an agent turn is persisted: tool name, call ID, arguments, and the full result content, in execution order, attached to that turn's `workspace_chats` row. |
| F2 | Every reasoning block (`reasoning_content` deltas captured by `tooledStream`, including the `<thought>`-wrapped stream) produced during a turn is persisted in order relative to the tool calls it preceded. |
| F3 | Every intermediate LLM call within a turn is identifiable in the persisted trace (call index, and the text it emitted before requesting a tool). |
| F4 | On every subsequent turn (and every LLM call within a turn), the agent's message history is reconstructed so the model sees: prior turns' user prompts, final texts, **and** their persisted tool calls + results + thoughts in chronological order. |
| F5 | Within a single multi-tool turn, the in-memory `messages` array continues to carry the live trace exactly as today (recursion appends); additionally, reasoning blocks from earlier LLM calls in the same turn are retained in context for native-tool-calling providers that accept `reasoning_content`/thinking history. |
| F6 | When a user asks about a previous turn's actions ("did you run X?"), the model can answer from the reconstructed trace without re-executing tools. |
| F7 | The persisted trace is exposed to the frontend as part of the historical message payload (response JSON) so the UI can render an inspectable tool timeline per turn. |
| F8 | UnTooled (prompt-based tool-calling) providers receive the reconstructed trace in their text-collapsed format with unambiguous per-call labels (`[tool:NAME args] → result`) instead of today's unlabeled concatenation. |
| F9 | Aborted turns (`aibitat._aborted`) persist whatever trace exists at abort time, marked as partial (`aborted: true`), instead of leaving only the `include:false` placeholder — so the user's next turn still knows what work was started/completed. `aborted: true` is a boolean convenience marker for cheap UI filtering; `response.stopReason` (F12) is the canonical end-state field — the abort save always writes both together, and `stopReason` wins on any conflict. |
| F10 | Regeneration (`@agent:` re-run) still prunes the in-memory array for re-execution (unchanged semantics) but the *superseded* attempt's trace remains persisted on its original row and is excluded from the next turn's LLM context. |
| F11 | Incremental trace flush: after each *completed* tool call (and after each reasoning/text block that immediately precedes a tool call), the trace accumulated so far is upserted into the turn's `workspace_chats` row without flipping `include`. Data loss at hard-crash time is bounded to the single tool call in flight. |
| F12 | Every saved agent turn records `response.stopReason` — one of `completed` (normal finalize), `user_abort` (Stop button / socket close), `interrupted` (promoted after a crash or lost finalize), `provider_error` (LLM/tool failure ended the turn). |
| F13 | Crash recovery: when a new agent invocation starts for a thread whose latest row is a flushed-but-unfinalized placeholder (`include:false` with a non-empty trace), that row is promoted once (`include:true`, `stopReason: "interrupted"`) so the next turn's context includes what happened before the crash. |

### Non-functional

| ID | Constraint |
|----|-----------|
| N1 | Billing accuracy is untouched: `metrics.prompt_tokens/completion_tokens` in `_store`/`_storeSpecial` must keep reporting session-cumulative usage; trace persistence must not change debit amounts. |
| N2 | The two-phase `trackedChatId` contract (pre-register with `include:false`, upsert at finalize) is preserved; the trace attaches to the same row via the existing upsert. |
| N3 | Backward compatibility: existing `workspace_chats` rows without a trace must load and render exactly as today (trace absence = legacy behavior); no DB migration may break old rows, and old rows feed history the same way they do today. |
| N4 | Provider-agnostic: the mechanism must work for native tool calling (`tooled.js` consumers) and prompt-based (`untooled.js` consumers) alike; no provider may receive message shapes it rejects (e.g. Anthropic must not receive OpenAI `tool_calls` shape). |
| N5 | Context-window safety: trace reconstruction participates in `compressMessages`-style trimming — a turn with 100 tool calls must not blow the prompt window; oversized tool results are truncated in *context reconstruction* but stored fully on disk. |
| N6 | Persistence size: trace data must be size-capped per turn (env-tunable, generous default) so a runaway tool loop cannot produce unbounded row growth; truncation is recorded explicitly in the trace. |
| N7 | Performance: trace capture must not block the streaming path — buffering is synchronous in-memory appends; DB writes are coalesced incremental flushes after each *completed* tool call (F11, fire-and-forget), plus the finalize write and the abort-save write. No per-append DB writes; no write inside the streaming path itself. |
| N8 | Standard (non-agent) chat path (`chats/stream.js`, `apiChatHandler.js`) behavior is unchanged. |
| N9 | `api_session_id`-tagged (developer API) chats get the same trace persistence but remain excluded from frontend history queries, as today. |
| N10 | Fail-open on trace write failure: if persisting the trace fails, the turn still saves text/metrics as today and an error is logged — trace loss must never lose the primary chat record. |
| N11 | Incremental flushes must never flip `include`, never run the credit debit, and never trigger thread auto-rename — those remain finalize-only (and abort-save) behaviors. |
| N12 | Flush failure is fail-open: a failed incremental upsert is logged and skipped; the next flush retries with the full buffer (last-write-wins). Flush errors must never abort the running turn or block streaming. |

---

## 4. Out of scope

- Rendering the tool timeline in the chat UI (new components) — F7 only guarantees the data reaches the frontend response payload; a follow-up UI workstream consumes it. The existing `HistoricalMessage` components must not break.
- Trace-based **editing/rewinding** of agent history (e.g. "undo tool call 3").
- Persisting intermediate LLM calls in *standard chat* mode (no tools there — nothing to record).
- Cross-workspace / global agent memory (that's the `memories` model's domain).
- Vector-search changes, `compressMessages` rewrites beyond accepting trace-augmented history as input.
- Scheduled-job execution traces (`scheduled_job_runs` already captures tool results via `onToolCallResult` — orthogonal).
- Automatic *resumption* of an interrupted turn — the saved trace makes the state visible and the model aware; actually continuing the task is a manual user re-prompt. UI rendering of `stopReason`/`aborted` state is also deferred to the frontend follow-up (F7's data-availability guarantee covers both).

---

## 5. Threat model

✅ **Prevents:**

- *Self-gaslighting / false denial:* model falsely telling the user it never performed a side-effecting action it did perform (integrity of agent self-report).
- *Redundant side effects:* model re-running state-changing tools (writes, sends, deletes) because it lost record of having done them.
- *Debugging blindness:* operators unable to audit what tools an agent actually invoked in a past turn.
- *UnTooled attribution errors:* prompt-based models attributing a result to the wrong tool call.

❌ **Does not prevent:**

- *Prompt-injection amplification:* a malicious tool result, now persisted and replayed into every future turn's context, gains longer-lived influence. Mitigation owner: tool-result sanitization workstream (none exists yet — noted as residual risk; truncation caps in N5-N6 bound the blast radius per turn).
- *Context bloat cost:* faithfully replaying traces increases input tokens and thus user cost. N5 capping bounds it, but a trace-heavy workflow will bill more input tokens — this is inherent to the requirement, surfaced to the user via existing context-usage indicator (`emitContextUsage`).
- *Memory exhaustion from in-turn buffering:* a single turn's buffer is bounded only by `AGENT_MAX_TOOL_CALLS` (default 100) — accepted; consistent with existing per-turn limits.
- *Frontend storage growth:* traces ride inside `response` JSON already loaded by history endpoints; no new tables, no new query paths.
- *Loss of the in-flight tool call at hard crash:* the flush trigger is per *completed* tool call; whatever the executing call produced at crash time is lost (bounded to one tool call). Accepted trade-off versus per-append DB write churn.
- *Prompt-injection persistence across interruption:* a flushed partial trace is promoted into future context exactly like a completed turn's trace; sanitization remains the open residual risk noted above.

**Missing-identity behavior (mandatory):** when `invocation.user_id` is null (single-user mode) or the invocation record is missing at abort time, trace persistence keys off `trackedChatId` only — the same row the placeholder created — and fails open to *text-only save* (N10) rather than blocking the chat. No trace write ever targets a shared/global context.

---

## 6. Acceptance Criteria

| AC | Given / When / Then |
|----|---------------------|
| AC1 (F1) | **Given** an agent turn that executes 3 tool calls, **when** the turn finalizes, **then** the `workspace_chats.response` JSON contains a `trace` array with 3 tool-call entries (name, callId, arguments, result) in execution order. |
| AC2 (F2) | **Given** a native-tool-calling provider emitting `reasoning_content` before requesting a tool, **when** the turn finalizes, **then** the trace contains the reasoning text positioned before the tool call it produced. |
| AC3 (F3) | **Given** a turn with 2 intermediate LLM calls + 1 final call, **when** the trace is inspected, **then** each LLM call is present with an index and its pre-tool text. |
| AC4 (F4) | **Given** a completed turn with a persisted trace, **when** the *next* turn starts, **then** the message array handed to the provider contains assistant `tool_calls` + `role:"tool"` result pairs reconstructed from that trace (native format) — verified at the provider boundary. |
| AC5 (F6) | **Given** turn N executed `write-text-file`, **when** the user in turn N+1 asks "did you write that file?", **then** the model answers from history without invoking the filesystem tool (assert: no `toolCallResult` event for that turn). |
| AC6 (F5) | **Given** a single turn where call #1 reads a file and call #3 writes it, **when** call #3's LLM request is built, **then** its message array includes call #1's reasoning block and tool result (in-turn retention). |
| AC7 (F8) | **Given** an UnTooled provider, **when** history contains a persisted trace, **then** `cleanMsgs` output contains per-call labels `[tool:<name>(<args>)]` followed by that call's result, not unlabeled concatenation. |
| AC8 (F9) | **Given** a turn aborted after 2 of 3 tool calls, **when** the socket closes, **then** the row is upserted with `include:true`, `aborted: true`, and the 2 completed trace entries. |
| AC9 (F10) | **Given** a regenerated turn, **when** the re-run executes different tools, **then** the LLM context contains only the new attempt's trace; the superseded trace remains on its row. |
| AC10 (N1) | **Given** any agent turn, **when** credits are debited, **then** debit amounts equal `ceil(prompt×0.5)+ceil(completion×1.0)` from session usage — identical to pre-change values for the same usage. |
| AC11 (N3) | **Given** a legacy row (pre-trace schema), **when** history is loaded and rendered, **then** behavior is identical to today (no trace fields required, no errors). |
| AC12 (N5) | **Given** a trace with a 500 KB tool result and a small context window, **when** history is reconstructed, **then** the in-context result is truncated with an explicit `[truncated]` marker while the stored trace retains the full result. |
| AC13 (N6) | **Given** `AGENT_TRACE_MAX_BYTES` (default 2 MB) exceeded by one turn's trace, **when** the turn finalizes, **then** the trace is truncated at the cap with a `truncated: true` marker and the row saves successfully. |
| AC14 (N10) | **Given** the trace write throws, **when** the turn finalizes, **then** the text/metrics save completes and the error is logged — the turn is never lost. |
| AC15 (N8) | **Given** a standard `chat`-mode message with no agent invocation, **when** it completes, **then** the saved row is byte-identical in shape to today (no trace key added). |
| AC16 (F11) | **Given** a turn executing 3 tool calls, **when** tool call #2 completes, **then** the turn's row already contains trace entries for calls #1–#2 (via incremental upsert) while `include` remains `false` and no debit has occurred. |
| AC17 (F12) | **Given** a user presses Stop after 2 completed tool calls, **when** the abort save runs, **then** the row has `stopReason: "user_abort"`; a normally finalized turn has `stopReason: "completed"`; a provider-failure exit records `"provider_error"`. |
| AC18 (F13) | **Given** the server process is killed after tool call #2's flush, **when** the user sends the next message in the same thread, **then** the orphaned row is promoted to `include:true` with `stopReason: "interrupted"` and its trace is reconstructed into the next turn's context. |
| AC19 (N11/N12) | **Given** an incremental flush that throws (DB busy), **when** the turn continues, **then** the error is logged, the turn proceeds unaffected, and the next successful flush overwrites `response.trace` with the full buffer; no flush ever changes `include` or debits credits. |
| AC20 (F7) | **Given** a turn with a persisted trace, **when** a client loads chat history through the workspace thread fetch path, **then** the historical message's `response` JSON includes the `trace` key (data availability for UI rendering; rendering itself is out of scope — Section 4). |
| AC21 (N4) | **Given** a persisted trace from a native-tool-calling turn, **when** history is reconstructed for a strict-shape provider (e.g. Anthropic), **then** the provider receives only message shapes it accepts (alternating tool_use/tool_result pairs); malformed pairs degrade to plain text with a logged warning. |

**Coverage notes:** N2 is asserted inside `chat-history.trace.test.js` (same-row upsert) rather than via a dedicated AC. N9's exclusion of `api_session_id` chats from frontend history is pre-existing behavior this workstream must not change; it carries no dedicated AC by design — the exclusion is re-verified by `legacy-rows.test.js` (AC11/AC15 row shapes unchanged).
