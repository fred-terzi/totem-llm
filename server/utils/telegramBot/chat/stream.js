const { WorkspaceChats } = require("../../../models/workspaceChats");
const { getVectorDbClass, resolveProviderConnector } = require("../../helpers");
const { DocumentManager } = require("../../DocumentManager");
const {
  sourceIdentifier,
  recentChatHistory,
  chatPrompt,
} = require("../../chats");
const { fillSourceWindow } = require("../../helpers/chat");
const { AgentHandler } = require("../../agents");
const {
  DRAFT_REFRESH_INTERVAL,
  MAX_MSG_LEN,
  CURSOR_CHAR,
  nextDraftId,
} = require("../constants");
const { sendFormattedMessage, sendDraft, finalizeDraft } = require("../utils");
const { sendVoiceResponse } = require("../utils/media");
const { safeJsonParse } = require("../../http");
const { handleAgentResponse } = require("./agent");

/**
 * Check if the history is agentic by checking if any user messages start with "@agent"
 * so that "chat" mode workspaces can still carry on with agentic conversations
 * otherwise this is handled with "automatic" mode.
 * @param {'chat' | 'automatic' | 'query'} chatMode - The chat mode.
 * @param {{role: 'user' | 'assistant', content: string}[]} chatHistory - The chat history.
 * @returns {boolean} - True if the history is agentic, false otherwise.
 */
function historyIsAgentic(chatMode, chatHistory) {
  if (chatMode !== "chat") return false;
  return chatHistory.some(
    (message) => message.role === "user" && message.content.startsWith("@agent")
  );
}

/**
 * Stream a response to Telegram by running the full RAG pipeline.
 * Uses the same pipeline as the web UI (RAG, parsed docs, pinned docs, etc.)
 * and stores chats with thread_id so they appear in the AnythingLLM UI.
 *
 * However, we are able to consistently handle agentic conversations in "chat" mode by checking the chat history
 * without needing to open/close an agent invocation every chat which is wasteful on the DB.
 *
 * Query mode is also not supported in this flow - as it would be pretty useless.
 *
 * @param {object} context - The context object.
 * @param {import("../commands").BotContext} context.ctx - The bot object.
 * @param {number} context.chatId - The chat ID.
 * @param {import('@prisma/client').workspaces} context.workspace - The workspace object.
 * @param {object|null} context.thread - The thread object.
 * @param {string} context.message - The message to send.
 * @param {array} context.attachments - The attachments to send.
 * @param {boolean} context.voiceResponse - Whether to send the response as voice.
 */
async function streamResponse({
  ctx = null,
  chatId = null,
  messageThreadId = null,
  workspace = null,
  thread = null,
  message = "",
  attachments = [],
  voiceResponse = false,
}) {
  if (!ctx?.bot || !chatId || !workspace || !message)
    throw new Error("Invalid context or missing required parameters!");

  await ctx.bot.sendChatAction(chatId, "typing");

  const chatMode = workspace.chatMode || "chat";
  const messageLimit = workspace?.openAiHistory || 20;
  const { rawHistory, chatHistory } = await recentChatHistory({
    workspace,
    thread,
    messageLimit,
  });

  if (
    historyIsAgentic(chatMode, chatHistory) ||
    (await AgentHandler.isAgentInvocation({
      message,
      workspace,
      chatMode: workspace.chatMode ?? "automatic",
    }))
  ) {
    return await handleAgentResponse(
      ctx,
      chatId,
      workspace,
      thread,
      message,
      voiceResponse,
      attachments
    );
  }

  const typingInterval = setInterval(() => {
    ctx.bot.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  const { connector: LLMConnector } = await resolveProviderConnector({
    workspace,
    prompt: message,
    thread,
    attachments,
  });
  const VectorDb = getVectorDbClass();
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

  const {
    contextTexts: pinnedContextTexts,
    sources: pinnedSources,
    pinnedDocIdentifiers,
  } = await collectPinnedDocs(workspace, LLMConnector);

  const {
    contextTexts: searchContextTexts,
    sources: searchSources,
    error: searchError,
  } = await buildSearchContext({
    workspace,
    message,
    VectorDb,
    LLMConnector,
    embeddingsCount,
    rawHistory,
    pinnedDocIdentifiers,
  });

  if (searchError) {
    clearInterval(typingInterval);
    return await ctx.bot.sendMessage(chatId, searchError);
  }

  const contextTexts = [...pinnedContextTexts, ...searchContextTexts];
  const sources = [...pinnedSources, ...searchSources];
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt: await chatPrompt(workspace),
      userPrompt: message,
      contextTexts,
      chatHistory,
      attachments,
    },
    rawHistory
  );

  try {
    const { completeText, metrics } = await generateResponse({
      LLMConnector,
      messages,
      workspace,
      ctx,
      chatId,
      messageThreadId,
    });

    await persistAndDeliver({
      workspace,
      thread,
      message,
      completeText,
      sources,
      chatMode,
      metrics,
      attachments,
      voiceResponse,
      ctx,
      chatId,
    });
  } catch (error) {
    console.error("Error streaming response:", error);
    await ctx.bot.sendMessage(
      chatId,
      "An error occurred while streaming the response."
    );
  } finally {
    clearInterval(typingInterval);
  }
}

