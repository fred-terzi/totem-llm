/* eslint-env jest */
/**
 * Step 7 (F7) — AC20: the server-side history serializer
 * (`convertToChatHistory` in server/utils/helpers/chat/responses.js)
 * whitelists `response` JSON keys. Before Step 7 it silently dropped
 * `trace`; this pins the additive passthrough so agent-trace rows reach
 * the frontend/history-API consumers intact, while legacy rows stay
 * byte-identical (no `trace` key at all).
 */
const moment = require("moment");

const { convertToChatHistory } = require("../../../utils/helpers/chat/responses");

const TRACE = {
  version: 1,
  entries: [
    { seq: 1, type: "llmCall", n: 1, ts: 1730000000000, reasoning: "thinking...", text: "part" },
    { seq: 2, type: "toolCall", n: 1, ts: 1730000001000, tool: "web-scraping", args: { url: "https://x" } },
    { seq: 3, type: "toolResult", n: 1, ts: 1730000002000, tool: "web-scraping", content: "page text" },
    { seq: 4, type: "llmCall", n: 2, ts: 1730000003000, reasoning: "", text: "final answer" },
  ],
};

const makeRecord = (responseJson) => ({
  id: 42,
  prompt: "what is on https://x?",
  response: JSON.stringify(responseJson),
  createdAt: new Date("2026-10-26T00:00:00.000Z"),
  feedbackScore: null,
});

describe("convertToChatHistory — agent trace passthrough (F7/AC20)", () => {
  test("traced row: response.trace survives the serializer on the assistant message", () => {
    const [assistantMsg] = convertToChatHistory([
      makeRecord({
        text: "final answer",
        sources: [],
        metrics: {},
        trace: TRACE,
      }),
    ]).filter((m) => m.role === "assistant");

    expect(assistantMsg.trace).toEqual(TRACE);
    // passthrough must not disturb the whitelisted fields
    expect(assistantMsg.content).toBe("final answer");
    expect(assistantMsg.chatId).toBe(42);
    expect(assistantMsg.sentAt).toBe(moment("2026-10-26T00:00:00.000Z").unix());
  });

  test("traced row with type agent + stopReason markers still passes trace through", () => {
    // Step 3b/6 error/abort rows always carry a string text (0.8) so they
    // are never skipped by the serializer's text-type guard.
    const [, assistantMsg] = convertToChatHistory([
      makeRecord({
        text: "",
        type: "abort",
        aborted: true,
        stopReason: "user_abort",
        trace: TRACE,
      }),
    ]);

    expect(assistantMsg.trace).toEqual(TRACE);
    expect(assistantMsg.content).toBe("");
    expect(assistantMsg.type).toBe("abort");
  });

  test("legacy/untraced row: no trace key is added (additive-only change)", () => {
    const [, assistantMsg] = convertToChatHistory([
      makeRecord({ text: "plain reply", sources: [], metrics: {} }),
    ]);

    expect(assistantMsg.hasOwnProperty("trace")).toBe(false);
    expect(assistantMsg.content).toBe("plain reply");
  });

  test("trace key absent when explicitly falsy (undefined/null/empty string)", () => {
    for (const trace of [undefined, null, ""]) {
      const [, assistantMsg] = convertToChatHistory([
        makeRecord({ text: "reply", trace }),
      ]);
      expect(assistantMsg.hasOwnProperty("trace")).toBe(false);
    }
  });
});
