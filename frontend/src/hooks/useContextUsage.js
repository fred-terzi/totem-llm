import { useEffect, useState } from "react";
import {
  CONTEXT_USAGE_EVENT,
  AGENT_TOKEN_USAGE_EVENT,
  CONTEXT_USAGE_CLEAR_EVENT,
} from "@/utils/constants";
import { AGENT_SESSION_START } from "@/utils/chat/agent";

/**
 * Tracks the most recent context (prompt) token usage reported by an LLM turn.
 *
 * Usage is broadcast via a DOM event (`CONTEXT_USAGE_EVENT`) whenever
 * `handleChat` processes a response that carries metrics, so this hook can be
 * used anywhere in the UI without threading state through the chat history.
 *
 * @param {number} [initialUsage] - value to start with (e.g. derived from loaded
 *   thread history) so the display is seeded before any new turn completes.
 * @returns {{promptTokens: number|null, model: string|null}} - `null` until a
 *   usage report has been received or provided.
 */
export default function useContextUsage(initialUsage = null) {
  const [usage, setUsage] = useState(initialUsage);

  useEffect(() => {
    if (!window) return;
    const handler = (e) => {
      const { promptTokens, model } = e?.detail ?? {};
      if (!Number.isFinite(promptTokens) || promptTokens <= 0) return;
      setUsage((prev) => {
        // Only update if the new value is >= current — prevents out-of-order
        // or stale agent-step messages from making the bar shrink mid-run.
        const newVal = Number(promptTokens);
        if (prev && prev.promptTokens != null && newVal < prev.promptTokens)
          return prev;
        return { promptTokens: newVal, model: model ?? null };
      });
    };

    window.addEventListener(CONTEXT_USAGE_EVENT, handler);
    window.addEventListener(AGENT_TOKEN_USAGE_EVENT, handler);

    // A new turn (chat submit or agent session start) means a fresh context
    // package is being built. The model's context usage can legitimately be
    // SMALLER than the previous turn's (shorter prompt, prior turn's
    // session-cumulative seed, /reset, provider switch). Seed from history
    // is replaced by the first real usage report of the turn, so the
    // monotonic guard above must not lock in stale inflated values.
    const newTurnHandler = () => setUsage(initialUsage);
    window.addEventListener(AGENT_SESSION_START, newTurnHandler);

    // When the chat is reset (e.g. /reset command) drop the tracked usage so
    // the context usage indicator hides instead of showing the previous bar.
    const clearHandler = () => setUsage(null);
    window.addEventListener(CONTEXT_USAGE_CLEAR_EVENT, clearHandler);

    return () => {
      window.removeEventListener(CONTEXT_USAGE_EVENT, handler);
      window.removeEventListener(AGENT_TOKEN_USAGE_EVENT, handler);
      window.removeEventListener(AGENT_SESSION_START, newTurnHandler);
      window.removeEventListener(CONTEXT_USAGE_CLEAR_EVENT, clearHandler);
    };
  }, [initialUsage]);

  return usage;
}