/**
 * Gather context texts, sources, and identifiers from pinned documents.
 * @returns {Promise<{ contextTexts: string[], sources: object[], pinnedDocIdentifiers: string[] }>}
 */
async function collectPinnedDocs(workspace, LLMConnector) {
  const contextTexts = [];
  const sources = [];
  const pinnedDocIdentifiers = [];

  const pinnedDocs = await new DocumentManager({
    workspace,
    maxTokens: LLMConnector.promptWindowLimit(),
  }).pinnedDocs();

  for (const doc of pinnedDocs) {
    const { pageContent, ...metadata } = doc;
    pinnedDocIdentifiers.push(sourceIdentifier(doc));
    contextTexts.push(pageContent);
    sources.push({
      text:
        pageContent.slice(0, 1_000) + "...continued on in source document...",
      ...metadata,
    });
  }

  return { contextTexts, sources, pinnedDocIdentifiers };
}

/**
 * Run vector similarity search and fill the source window.
 * @returns {Promise<{ contextTexts: string[], sources: object[], error: string|null }>}
 */
async function buildSearchContext({
  workspace,
  message,
  VectorDb,
  LLMConnector,
  embeddingsCount,
  rawHistory,
  pinnedDocIdentifiers,
}) {
  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: message,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          rerank: workspace?.vectorSearchMode === "rerank",
        })
      : { contextTexts: [], sources: [], message: null };

  if (vectorSearchResults.message) {
    return {
      contextTexts: [],
      sources: [],
      error: "Vector search failed. Please try again.",
    };
  }

  const filledSources = fillSourceWindow({
    nDocs: workspace?.topN || 4,
    searchResults: vectorSearchResults.sources,
    history: rawHistory,
    filterIdentifiers: pinnedDocIdentifiers,
  });

  return {
    contextTexts: filledSources.contextTexts,
    sources: vectorSearchResults.sources,
    error: null,
  };
}

/**
 * Run the LLM completion (streaming or non-streaming) and deliver the in-progress response.
 * Clears the typing indicator when done.
 * @returns {Promise<{ completeText: string, metrics: object }>}
 */
async function generateResponse({
  LLMConnector,
  messages,
  workspace,
  ctx,
  chatId,
  messageThreadId = null,
}) {
  let completeText = "";
  let metrics = {};

  if (LLMConnector.streamingEnabled() === true) {
    const stream = await LLMConnector.streamGetChatCompletion(messages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
    });

    const { responseHandler, flushEdit } = createStreamHandler({
      ctx,
      chatId,
      messageThreadId,
    });

    completeText = await LLMConnector.handleStream(responseHandler, stream, {
      uuid: chatId.toString(),
    });

    await flushEdit(true);
    metrics = stream.metrics || {};
  } else {
    const { textResponse, metrics: performanceMetrics } =
      await LLMConnector.getChatCompletion(messages, {
        temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
        user: null,
      });
    completeText = textResponse;
    metrics = performanceMetrics || {};
    if (completeText?.length > 0)
      await sendFormattedMessage(ctx.bot, chatId, completeText);
  }

  return { completeText, metrics };
}

/**
 * Save the completed chat to the database and optionally deliver a voice response.
 */
async function persistAndDeliver({
  workspace,
  thread,
  message,
  completeText,
  sources,
  chatMode,
  metrics,
  attachments,
  voiceResponse,
  ctx,
  chatId,
}) {
  if (!completeText?.length) {
    await ctx.bot.sendMessage(chatId, "No response generated.");
    return;
  }

  await WorkspaceChats.new({
    workspaceId: workspace.id,
    prompt: message,
    response: {
      text: completeText,
      sources,
      type: chatMode,
      metrics,
      attachments,
    },
    threadId: thread?.id || null,
  });

  // Send voice as an additional attachment if requested
  if (voiceResponse) {
    ctx.log?.info?.(`Generating voice response for ${chatId}`);
    await sendVoiceResponse(ctx.bot, chatId, completeText);
  }
}

/**
 * Parse an SSE data chunk and return the text token, or null if not a text token.
 */
function parseSSEChunk(data) {
  const match = data.match(/^data: (.+)\n\n$/s);
  if (!match) return null;
  const parsed = safeJsonParse(match[1], null);
  if (!parsed || !parsed.textResponse || parsed.close) return null;
  return parsed.textResponse;
}

/**
 * Create a stream response handler that uses Telegram's ephemeral draft API
 * (sendMessageDraft / sendRichMessageDraft) for real-time streaming.
 * Drafts are ~30s preview windows, so we refresh periodically and handle expiry.
 * When content exceeds MAX_MSG_LEN the draft is finalized as a persistent message
 * and a new draft starts for the next segment.
 * @param {object} options
 * @param {import("./commands").BotContext} options.ctx - Bot context
 * @param {number} options.chatId - Telegram chat ID
 * @param {number|null} [options.messageThreadId=null] - Forum topic thread ID (optional)
 * @returns {{ responseHandler: object, flushEdit: function }}
 */
