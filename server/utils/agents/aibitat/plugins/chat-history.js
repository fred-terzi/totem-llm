const { WorkspaceChats } = require("../../../../models/workspaceChats");
const { WorkspaceThread } = require("../../../../models/workspaceThread");

/**
 * Plugin to save chat history to AnythingLLM DB.
 */
const chatHistory = {
  name: "chat-history",
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup: function (aibitat) {
        // Note: `aibitat._aborted` is set centrally by AIbitat.abort()
        // before the "abort" event fires, so we no longer need to set it
        // here — the onMessage check below just reads that flag.
        // pre-register a workspace chat ID to secure it in the DB
        aibitat.onMessage(async (message) => {
          if (message.from !== "USER") return;

          /**
           * If we don't have a tracked chat ID, we need to create a new one so we can upsert the response later.
           * Normally, if this was a totally fresh chat from the user, we can assume that the message from the socket is
           * the message we want to store for the prompt. However, if this is a regeneration of a previous message and that message
           * called tools the history could include intermediate messages so need to search backwards to find the most recent user message
           * as that is actually the prompt.
           */
          if (!aibitat.trackedChatId) {
            let userMessage = message.content;
            if (userMessage.startsWith("@agent:")) {
              const lastUserMsgIndex = aibitat._chats.findLastIndex(
                (c) => c.from === "USER" && !c.content.startsWith("@agent:")
              );

              // When regenerating a message, we need to use the last user message as the prompt.
              // Also prune the chats array to only include the messages before target prompt to re-run
              // or else tool call results from the previous run will be included in the history and the model will not re-call tools
              // that previously worked for the to-be-regenerated prompt.
              if (lastUserMsgIndex !== -1) {
                userMessage = aibitat._chats[lastUserMsgIndex].content;
                aibitat._chats = aibitat._chats.slice(0, lastUserMsgIndex + 1);
              }
            }

            const { chat } = await WorkspaceChats.new({
              workspaceId: Number(aibitat.handlerProps.invocation.workspace_id),
              user: { id: aibitat.handlerProps.invocation.user_id || null },
              threadId: aibitat.handlerProps.invocation.thread_id || null,
              include: false,
              prompt: userMessage,
              response: {},
            });
            if (chat) aibitat.registerChatId(chat.id);
          }
        });

        aibitat.onMessage(async () => {
          try {
            if (aibitat._aborted) return;
            const lastResponses = aibitat.chats.slice(-2);
            if (lastResponses.length !== 2) return;
            const [prev, last] = lastResponses;

            // We need a full conversation reply with prev being from
            // the USER and the last being from anyone other than the user.
            if (prev.from !== "USER" || last.from === "USER") return;

            // Extract attachments from user message if present
            const attachments = prev.attachments || [];

            // If we have a post-reply flow we should save the chat using this special flow
            // so that post save cleanup and other unique properties can be run as opposed to regular chat.
            if (aibitat.hasOwnProperty("_replySpecialAttributes")) {
              await this._storeSpecial(aibitat, {
                prompt: prev.content,
                response: last.content,
                attachments,
                options: aibitat._replySpecialAttributes,
              });
              delete aibitat._replySpecialAttributes;
              return;
            }

            await this._store(aibitat, {
              prompt: prev.content,
              response: last.content,
              attachments,
            });
          } catch {}
        });

        // Step 2b (agent-full-context-trace): expose the incremental flush
        // helper to aibitat so `scheduleTraceFlush()` (fired after each
        // completed tool call) has a persistence target. The plugin instance
        // (`this`) owns `_flushTrace`; aibitat only ever calls it blind via
        // the optional `flushTrace?.()` hook.
        aibitat.flushTrace = () => this._flushTrace(aibitat);
      },
      _store: async function (
        aibitat,
        { prompt, response, attachments = [] } = {}
      ) {
        const invocation = aibitat.handlerProps.invocation;

        // Use session-level usage (cumulative across all LLM calls in this turn)
        // instead of lastUsage (last call only) so the stored metrics reflect
        // the total tokens Venice actually billed for this turn.
        const lastCall = aibitat.providerInstance?.getUsage?.() ?? {};
        const session = aibitat.providerInstance?.getSessionUsage?.() ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        };
        const metrics = {
          // Primary numbers = session totals (accurate for billing)
          prompt_tokens: session.prompt_tokens || 0,
          completion_tokens: session.completion_tokens || 0,
          total_tokens: session.total_tokens || 0,
          // Per-last-call info for debugging / context window display
          lastCall: {
            prompt_tokens: lastCall.prompt_tokens || 0,
            completion_tokens: lastCall.completion_tokens || 0,
            total_tokens: lastCall.total_tokens || 0,
            duration: lastCall.duration || 0,
          },
          model: lastCall.model,
          provider: lastCall.provider,
          timestamp: lastCall.timestamp,
        };

        const citations = aibitat._pendingCitations ?? [];
        const outputs = aibitat._pendingOutputs ?? [];
        const clarifyingQuestions =
          aibitat._pendingClarifyingQuestionSurveys ?? [];

        // Finalize is the authoritative write: it OVERWRITES whatever partial
        // `response.trace` incremental flushes (Step 2b) may have written with
        // the full buffer (plan Step 5.6). Trace serialization is fail-open
        // (N10): a failure saves the row with `trace: null` and logs — the
        // primary chat record is never lost to a trace failure.
        const trace = this._serializeTrace(aibitat);

        await WorkspaceChats.upsert(aibitat.trackedChatId, {
          workspaceId: Number(invocation.workspace_id),
          prompt,
          response: {
            text: response,
            sources: citations,
            type: "chat",
            attachments,
            metrics,
            trace,
            ...(outputs.length > 0 ? { outputs } : {}),
            ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
          },
          user: { id: invocation?.user_id || null },
          threadId: invocation?.thread_id || null,
          include: true,
        });

        // Debit credits based on input/output token usage. Admins are exempt.
        await this._debitCredits(
          invocation,
          metrics.prompt_tokens,
          metrics.completion_tokens,
          metrics.model,
          aibitat.trackedChatId
        );

        if (!aibitat._threadRenamed) {
          aibitat._threadRenamed = await this._autoRenameThread(
            aibitat,
            prompt
          );
        }
        this._cleanup(aibitat);
      },
      _storeSpecial: async function (
        aibitat,
        { prompt, response, attachments = [], options = {} } = {}
      ) {
        const invocation = aibitat.handlerProps.invocation;

        // Use session-level usage (cumulative across all LLM calls in this turn)
        const lastCall = aibitat.providerInstance?.getUsage?.() ?? {};
        const session = aibitat.providerInstance?.getSessionUsage?.() ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        };
        const metrics = {
          prompt_tokens: session.prompt_tokens || 0,
          completion_tokens: session.completion_tokens || 0,
          total_tokens: session.total_tokens || 0,
          lastCall: {
            prompt_tokens: lastCall.prompt_tokens || 0,
            completion_tokens: lastCall.completion_tokens || 0,
            total_tokens: lastCall.total_tokens || 0,
            duration: lastCall.duration || 0,
          },
          model: lastCall.model,
          provider: lastCall.provider,
          timestamp: lastCall.timestamp,
        };

        const citations = aibitat._pendingCitations ?? [];
        const outputs = aibitat._pendingOutputs ?? [];
        const clarifyingQuestions =
          aibitat._pendingClarifyingQuestionSurveys ?? [];
        const existingSources = options?.sources ?? [];

        // Finalize is the authoritative write: it OVERWRITES whatever partial
        // `response.trace` incremental flushes (Step 2b) may have written with
        // the full buffer (plan Step 5.6). Trace serialization is fail-open
        // (N10): a failure saves the row with `trace: null` and logs — the
        // primary chat record is never lost to a trace failure.
        const trace = this._serializeTrace(aibitat);

        await WorkspaceChats.upsert(aibitat.trackedChatId, {
          workspaceId: Number(invocation.workspace_id),
          prompt,
          response: {
            sources: [...existingSources, ...citations],
            // when we have a _storeSpecial called the options param can include a storedResponse() function
            // that will override the text property to store extra information in, depending on the special type of chat.
            text: options.hasOwnProperty("storedResponse")
              ? options.storedResponse(response)
              : response,
            type: options?.saveAsType ?? "chat",
            attachments,
            metrics,
            trace,
            ...(outputs.length > 0 ? { outputs } : {}),
            ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
          },
          user: { id: invocation?.user_id || null },
          threadId: invocation?.thread_id || null,
          include: true,
        });

        // Debit credits based on input/output token usage. Admins are exempt.
        await this._debitCredits(
          invocation,
          metrics.prompt_tokens,
          metrics.completion_tokens,
          metrics.model,
          aibitat.trackedChatId
        );

        if (!aibitat._threadRenamed) {
          aibitat._threadRenamed = await this._autoRenameThread(
            aibitat,
            prompt
          );
        }
        options?.postSave();
        this._cleanup(aibitat);
      },

      /**
       * Debit credits from the user's balance based on actual token usage.
       * Cost = ceil(input_tokens × 0.5) + ceil(output_tokens × 1.0)  [microdollars]
       * Admins are exempt. Failures are logged and do not block the chat save.
       * @param {object}   invocation
       * @param {number}   inputTokens   — prompt tokens
       * @param {number}   outputTokens  — completion tokens
       * @param {string}   [model]
       * @param {number|null} chatId
       */
      _debitCredits: async function (
        invocation,
        inputTokens,
        outputTokens,
        model,
        chatId = null
      ) {
        const userId = invocation?.user_id;
        if (!userId || (!inputTokens && !outputTokens)) return;

        try {
          const { Credits } = require("../../../../models/credits");
          const { User } = require("../../../../models/user");
          const user = await User.get({ id: Number(userId) });
          if (!user || user.role === "admin") return;

          const reference = chatId ? `chat_${chatId}` : null;
          const result = await Credits.debitUsage(userId, {
            inputTokens: inputTokens || 0,
            outputTokens: outputTokens || 0,
            model: model || undefined,
            reference,
          });
          console.log(
            `\x1b[33m[Credits]\x1b[0m user_${userId} debited ${result.debited} microdollars ` +
              `(${inputTokens} in / ${outputTokens} out, cost=${result.cost}) balance: ${result.newBalance}`
          );
        } catch (e) {
          // Credit debit failure should never block the chat save.
          console.error(
            `\x1b[31m[Credits] Error debiting user ${userId}: ${e.message}\x1b[0m`
          );
        }
      },

      _autoRenameThread: async function (aibitat, prompt) {
        const invocation = aibitat.handlerProps.invocation;
        if (!invocation?.thread_id) return true;

        const thread = await WorkspaceThread.get({ id: invocation.thread_id });
        if (!thread) return true;

        const { Workspace } = require("../../../../models/workspace");
        const workspace = await Workspace.get({ id: invocation.workspace_id });
        if (!workspace) return true;

        await WorkspaceThread.autoRenameThread({
          thread,
          workspace,
          user: invocation.user_id ? { id: invocation.user_id } : null,
          prompt,
          onRename: (updatedThread) => {
            aibitat.socket?.send("rename_thread", {
              slug: updatedThread.slug,
              name: updatedThread.name,
            });
          },
        });
        return true;
      },

      _cleanup: function (aibitat) {
        aibitat.clearCitations?.();
        aibitat._pendingOutputs = [];
        aibitat.clearClarifyingQuestionSurveys?.();
        aibitat.clearTrace?.();
        aibitat.clearTrackedChatId();
      },

      /**
       * Serialize the aibitat trace buffer into the persistable
       * `response.trace` shape. Fail-open (N10): any error serializing
       * returns `null` so the primary chat save is never blocked. The N6
       * size cap is enforced at append time by aibitat (`_appendTraceEntry`)
       * and re-checked here at write time.
       * @param {object} aibitat
       * @returns {{entries: Array<object>, llmCalls: number, truncated: boolean}|null}
       */
      _serializeTrace: function (aibitat) {
        try {
          if (!aibitat || typeof aibitat.getTrace !== "function") return null;
          const trace = aibitat.getTrace();
          if (!trace?.entries?.length) return null;

          // Write-time size-cap re-check (N6). The buffer is already capped
          // at append time; this guards against env changes mid-run or
          // oversized entries that slipped through unserializable sizing.
          // (Cap default mirrored from AIbitat.traceMaxBytes — deliberately
          // not require()d to avoid a circular import.)
          const envMax = parseInt(process.env.AGENT_TRACE_MAX_BYTES, 10);
          const maxBytes =
            !isNaN(envMax) && envMax > 0 ? envMax : 2 * 1024 * 1024;
          let serialized = JSON.stringify(trace);
          if (Buffer.byteLength(serialized) > maxBytes) {
            // Drop the largest tool_result contents until under the cap,
            // marking the trace truncated so readers know data was cut.
            const trimmedEntries = trace.entries.map((entry) =>
              entry?.type === "tool_result" && typeof entry.content === "string"
                ? { ...entry, content: entry.content.slice(0, 1024) }
                : entry
            );
            const trimmed = {
              entries: trimmedEntries,
              llmCalls: trace.llmCalls,
              truncated: true,
            };
            serialized = JSON.stringify(trimmed);
            if (Buffer.byteLength(serialized) > maxBytes) {
              // Still over — give up on contents entirely, keep the skeleton.
              return {
                entries: trimmedEntries.map((e) =>
                  e?.type === "tool_result" ? { ...e, content: "[truncated]" } : e
                ),
                llmCalls: trace.llmCalls,
                truncated: true,
              };
            }
            return JSON.parse(serialized);
          }

          return trace;
        } catch (e) {
          console.error(
            `\x1b[31m[AgentTrace] Failed to serialize trace: ${e.message}\x1b[0m`
          );
          return null;
        }
      },

      /**
       * Step 2b — incremental trace flush (F11/F12-partial, N11, N12).
       *
       * Fire-and-forget persistence of the trace-so-far onto the turn's
       * placeholder row, scheduled by aibitat after each completed tool call.
       *
       * Contract:
       * - NEVER flips `include`, never debits credits, never renames threads (N11).
       * - Read-modify-write: `WorkspaceChats.upsert` overwrites `response`
       *   wholesale (plan 0.4/0.15), so the row's current response JSON is
       *   read first and the merged object re-serialized — a bare `{ trace }`
       *   upsert would clobber placeholder keys.
       * - Guards before the upsert: `trackedChatId` must exist (a coalesced
       *   flush scheduled just before finalize can fire after `_cleanup()`
       *   cleared it) and the row must not be claimed by the abort save or
       *   finalize (`_aborted`/`_finalized`) — a flush racing those writers
       *   must not clobber `stopReason`/`include` (plan Step 6.3).
       * - Last-write-wins: the FULL buffer is serialized every flush.
       * - Fail-open (N12): errors are logged and dropped; the next flush
       *   (or finalize) rewrites with the full buffer. Never throws.
       */
      _flushTrace: async function (aibitat) {
        try {
          // Ownership guards: finalize/abort own the row once claimed.
          // (Order matters: check before doing any DB work.)
          if (aibitat._aborted || aibitat._finalized) return;
          if (!aibitat.trackedChatId) return;
          const trace = aibitat.getTrace?.();
          if (!trace?.entries?.length) return;

          const invocation = aibitat.handlerProps?.invocation;
          if (!invocation?.workspace_id) return;

          const chatId = aibitat.trackedChatId;
          const serialized = this._serializeTrace(aibitat);
          if (!serialized) return;

          // Read current response so the upsert does not clobber keys
          // written by placeholder creation (prompt-side metadata, etc.).
          const { WorkspaceChats } = require("../../../../models/workspaceChats");
          const existing = await WorkspaceChats.get({
            id: Number(chatId),
            user_id: invocation.user_id || null,
          });
          let currentResponse = {};
          try {
            currentResponse = existing?.response
              ? JSON.parse(existing.response)
              : {};
          } catch {
            currentResponse = {};
          }

          // Re-check ownership after the await — the abort save or finalize
          // may have claimed the row while we were reading.
          if (aibitat._aborted || aibitat._finalized) return;
          if (aibitat.trackedChatId !== chatId) return;

          await WorkspaceChats.upsert(chatId, {
            workspaceId: Number(invocation.workspace_id),
            response: {
              ...currentResponse,
              trace: serialized,
            },
            user: { id: invocation.user_id || null },
            threadId: invocation.thread_id || null,
            // Deliberately omitted: `include` stays untouched on update; the
            // create-branch default (true) never applies because the
            // placeholder row is guaranteed to exist (created in the first
            // onMessage listener before any tool can run — plan 0.11).
          });
        } catch (e) {
          // Fail-open (N12): a failed flush is logged and skipped.
          console.error(
            `\x1b[31m[AgentTrace] Incremental flush failed (dropped): ${e.message}\x1b[0m`
          );
        }
      },
    };
  },
};

module.exports = { chatHistory };
