/**
 * Tests for the context usage event plumbing:
 *  - `emitContextUsage` (DOM event emission from handleChat)
 *  - `lastContextUsageFromHistory` (history scan helper)
 */

// Minimal DOM shim so we can test window-based event dispatch in Node.
const target = new EventTarget();
globalThis.window = Object.assign(target, { CustomEvent });

jest.mock("@/components/Sidebar/ActiveWorkspaces/ThreadContainer", () => ({
  THREAD_RENAME_EVENT: "thread-rename",
}));
jest.mock("@/components/contexts/TTSProvider", () => ({
  emitAssistantMessageCompleteEvent: jest.fn(),
}));
jest.mock("@/utils/chat/agent", () => ({
  getAgentSessionActive: () => false,
}));
// constants.js uses `import.meta.env` which is Vite-only and not supported by
// the CJS babel transform - mock it here. The event name just needs to match
// whatever emitContextUsage dispatches with.
jest.mock("@/utils/constants", () => ({
  CONTEXT_USAGE_EVENT: "context-usage-update",
}));

const { CONTEXT_USAGE_EVENT } = require("@/utils/constants");
const {
  emitContextUsage,
  lastContextUsageFromHistory,
} = require("@/utils/chat");

describe("emitContextUsage", () => {
  function dispatch(metrics) {
    const received = [];
    // `once` so each test's listener only captures its own emission.
    window.addEventListener(
      CONTEXT_USAGE_EVENT,
      (e) => received.push(e.detail),
      { once: true }
    );
    emitContextUsage(metrics);
    return received;
  }

  it("emits an event with promptTokens when metrics have a positive prompt_tokens", () => {
    const events = dispatch({ prompt_tokens: 42, model: "gpt-4o" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      promptTokens: 42,
      totalTokens: null,
      model: "gpt-4o",
    });
  });

  it("includes totalTokens when present and > 0", () => {
    const events = dispatch({
      prompt_tokens: 10,
      total_tokens: 55,
      model: "llama3",
    });
    expect(events[0].totalTokens).toBe(55);
    expect(events[0].model).toBe("llama3");
  });

  it("is a no-op when prompt_tokens is missing or zero", () => {
    expect(dispatch({})).toHaveLength(0);
    expect(dispatch({ prompt_tokens: 0 })).toHaveLength(0);
    expect(dispatch(null)).toHaveLength(0);
  });

  it("is a no-op when prompt_tokens is not a finite number", () => {
    expect(dispatch({ prompt_tokens: "abc" })).toHaveLength(0);
    expect(dispatch({ prompt_tokens: NaN })).toHaveLength(0);
  });
});

describe("lastContextUsageFromHistory", () => {
  it("returns null for an empty history", () => {
    expect(lastContextUsageFromHistory([])).toBeNull();
    expect(lastContextUsageFromHistory()).toBeNull();
  });

  it("walks backward to find the most recent entry with positive prompt_tokens", () => {
    const history = [
      { role: "user", content: "hi" },
      { role: "assistant", metrics: { prompt_tokens: 100, model: "a" } },
      { role: "user", content: "howdy" },
      { role: "assistant", metrics: {} }, // no usable data here
      { role: "assistant", metrics: { prompt_tokens: 250, model: "b" } },
    ];
    expect(lastContextUsageFromHistory(history)).toEqual({
      promptTokens: 250,
      model: "b",
    });

    // After removing the last entry it falls back to the earlier one
    history.pop();
    expect(lastContextUsageFromHistory(history)).toEqual({
      promptTokens: 100,
      model: "a",
    });
  });

  it("returns null when no entry has usable metrics", () => {
    expect(
      lastContextUsageFromHistory([
        { role: "assistant", metrics: {} },
        { role: "user" },
        { role: "assistant" },
      ])
    ).toBeNull();
  });

  it("handles malformed metric values gracefully", () => {
    const history = [
      { role: "assistant", metrics: { prompt_tokens: -5 } },
      { role: "assistant", metrics: { prompt_tokens: undefined } },
      { role: "assistant" },
    ];
    expect(lastContextUsageFromHistory(history)).toBeNull();
  });

  it("defaults model to null when not present in metrics", () => {
    const result = lastContextUsageFromHistory([
      { role: "assistant", metrics: { prompt_tokens: 42 } },
    ]);
    expect(result).toEqual({ promptTokens: 42, model: null });
  });
});