function createStreamHandler({ ctx, chatId, messageThreadId = null }) {
  let completeText = "";
  // Phase tracking: "idle" → "drafting" → "finalized" (after overflow split)
  let draftId = nextDraftId();
  let streamingPhase = "idle";
  let lastDraftTime = 0;
  let draftTimer = null;
  let msgOffset = 0;

  const currentText = () => completeText.slice(msgOffset);

  /**
   * Send or update the ephemeral draft message.
   * Uses sendRichMessageDraft for formatted HTML, falls back to plain text.
   */
  async function sendDraftUpdate(text) {
    if (!text?.length && streamingPhase === "idle") {
      // Empty text = "Thinking..." placeholder (valid per API spec)
      await sendDraft(ctx.bot, chatId, draftId, "", { messageThreadId });
      streamingPhase = "drafting";
      lastDraftTime = Date.now();
      return;
    }

    if (!text?.length) return;

    // Try rich-mode when we have enough text for stable HTML parsing
    const useRich = text.length > 10;
    await sendDraft(ctx.bot, chatId, draftId, text, {
      rich: useRich,
      messageThreadId,
    });
    streamingPhase = "drafting";
    lastDraftTime = Date.now();
  }

  /**
   * Handle accumulated text overflowing Telegram's max length.
   * Finalizes the current segment as a persistent message and begins
   * a fresh draft for the remainder.
   */
  async function splitOnOverflow() {
    const segmentText = completeText.slice(msgOffset, msgOffset + MAX_MSG_LEN);
    if (!segmentText?.length) return;

    // Clear any pending draft timer
    clearTimeout(draftTimer);
    draftTimer = null;

    // Finalize the completed segment as a real persistent message
    await finalizeDraft(ctx.bot, chatId, segmentText, {
      html: true,
      messageThreadId,
    }).catch(() => {
      // Fallback: just send plain if formatting fails
      ctx.bot
        .sendMessage(chatId, segmentText, {
          message_thread_id: messageThreadId || undefined,
        })
        .catch(() => {});
    });

    msgOffset += MAX_MSG_LEN;
    // New draft ID for the next segment (Telegram animates same-ID changes)
    draftId = nextDraftId();
    streamingPhase = "idle";

    // Handle remaining segments recursively if still overflowing
    const remainderLength = currentText().length;
    if (remainderLength > MAX_MSG_LEN) {
      // Schedule after microtask to avoid Telegram rate limits
      setImmediate(() => splitOnOverflow());
    } else if (remainderLength > 0) {
      sendDraftUpdate(currentText());
    }
  }

  /** Throttle draft updates to beat ~30s expiry without spamming the API. */
  function scheduleDraftRefresh() {
    if (streamingPhase !== "drafting") return;

    const now = Date.now();
    clearTimeout(draftTimer);
    if (now - lastDraftTime >= DRAFT_REFRESH_INTERVAL) {
      // Enough time passed — fire immediately, then schedule next refresh
      void sendDraftUpdate(currentText());
    } else {
      // Not enough time — schedule for the right moment
    }
    draftTimer = setTimeout(() => {
      void sendDraftUpdate(currentText());
      draftTimer = null;
    }, DRAFT_REFRESH_INTERVAL);
  }

  /**
   * Flush the current draft and optionally finalize as a persistent message.
   * @param {boolean} final - If true, persist the remaining text instead of leaving as draft.
   */
  const flushEdit = async (final = false) => {
    clearTimeout(draftTimer);
    draftTimer = null;

    const text = currentText();
    if (!text?.length) {
      streamingPhase = "idle";
      return;
    }

    if (final) {
      // Persist as a real message instead of an ephemeral draft
      await finalizeDraft(ctx.bot, chatId, text, {
        html: true,
        messageThreadId,
      }).catch(() => {
        ctx.bot
          .sendMessage(chatId, text, {
            message_thread_id: messageThreadId || undefined,
          })
          .catch(() => {});
      });
    } else {
      // One last draft push (e.g. cursor animation)
      await sendDraftUpdate(text + CURSOR_CHAR);
    }
    streamingPhase = "idle";
  };

  const responseHandler = {
    on: () => {},
    removeListener: () => {},
    write: (data) => {
      const token = parseSSEChunk(data);
      if (!token) return;

      completeText += token;

      // Check for overflow — finalize current segment, start new draft
      if (currentText().length > MAX_MSG_LEN) {
        void splitOnOverflow();
        return;
      }

      // First token: kick off "Thinking..." then immediately update with text
      if (streamingPhase === "idle") {
        void sendDraftUpdate("");
        streamingPhase = "drafting";
        lastDraftTime = Date.now(); // Beat the race: scheduleDraftRefresh won't fire immediately
        void sendDraftUpdate(currentText());
        return;
      }

      // Subsequent tokens: throttle to beat expiry + avoid spamming the API
      scheduleDraftRefresh();
    },
  };

  return { responseHandler, flushEdit };
}

module.exports = { streamResponse };
