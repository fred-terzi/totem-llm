import { useEffect, useState } from "react";
import { CONTEXT_USAGE_EVENT, AGENT_TOKEN_USAGE_EVENT } from "@/utils/constants";

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
        if (prev && prev.promptTokens != null && newVal < prev.promptTokens) return prev;
        return { promptTokens: newVal, model: model ?? null };
      });
    };

    window.addEventListener(CONTEXT_USAGE_EVENT, handler);
    window.addEventListener(AGENT_TOKEN_USAGE_EVENT, handler);
    return () => {
      window.removeEventListener(CONTEXT_USAGE_EVENT, handler);
      window.removeEventListener(AGENT_TOKEN_USAGE_EVENT, handler);
    };
  }, []);

  return usage;
}
