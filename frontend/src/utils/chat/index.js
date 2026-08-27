import { THREAD_RENAME_EVENT } from "@/components/Sidebar/ActiveWorkspaces/ThreadContainer";
import { emitAssistantMessageCompleteEvent } from "@/components/contexts/TTSProvider";
import { getAgentSessionActive } from "@/utils/chat/agent";
import { CONTEXT_USAGE_EVENT } from "@/utils/constants";
export const ABORT_STREAM_EVENT = "abort-chat-stream";

// Tracks whether the user has seen the "Swapping over to agent chat" banner
// at least once in this browser session. After the first time, the banner is
// suppressed so that switching threads/workspaces in automatic mode doesn't
// repeatedly show the startup message.
const AGENT_INTRO_SEEN_KEY = "totem_agent_intro_seen";
function markAgentIntroSeen() {
  try {
    sessionStorage.setItem(AGENT_INTRO_SEEN_KEY, "1");
  } catch {}
}
function hasSeenAgentIntro() {
  try {
    return sessionStorage.getItem(AGENT_INTRO_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

// For handling of chat responses in the frontend by their various types.
export default function handleChat(
  chatResult,
  setLoadingResponse,
  setChatHistory,
  remHistory,
  _chatHistory,
  setWebsocket
) {
  const {
    uuid,
    textResponse,
    type,
    sources = [],
    error,
    close,
    animate = false,
    chatId = null,
    action = null,
    metrics = {},
    routedTo = null,
  } = chatResult;

  if (type === "modelRouteNotification") {
    _chatHistory.push({
      type: "modelRouteNotification",
      uuid,
      routedTo,
      role: "assistant",
    });
    setChatHistory([..._chatHistory]);
    return;
  }

  if (type === "abort" || type === "statusResponse") {
    // Suppress the "Swapping over to agent chat" banner after the first time it
    // has been shown in this browser session. This prevents the startup message
    // from appearing on every new thread or workspace switch in automatic mode.
    if (
      type === "statusResponse" &&
      textResponse?.includes("Swapping over to agent chat")
    ) {
      if (hasSeenAgentIntro()) return;
      markAgentIntroSeen();
    }

    // Once an agent session is live, the websocket handlers in ChatContainer
    // own the loading state - the statusResponse that closes the HTTP stream
    // ("Swapping over to agent chat") must not hide the stop button.
    if (type === "abort" || !getAgentSessionActive()) setLoadingResponse(false);
    setChatHistory([
      ...remHistory,
      {
        type,
        uuid,
        content: textResponse,
        role: "assistant",
        sources,
        closed: true,
        error,
        animate,
        pending: false,
        metrics,
      },
    ]);
    _chatHistory.push({
      type,
      uuid,
      content: textResponse,
      role: "assistant",
      sources,
      closed: true,
      error,
      animate,
      pending: false,
      metrics,
    });
  } else if (type === "textResponse") {
    setLoadingResponse(false);
    setChatHistory([
      ...remHistory,
      {
        uuid,
        content: textResponse,
        role: "assistant",
        sources,
        closed: close,
        error,
        animate: !close,
        pending: false,
        chatId,
        metrics,
      },
    ]);
    _chatHistory.push({
      uuid,
      content: textResponse,
      role: "assistant",
      sources,
      closed: close,
      error,
      animate: !close,
      pending: false,
      chatId,
      metrics,
    });
    emitAssistantMessageCompleteEvent(chatId);
  } else if (
    type === "textResponseChunk" ||
    type === "finalizeResponseStream"
  ) {
    const chatIdx = _chatHistory.findIndex((chat) => chat.uuid === uuid);
    if (chatIdx !== -1) {
      const existingHistory = { ..._chatHistory[chatIdx] };
      let updatedHistory;

      // If the response is finalized, we can set the loading state to false.
      // and append the metrics to the history.
      if (type === "finalizeResponseStream") {
        updatedHistory = {
          ...existingHistory,
          closed: close,
          animate: !close,
          pending: false,
          chatId,
          metrics,
        };

        _chatHistory[chatIdx - 1] = { ..._chatHistory[chatIdx - 1], chatId }; // update prompt with chatID

        emitAssistantMessageCompleteEvent(chatId);
        setLoadingResponse(false);
      } else {
        updatedHistory = {
          ...existingHistory,
          content: existingHistory.content + textResponse,
          ...(sources && sources.length > 0 ? { sources } : {}),
          error,
          closed: close,
          animate: !close,
          pending: false,
          chatId,
          metrics,
        };
      }
      _chatHistory[chatIdx] = updatedHistory;
    } else {
      _chatHistory.push({
        uuid,
        sources,
        error,
        content: textResponse,
        role: "assistant",
        closed: close,
        animate: !close,
        pending: false,
        chatId,
        metrics,
      });
    }
    setChatHistory([..._chatHistory]);
  } else if (type === "agentInitWebsocketConnection") {
    setWebsocket(chatResult.websocketUUID);
  } else if (type === "stopGeneration") {
    const chatIdx = _chatHistory.length - 1;
    const existingHistory = { ..._chatHistory[chatIdx] };
    const updatedHistory = {
      ...existingHistory,
      sources: [],
      closed: true,
      error: null,
      animate: false,
      pending: false,
      metrics,
    };
    _chatHistory[chatIdx] = updatedHistory;

    setChatHistory([..._chatHistory]);
    setLoadingResponse(false);
  }

  // Action Handling via special 'action' attribute on response.
  if (action === "reset_chat") setChatHistory([]);

  // Notify the UI of this turn's context usage so displays like the context
  // window indicator can stay in sync without re-deriving it from history.
  emitContextUsage(metrics);

  // If thread was updated automatically based on chat prompt
  // then we can handle the updating of the thread here.
  if (action === "rename_thread") {
    if (!!chatResult?.thread?.slug && chatResult.thread.name) {
      window.dispatchEvent(
        new CustomEvent(THREAD_RENAME_EVENT, {
          detail: {
            threadSlug: chatResult.thread.slug,
            newName: chatResult.thread.name,
          },
        })
      );
    }
  }
}

/**
 * Emit the context usage of a chat turn (if any) as a DOM event so
 * components that display context window usage can update without needing
 * access to the chat history state.
 * No-op when the provider did not report usable prompt token counts.
 * @param {{prompt_tokens?: number, total_tokens?: number, model?: string}} metrics - the turn's LLM metrics
 */
export function emitContextUsage(metrics = {}) {
  if (!window) return;
  const promptTokens = Number(metrics?.prompt_tokens);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return;

  window.dispatchEvent(
    new CustomEvent(CONTEXT_USAGE_EVENT, {
      detail: {
        promptTokens,
        totalTokens:
          Number(metrics?.total_tokens) > 0 ? metrics.total_tokens : null,
        model: metrics?.model ?? null,
      },
    })
  );
}

/**
 * Walk a chat history backward to find the most recent assistant turn that
 * reported prompt token usage. Used to seed context window displays when a
 * thread or workspace is loaded so refreshing doesn't show stale zero values.
 * @param {Array<{metrics?: Object}>} history - frontend chat history entries
 * @returns {{promptTokens: number, model: string|null}|null}
 */
export function lastContextUsageFromHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    const promptTokens = Number(history?.[i]?.metrics?.prompt_tokens);
    if (Number.isFinite(promptTokens) && promptTokens > 0)
      return { promptTokens, model: history[i].metrics.model ?? null };
  }
  return null;
}

export function getWorkspaceSystemPrompt(workspace) {
  return (
    workspace?.openAiPrompt ??
    "You are Totem LLM. You are an AI that prioritizes consistent behavior with your history. The current date and time is {datetime}."
  );
}

export function chatQueryRefusalResponse(workspace) {
  return (
    workspace?.queryRefusalResponse ??
    "There is no relevant information in this workspace to answer your query."
  );
}
