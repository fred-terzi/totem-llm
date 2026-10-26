/* eslint-env jest */
/**
 * Step 8 — AC11 (N3) / AC15 (N8): legacy rows (pre-trace schema) and
 * standard chat-mode rows must behave exactly as they did before the
 * agent-trace workstream — no trace fields required, no errors, no
 * shape changes.
 *
 * Two layers pinned here:
 *
 * 1. History LOADING (AC11): `AgentHandler.chatHistory` over a legacy row
 *    (no `trace` key in the response JSON, and a row whose trace is the
 *    legacy `<think>`-embedded format) produces the identical USER/assistant
 *    pair — never throws, never fabricates trace entries. Also covers the
 *    corrupt-JSON fail-open path.
 *
 * 2. History RENDERING (AC15): `convertToChatHistory` on a standard
 *    `chat`-mode row (no agent invocation) adds no `trace` key — the
 *    rendered assistant message carries no trace field and all pre-trace
 *    whitelisted fields survive untouched.
 *
 * (The traced-row serializer passthrough itself is covered in
 * server/__tests__/utils/helpers/trace-exposure.test.js — this file is the
 * negative-space merge gate: legacy shapes unchanged.)
 */

jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    new: jest.fn(async ({ response }) => ({
      chat: { id: 42, response },
      message: null,
    })),
    upsert: jest.fn(async () => ({ chat: {}, message: null })),
    get: jest.fn(async () => ({ id: 42, response: "{}" })),
    where: jest.fn(async () => []),
  },
}));

jest.mock("../../../models/workspaceThread", () => ({
  WorkspaceThread: {
    get: jest.fn(async () => null),
    autoRenameThread: jest.fn(async () => {}),
  },
}));

jest.mock("../../../utils/MCP", () => {
  return jest.fn().mockImplementation(() => ({
    activeMCPServers: jest.fn().mockResolvedValue([]),
  }));
});

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({}));
jest.mock("@aws-sdk/token-providers", () => ({}));
jest.mock("@langchain/aws", () => ({}));

const { AgentHandler } = require("../../../utils/agents/index.js");
const { WorkspaceChats } = require("../../../models/workspaceChats");

function makeHandler() {
  const handler = new AgentHandler({ uuid: "test" });
  handler.invocation = {
    workspace_id: 1,
    user_id: null,
    thread_id: null,
  };
  handler.log = () => {};
  return handler;
}

describe("AC11 (N3): legacy rows (pre-trace schema) load clean", () => {
  beforeEach(() => {
    delete process.env.AGENT_TRACE_RECONSTRUCTION;
    delete process.env.AGENT_TRACE_RESULT_CONTEXT_CHARS;
    WorkspaceChats.where.mockClear();
  });
  afterEach(() => {
    delete process.env.AGENT_TRACE_RECONSTRUCTION;
    delete process.env.AGENT_TRACE_RESULT_CONTEXT_CHARS;
  });

  test("a pre-trace row (no trace key, no stopReason) expands to exactly the legacy USER/assistant pair", async () => {
    WorkspaceChats.where.mockImplementation(async (clause) =>
      clause?.include === false
        ? [] // no orphaned flushes to promote
        : [
            {
              prompt: "what files are here?",
              response: JSON.stringify({
                text: "There are 3 files.",
                sources: [],
                metrics: { prompt_tokens: 10, completion_tokens: 5 },
                // NOTE: no `trace`, no `stopReason`, no `aborted` — the
                // pre-trace schema exactly.
              }),
            },
          ]
    );

    const handler = makeHandler();
    const history = await handler.chatHistory(20);

    // Byte-identical to the pre-trace expansion: one pair, nothing else.
    expect(history).toEqual([
      {
        from: "USER",
        to: "@agent",
        content: "what files are here?",
        state: "success",
      },
      {
        from: "@agent",
        to: "USER",
        content: "There are 3 files.",
        state: "success",
      },
    ]);
  });

  test("a legacy Ollama row with <think>-embedded reasoning still renders as plain text (no crash, no split)", async () => {
    WorkspaceChats.where.mockImplementation(async (clause) =>
      clause?.include === false
        ? []
        : [
            {
              prompt: "hi",
              response: JSON.stringify({
                text: "<think>legacy reasoning</think>Plain answer.",
              }),
            },
          ]
    );

    const handler = makeHandler();
    // Must not throw, and the legacy text is preserved verbatim on the
    // row → pair expansion (in-context splitting of embedded tags happens
    // at the provider layer, not the loader).
    const history = await handler.chatHistory(20);
    expect(history).toHaveLength(2);
    expect(history[1].content).toBe(
      "<think>legacy reasoning</think>Plain answer."
    );
  });

  test("a row with a response that is not valid JSON does not break history loading", async () => {
    WorkspaceChats.where.mockImplementation(async (clause) =>
      clause?.include === false
        ? []
        : [{ prompt: "q", response: "definitely not json" }]
    );

    const handler = makeHandler();
    // Fail-open: the loader degrades to the legacy pair rather than
    // throwing (pre-trace behavior for corrupt rows).
    const history = await handler.chatHistory(20);
    expect(history).toHaveLength(2);
  });
});

describe("AC15 (N8): standard chat-mode rows keep today's shape (no trace)", () => {
  const {
    convertToChatHistory,
  } = require("../../../utils/helpers/chat/responses");

  test("a standard chat row (no agent invocation) renders with no trace key", () => {
    const [assistantMsg] = convertToChatHistory([
      {
        id: 7,
        prompt: "plain chat question",
        response: JSON.stringify({
          text: "plain chat answer",
          sources: [],
          metrics: { prompt_tokens: 3, completion_tokens: 2 },
          type: "chat",
        }),
        createdAt: new Date("2026-10-26T00:00:00.000Z"),
        feedbackScore: null,
      },
    ]).filter((m) => m.role === "assistant");

    expect("trace" in assistantMsg).toBe(false);
    expect(assistantMsg.content).toBe("plain chat answer");
    expect(assistantMsg.chatId).toBe(7);
    // All the pre-trace whitelisted fields survive untouched.
    expect(assistantMsg.sources).toEqual([]);
    expect(assistantMsg.metrics).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
    });
  });

  test("standard chat rows are not required to carry stopReason — the serializer never demands it", () => {
    const record = {
      id: 8,
      prompt: "q",
      response: JSON.stringify({ text: "a" }), // minimal pre-trace shape
      createdAt: new Date("2026-10-26T00:00:00.000Z"),
      feedbackScore: null,
    };
    const [assistantMsg] = convertToChatHistory([record]).filter(
      (m) => m.role === "assistant"
    );
    expect("trace" in assistantMsg).toBe(false);
    expect("stopReason" in assistantMsg).toBe(false);
    expect(assistantMsg.content).toBe("a");
  });
});
