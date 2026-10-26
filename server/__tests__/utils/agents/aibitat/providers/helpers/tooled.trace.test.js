/**
 * Step 3 tests (agent-full-context-trace): provider reasoning threading +
 * next-turn history reconstruction.
 *
 * Covers:
 * - `tooledStream`/`tooledComplete` return `reasoning` (Step 3.1) on tool-call
 *   and text branches; reasoning no longer pollutes `textResponse` (stray
 *   `</thought>` artifact fixed — 0.2).
 * - UnTooled `streamingFunctionCall` returns `reasoning`; `cleanMsgs` labels
 *   collapsed function messages (F8/AC7).
 * - Shared `extractThought` helper splits tag-polluted text (paths C / G,
 *   legacy rows — AC11).
 * - F4/AC4: `AgentHandler.#chatHistory` expands a persisted trace into
 *   intermediate aibitat messages that survive `getOrFormatNodeChatHistory`
 *   AND `formatMessagesForTools` (assistant tool_calls + role:"tool" pairs
 *   at the provider boundary).
 * - N5/AC12: oversized tool_result content truncated in-context with
 *   `[truncated]` marker.
 * - AC21/N4: malformed pairs degrade to plain text.
 * - Feature flag `AGENT_TRACE_RECONSTRUCTION=0` disables reconstruction.
 */

// Set required env vars before requiring modules (same pattern as
// defaults.test.js — AgentHandler → updateENV → bedrock SDK needs these).
process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(),
  InvokeModelCommand: jest.fn(),
}));
jest.mock("@aws-sdk/token-providers", () => ({
  fromStatic: jest.fn(() => ({ token: jest.fn() })),
}));
jest.mock("@langchain/aws", () => ({
  ChatBedrockConverse: jest.fn(),
}));
// MCP SDK's zod-compat needs zod/v3 subpath which jest-resolve can't map
// through the SDK's export conditions — stub the whole layer (same spirit
// as defaults.test.js's MCP mock).
jest.mock("../../../../../../utils/MCP", () => {
  return jest.fn().mockImplementation(() => ({
    activeMCPServers: jest.fn().mockResolvedValue([]),
  }));
});

jest.mock("../../../../../../utils/agents/aibitat/providers", () => {
  class FakeProvider {
    static instances = [];
    // Step 4 test knobs: capabilities applied in the constructor (reply()
    // rebuilds providerInstance via getProviderForConfig, so per-instance
    // injection is discarded before the first call), a static message
    // capture list, and a scripted return queue.
    static _script = [];
    static _capabilities = null;
    static seenMessages = [];
    constructor() {
      this.calls = [];
      FakeProvider.instances.push(this);
      if (FakeProvider._capabilities) {
        this.supportsReasoningHistory =
          FakeProvider._capabilities.supportsReasoningHistory;
        this.reasoningHistoryField =
          FakeProvider._capabilities.reasoningHistoryField;
      }
    }
    attachHandlerProps(props) {
      this.handlerProps = props;
    }
    getUsage() {
      return { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    }
    get supportsAgentStreaming() {
      return FakeProvider._streams ?? true;
    }
    async stream(messages, functions, eventHandler) {
      this.calls.push({ type: "stream", messages, functions });
      FakeProvider.seenMessages.push(messages);
      if (FakeProvider._script.length > 0) {
        return FakeProvider._script.shift()();
      }
      return { textResponse: "final answer", functionCall: null, uuid: "u" };
    }
    async complete(messages, functions) {
      this.calls.push({ type: "complete", messages, functions });
      if (FakeProvider._script.length > 0) {
        return FakeProvider._script.shift()();
      }
      return { textResponse: "final answer", functionCall: null };
    }
  }
  return { OpenAIProvider: FakeProvider };
});

jest.mock("../../../../../../models/workspaceChats", () => ({
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

jest.mock("../../../../../../models/workspaceThread", () => ({
  WorkspaceThread: {
    get: jest.fn(async () => null),
    autoRenameThread: jest.fn(async () => {}),
  },
}));

const AIbitat = require("../../../../../../utils/agents/aibitat/index.js");
const { tooledStream, tooledComplete, formatMessagesForTools } = require(
  "../../../../../../utils/agents/aibitat/providers/helpers/tooled.js"
);
const UnTooled = require("../../../../../../utils/agents/aibitat/providers/helpers/untooled.js");
const { extractThought } = require("../../../../../../utils/agents/aibitat/providers/helpers/trace.js");
const { AgentHandler } = require("../../../../../../utils/agents/index.js");
const { WorkspaceChats } = require("../../../../../../models/workspaceChats");

const FakeProvider =
  require("../../../../../../utils/agents/aibitat/providers").OpenAIProvider;

// ---- tooledStream / tooledComplete ----

function makeOpenAIStreamClient(chunks) {
  return {
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            for (const chunk of chunks) yield chunk;
          })(),
      },
    },
  };
}

describe("tooledStream reasoning threading (Step 3.1)", () => {
  test("tool-call turn: reasoning returned separately, textResponse clean", async () => {
    const client = makeOpenAIStreamClient([
      {
        choices: [
          { delta: { reasoning_content: "I should use the tool because" } },
        ],
      },
      { choices: [{ delta: { reasoning_content: " it is needed." } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  function: { name: "my-tool", arguments: '{"x":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } },
        ],
      },
    ]);

    const result = await tooledStream(client, "m", [], [], null);
    expect(result.reasoning).toBe("I should use the tool because it is needed.");
    expect(result.textResponse).toBe("");
    expect(result.functionCall).toEqual({
      id: "call_abc",
      name: "my-tool",
      arguments: { x: 1 },
    });
  });

  test("text turn: no stray </thought> in textResponse; reasoning separate", async () => {
    const client = makeOpenAIStreamClient([
      { choices: [{ delta: { reasoning_content: "thinking hard" } }] },
      { choices: [{ delta: { content: "The answer" } }] },
      { choices: [{ delta: { content: " is 4." } }] },
    ]);

    const events = [];
    const result = await tooledStream(
      client,
      "m",
      [],
      [],
      (type, data) => events.push(data)
    );

    expect(result.reasoning).toBe("thinking hard");
    expect(result.textResponse).toBe("The answer is 4.");
    // The live stream still carries the wrapped version (frontend contract).
    expect(events.some((e) => e.content?.includes("<thought>thinking hard"))).toBe(
      true
    );
    expect(events.some((e) => e.content?.includes("</thought>The answer"))).toBe(
      true
    );
  });

  test("no reasoning tokens: reasoning is empty string, behavior unchanged", async () => {
    const client = makeOpenAIStreamClient([
      { choices: [{ delta: { content: "hello" } }] },
    ]);
    const result = await tooledStream(client, "m", [], [], null);
    expect(result.reasoning).toBe("");
    expect(result.textResponse).toBe("hello");
  });
});

describe("tooledComplete reasoning capture (Step 3.1)", () => {
  function makeClient(message) {
    return {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      },
    };
  }

  test("reads reasoning_content from the completion message", async () => {
    const client = makeClient({
      content: "answer",
      reasoning_content: "deep thought",
    });
    const result = await tooledComplete(client, "m", [], []);
    expect(result.reasoning).toBe("deep thought");
    expect(result.textResponse).toBe("answer");
  });

  test("tool-call branch also carries reasoning", async () => {
    const client = makeClient({
      content: null,
      reasoning: "cerebras-style",
      tool_calls: [
        { id: "call_x", function: { name: "t", arguments: '{"a":1}' } },
      ],
    });
    const result = await tooledComplete(client, "m", [], []);
    expect(result.reasoning).toBe("cerebras-style");
    expect(result.functionCall.name).toBe("t");
  });

  test("no reasoning field → empty string", async () => {
    const client = makeClient({ content: "plain" });
    const result = await tooledComplete(client, "m", [], []);
    expect(result.reasoning).toBe("");
  });
});

// ---- UnTooled ----

describe("UnTooled streamingFunctionCall reasoning (Step 3)", () => {
  function makeUntooled(chunks) {
    const untooled = new UnTooled();
    // streamingFunctionCall's message-building path calls
    // this.formatMessageWithAttachments, which lives on the Provider base —
    // standalone UnTooled instances don't have it. Borrow the base method
    // (ai-provider.js exports the class directly).
    const Provider = require("../../../../../../utils/agents/aibitat/providers/ai-provider");
    untooled.formatMessageWithAttachments =
      Provider.prototype.formatMessageWithAttachments;
    const chatCb = async () =>
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    return { untooled, chatCb };
  }

  test("tool-pick branch returns reasoning from the stream", async () => {
    const { untooled, chatCb } = makeUntooled([
      { choices: [{ delta: { reasoning_content: "I will pick a function" } }] },
      {
        choices: [
          { delta: { content: '{"name":"t","arguments":{"a":1}}' } },
        ],
      },
    ]);
    const functions = [
      {
        name: "t",
        description: "d",
        parameters: {
          type: "object",
          properties: { a: { type: "number" } },
          required: ["a"],
        },
      },
    ];
    const result = await untooled.streamingFunctionCall(
      [{ role: "user", content: "hi" }],
      functions,
      chatCb,
      null
    );
    expect(result.toolCall).toEqual({ name: "t", arguments: { a: 1 } });
    expect(result.reasoning).toBe("I will pick a function");
  });

  test("text branch keeps reasoning out of text", async () => {
    const { untooled, chatCb } = makeUntooled([
      { choices: [{ delta: { reasoning_content: "pondering" } }] },
      { choices: [{ delta: { content: "just text, no tool" } }] },
    ]);
    const result = await untooled.streamingFunctionCall(
      [{ role: "user", content: "hi" }],
      [],
      chatCb,
      null
    );
    expect(result.toolCall).toBeNull();
    expect(result.text).toBe("just text, no tool");
    expect(result.reasoning).toBe("pondering");
  });
});

describe("UnTooled cleanMsgs labels (F8/AC7)", () => {
  const untooled = new UnTooled();
  const Provider = require("../../../../../../utils/agents/aibitat/providers/ai-provider");
  untooled.formatMessageWithAttachments =
    Provider.prototype.formatMessageWithAttachments;

  test("collapsed function messages carry [tool:name(args)] labels", () => {
    const out = untooled.cleanMsgs([
      { role: "assistant", content: "Let me check." },
      {
        role: "function",
        name: "file-reader",
        content: "file contents here",
        originalFunctionCall: {
          id: "call_1",
          name: "file-reader",
          arguments: { path: "a.txt" },
        },
      },
      {
        role: "function",
        name: "file-reader",
        content: "more contents",
        originalFunctionCall: {
          id: "call_2",
          name: "file-reader",
          arguments: '{"path":"b.txt"}',
        },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('[tool:file-reader({"path":"a.txt"})]');
    expect(out[0].content).toContain("file contents here");
    expect(out[0].content).toContain(
      '[tool:file-reader({"path":"b.txt"})]'
    );
    expect(out[0].content).toContain("more contents");
  });

  test("function message without originalFunctionCall falls back to name", () => {
    const out = untooled.cleanMsgs([
      { role: "assistant", content: "Hi" },
      { role: "function", name: "legacy-tool", content: "result" },
    ]);
    expect(out[0].content).toContain("[tool:legacy-tool({})]");
  });
});

// ---- extractThought helper ----

describe("extractThought shared helper (paths C/G, legacy rows)", () => {
  test("splits matched <thought> pairs out of text", () => {
    const { text, reasoning } = extractThought(
      "<thought>plan the work</thought>Here is the answer."
    );
    expect(reasoning).toBe("plan the work");
    expect(text).toBe("Here is the answer.");
  });

  test("accepts Ollama's <think> spelling (legacy rows, AC11)", () => {
    const { text, reasoning } = extractThought("<think>legacy</think>Answer.");
    expect(reasoning).toBe("legacy");
    expect(text).toBe("Answer.");
  });

  test("strips a stray unmatched closing tag (pre-Step-3 artifact)", () => {
    const { text, reasoning } = extractThought("</thought>stray artifact");
    expect(reasoning).toBe("");
    expect(text).toBe("stray artifact");
  });

  test("plain text passes through untouched", () => {
    expect(extractThought("no tags")).toEqual({
      text: "no tags",
      reasoning: "",
    });
  });
});

// ---- F4: next-turn history reconstruction ----

function makeHandler() {
  // Must be a REAL instance: chatHistory() invokes the private method
  // #traceToIntermediateMessages, and JS private methods enforce a brand
  // check — calling them on a mere Object.create(AgentHandler.prototype)
  // throws (swallowed by chatHistory's try/catch, yielding []). The
  // constructor only sets the invocation UUID, so this is safe.
  const handler = new AgentHandler({ uuid: "test-invocation" });
  handler.invocation = {
    workspace_id: 1,
    user_id: null,
    thread_id: null,
  };
  handler.log = () => {};
  return handler;
}

describe("AgentHandler #chatHistory trace reconstruction (F4/AC4)", () => {
  beforeEach(() => {
    delete process.env.AGENT_TRACE_RECONSTRUCTION;
    delete process.env.AGENT_TRACE_RESULT_CONTEXT_CHARS;
    WorkspaceChats.where.mockClear();
  });
  afterEach(() => {
    delete process.env.AGENT_TRACE_RECONSTRUCTION;
    delete process.env.AGENT_TRACE_RESULT_CONTEXT_CHARS;
  });

  function mockHistoryRow(trace, text = "final answer") {
    // chatHistory() now runs crash-recovery promotion (Step 3b) BEFORE the
    // history load — the promotion query filters include:false, the history
    // load include:true. Key the mock on the clause so the promotion lookup
    // sees no orphans and the queued row feeds the history read.
    WorkspaceChats.where.mockImplementation(async (clause) => {
      if (clause?.include === false) return []; // no orphans to promote
      return [
        { prompt: "do the thing", response: JSON.stringify({ text, trace }) },
      ];
    });
  }

  test("legacy rows (no trace) expand to exactly the old USER/assistant pair", async () => {
    mockHistoryRow(undefined, "legacy text");
    const handler = makeHandler();
    const history = await handler.chatHistory(20);
    expect(history).toEqual([
      {
        from: "USER",
        to: "@agent",
        content: "do the thing",
        state: "success",
      },
      {
        from: "@agent",
        to: "USER",
        content: "legacy text",
        state: "success",
      },
    ]);
  });

  test("traced rows expand to assistant/function intermediates + final text", async () => {
    const trace = {
      entries: [
        { type: "reasoning", llmCall: 1, text: "I need the file first" },
        {
          type: "tool_call",
          llmCall: 1,
          callId: "call_9",
          name: "file-reader",
          arguments: { path: "a.txt" },
        },
        {
          type: "tool_result",
          callId: "call_9",
          name: "file-reader",
          content: "the file contents",
        },
        { type: "llm_text", llmCall: 1, text: "Let me read it." },
        { type: "llm_text", llmCall: 2, text: "final answer" },
      ],
      llmCalls: 2,
      truncated: false,
    };
    mockHistoryRow(trace);

    const handler = makeHandler();
    const history = await handler.chatHistory(20);

    // USER, reasoning, tool(function), pre-tool text, final text
    expect(history).toHaveLength(5);
    expect(history[0].content).toBe("do the thing");
    expect(history[1]).toMatchObject({
      traceRole: "assistant",
      content: "<thought>I need the file first</thought>",
    });
    expect(history[2]).toMatchObject({
      traceRole: "function",
      name: "file-reader",
      content: "the file contents",
    });
    expect(history[2].originalFunctionCall).toEqual({
      id: "call_9",
      name: "file-reader",
      arguments: { path: "a.txt" },
    });
    expect(history[3]).toMatchObject({
      traceRole: "assistant",
      content: "Let me read it.",
    });
    expect(history[4].content).toBe("final answer");
    expect(history[4].traceRole).toBeUndefined();
    // The final text is not duplicated as an intermediate.
    expect(
      history.slice(1, -1).filter((m) => m.content === "final answer")
    ).toHaveLength(0);
  });

  test("reconstructed intermediates survive getOrFormatNodeChatHistory", async () => {
    const trace = {
      entries: [
        {
          type: "tool_call",
          llmCall: 1,
          callId: "call_9",
          name: "file-reader",
          arguments: { path: "a.txt" },
        },
        {
          type: "tool_result",
          callId: "call_9",
          name: "file-reader",
          content: "contents",
        },
      ],
      llmCalls: 1,
      truncated: false,
    };
    mockHistoryRow(trace);

    const handler = makeHandler();
    const history = await handler.chatHistory(20);

    // Feed through a real aibitat instance's getOrFormatNodeChatHistory.
    const aibitat = new AIbitat({
      chats: history,
      provider: "openai",
      model: "m",
    });
    aibitat.agent("@agent", { role: "a" });
    // chatHistory emits messages where the agent is "@agent" (WORKSPACE_AGENT.name).
    // reply() calls this as { from: <replier>, to: <sender> } — i.e. the agent
    // replying to USER — so route.from = "@agent". The flat role-assignment is
    // c.from === route.to ? "user" : "assistant", so we must route from the
    // agent's perspective for the USER prompt to format as role:"user".
    const formatted = aibitat.getOrFormatNodeChatHistory({
      from: "@agent",
      to: "USER",
    });

    // user prompt, function result w/ originalFunctionCall, final text.
    expect(formatted).toHaveLength(3);
    expect(formatted[0]).toEqual({
      content: "do the thing",
      role: "user",
    });
    expect(formatted[1].role).toBe("function");
    expect(formatted[1].originalFunctionCall.id).toBe("call_9");
    expect(formatted[2]).toEqual({
      content: "final answer",
      role: "assistant",
    });

    // And through the provider boundary — the OpenAI-tools converter must
    // synthesize assistant.tool_calls + role:"tool" pairs (AC4).
    const providerFormatted = formatMessagesForTools(formatted);
    const assistantMsg = providerFormatted.find(
      (m) => m.role === "assistant" && m.tool_calls
    );
    expect(assistantMsg.tool_calls[0]).toMatchObject({
      id: "call_9",
      type: "function",
      function: { name: "file-reader", arguments: '{"path":"a.txt"}' },
    });
    const toolMsg = providerFormatted.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({
      tool_call_id: "call_9",
      content: "contents",
    });
  });

  test("N5/AC12: oversized tool_result content truncated in-context with [truncated]", async () => {
    process.env.AGENT_TRACE_RESULT_CONTEXT_CHARS = "100";
    const big = "x".repeat(5000);
    const trace = {
      entries: [
        {
          type: "tool_call",
          llmCall: 1,
          callId: "call_1",
          name: "big-tool",
          arguments: {},
        },
        {
          type: "tool_result",
          callId: "call_1",
          name: "big-tool",
          content: big,
        },
      ],
      llmCalls: 1,
      truncated: false,
    };
    mockHistoryRow(trace);

    const handler = makeHandler();
    const history = await handler.chatHistory(20);
    const fnMsg = history.find((m) => m.traceRole === "function");
    expect(fnMsg.content.length).toBeLessThan(big.length);
    expect(fnMsg.content.endsWith("[truncated]")).toBe(true);
  });

  test("AC21: tool_result without callId degrades to plain assistant text", async () => {
    const trace = {
      entries: [
        {
          type: "tool_result",
          callId: null,
          name: "mystery-tool",
          content: "orphan result",
        },
      ],
      llmCalls: 1,
      truncated: false,
    };
    mockHistoryRow(trace);

    const handler = makeHandler();
    const history = await handler.chatHistory(20);
    const degraded = history.find(
      (m) => m.traceRole === "assistant" && m.content.includes("orphan result")
    );
    expect(degraded).toBeTruthy();
    expect(history.find((m) => m.traceRole === "function")).toBeUndefined();
  });

  test("feature flag AGENT_TRACE_RECONSTRUCTION=0 disables expansion", async () => {
    process.env.AGENT_TRACE_RECONSTRUCTION = "0";
    const trace = {
      entries: [
        {
          type: "tool_call",
          llmCall: 1,
          callId: "call_1",
          name: "t",
          arguments: {},
        },
      ],
      llmCalls: 1,
      truncated: false,
    };
    mockHistoryRow(trace);

    const handler = makeHandler();
    const history = await handler.chatHistory(20);
    expect(history).toHaveLength(2); // plain pair, flag honored
  });

  test("malformed trace JSON fails open to the legacy pair", async () => {
    WorkspaceChats.where.mockImplementation(async (clause) =>
      clause?.include === false
        ? []
        : [{ prompt: "q", response: "not-json{{" }]
    );
    const handler = makeHandler();
    const history = await handler.chatHistory(20);
    expect(history).toHaveLength(2);
    expect(history[1].content).toBe("");
  });
});

describe("trace-reconstructed messages do not inflate max rounds", () => {
  test("hasReachedMaximumRounds counts real exchanges only", () => {
    const aibitat = new AIbitat({
      chats: [
        {
          from: "USER",
          to: "agent",
          content: "q",
          state: "success",
        },
        ...Array.from({ length: 15 }, (_, i) => ({
          from: "agent",
          to: "USER",
          content: `intermediate ${i}`,
          state: "success",
          traceRole: "assistant",
          traceReconstructed: true,
        })),
        {
          from: "agent",
          to: "USER",
          content: "final",
          state: "success",
        },
      ],
      maxRounds: 3,
    });
    aibitat.agent("USER", { role: "u" });
    aibitat.agent("agent", { role: "a" });
    // The point is the 15 reconstructed intermediates don't count as rounds.
    // getHistory counts BOTH directions, so the real messages are the user
    // prompt + the final reply = 2, which must stay under maxRounds: 3.
    expect(aibitat.hasReachedMaximumRounds("agent", "USER")).toBe(false);
  });
});

// ---- Step 4: in-turn reasoning retention (F5/AC6) ----

describe("Step 4: in-turn reasoning retention (F5/AC6)", () => {
  /**
   * Drive a two-round tool loop with the scripted FakeProvider and capture
   * the message arrays every provider call receives.
   *
   * NOTE: capabilities and message capture go through the class-level
   * FakeProvider mock — reply() rebuilds providerInstance via
   * getProviderForConfig every turn, so a directly-assigned
   * `aibitat.providerInstance` is discarded before the first call.
   */
  async function runTwoRoundTurn(providerShaping = {}) {
    FakeProvider._capabilities = {
      supportsReasoningHistory: providerShaping.supportsReasoningHistory ?? false,
      reasoningHistoryField: providerShaping.reasoningHistoryField ?? "reasoning_content",
    };
    FakeProvider.seenMessages = [];
    FakeProvider._script = [
      // Round 1: tool call with reasoning.
      () => ({
        functionCall: { id: "call_1", name: "tool-a", arguments: {} },
        textResponse: "let me check",
        reasoning: "I should use tool-a first",
        uuid: "u1",
      }),
      // Round 2: final text.
      () => ({ textResponse: "all done", functionCall: null, uuid: "u2" }),
    ];

    const aibitat = new AIbitat({
      chats: [],
      maxRounds: 10,
      maxToolCalls: 10,
      provider: "openai",
      model: "gpt-4",
      handlerProps: {
        invocation: { workspace_id: 1, user_id: null, thread_id: null },
        log: () => {},
      },
    });
    aibitat.agent("USER", { role: "u", interrupt: "ALWAYS" });
    aibitat.agent("agent", { role: "a" });
    aibitat.function({ name: "tool-a", handler: async () => "tool-a-result" });

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    const seenMessages = FakeProvider.seenMessages;
    // Reset knobs so later suites are unaffected.
    FakeProvider._capabilities = null;
    FakeProvider._script = [];
    return { aibitat, seenMessages };
  }

  test("capability OFF (default): no reasoning fields reach the provider messages", async () => {
    const { seenMessages } = await runTwoRoundTurn({});

    expect(seenMessages).toHaveLength(2);
    const second = seenMessages[1];
    // No internal markers leak.
    for (const msg of second) {
      expect(msg.__inTurnReasoning).toBeUndefined();
      expect(msg.__reasoningField).toBeUndefined();
      expect(msg.__reasoningText).toBeUndefined();
    }
    // The function message is exactly today's shape.
    const fnMsg = second.find((m) => m.role === "function");
    expect(fnMsg).toMatchObject({ name: "tool-a", content: "tool-a-result" });
    expect(fnMsg.content.startsWith("<thought>")).toBe(false);
  });

  test("capability true: reasoning rides to the formatter as the native carrier", async () => {
    const { seenMessages } = await runTwoRoundTurn({
      supportsReasoningHistory: true,
    });

    expect(seenMessages).toHaveLength(2);
    const fnMsg = seenMessages[1].find((m) => m.role === "function");
    expect(fnMsg.__reasoningField).toBe("reasoning_content");
    expect(fnMsg.__reasoningText).toBe("I should use tool-a first");
    // The raw marker is always stripped, carrier or not.
    expect(fnMsg.__inTurnReasoning).toBeUndefined();
  });

  test("capability true + custom field: field name follows reasoningHistoryField", async () => {
    const { seenMessages } = await runTwoRoundTurn({
      supportsReasoningHistory: true,
      reasoningHistoryField: "thinking",
    });
    const fnMsg = seenMessages[1].find((m) => m.role === "function");
    expect(fnMsg.__reasoningField).toBe("thinking");
  });

  test("capability 'text': reasoning rides as <thought>-wrapped content prefix", async () => {
    const { seenMessages } = await runTwoRoundTurn({
      supportsReasoningHistory: "text",
    });
    const fnMsg = seenMessages[1].find((m) => m.role === "function");
    expect(fnMsg.__reasoningField).toBeUndefined();
    expect(fnMsg.__reasoningText).toBeUndefined();
    expect(fnMsg.content.startsWith("<thought>I should use tool-a first</thought>")).toBe(true);
    expect(fnMsg.content).toContain("tool-a-result");
  });

  test("AC6 end-to-end: formatMessagesForTools merges the carrier into the assistant tool_call message", async () => {
    const { seenMessages } = await runTwoRoundTurn({
      supportsReasoningHistory: true,
    });
    const formatted = formatMessagesForTools(seenMessages[1]);
    const toolCallAssistant = formatted.find(
      (m) => m.role === "assistant" && m.tool_calls
    );
    // `id` lives on tool_calls[0], not the assistant message root.
    expect(toolCallAssistant.tool_calls[0]).toMatchObject({ id: "call_1" });
    expect(toolCallAssistant.reasoning_content).toBe("I should use tool-a first");
    const toolMsg = formatted.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ tool_call_id: "call_1", content: "tool-a-result" });
  });

  test("base Provider capability defaults: false / reasoning_content", () => {
    const Provider = require("../../../../../../utils/agents/aibitat/providers/ai-provider");
    const p = new Provider();
    expect(p.supportsReasoningHistory).toBe(false);
    expect(p.reasoningHistoryField).toBe("reasoning_content");
  });
});

// ---- Step 3b: crash-recovery promotion (F13/AC18) ----
// (stop-reason persistence tests live in trace-buffer.test.js, which owns
// the aibitat+plugin scaffolding these save-path asserts require)

describe("Step 3b: crash-recovery promotion (F13/AC18)", () => {
  beforeEach(() => {
    delete process.env.AGENT_TRACE_PROMOTION_MIN_AGE_MS;
    WorkspaceChats.where.mockReset();
    WorkspaceChats.upsert.mockClear();
  });
  afterEach(() => {
    delete process.env.AGENT_TRACE_PROMOTION_MIN_AGE_MS;
  });

  function makeHandlerForPromotion() {
    const handler = new AgentHandler({ uuid: "promotion-test" });
    handler.invocation = {
      workspace_id: 1,
      user_id: null,
      thread_id: null,
    };
    handler.log = () => {};
    return handler;
  }

  function tracedOrphan({ ageMs = 10 * 60 * 1000, stopReason = null } = {}) {
    return {
      id: 77,
      workspaceId: 1,
      user_id: null,
      thread_id: null,
      include: false,
      lastUpdatedAt: new Date(Date.now() - ageMs),
      response: JSON.stringify({
        text: "",
        ...(stopReason ? { stopReason } : {}),
        trace: {
          entries: [
            {
              type: "tool_call",
              llmCall: 1,
              callId: "call_1",
              name: "t",
              arguments: {},
            },
            {
              type: "tool_result",
              callId: "call_1",
              name: "t",
              content: "r",
            },
          ],
          llmCalls: 1,
          truncated: false,
        },
      }),
    };
  }

  test("orphaned flushed row is promoted once: include:true + stopReason 'interrupted'", async () => {
    const orphan = tracedOrphan();
    WorkspaceChats.where.mockResolvedValue([orphan]);

    const handler = makeHandlerForPromotion();
    await handler.chatHistory(20); // chatHistory runs promotion first

    expect(WorkspaceChats.upsert).toHaveBeenCalledTimes(1);
    const [chatId, payload] = WorkspaceChats.upsert.mock.calls[0];
    expect(chatId).toBe(77);
    expect(payload.include).toBe(true);
    expect(payload.response.stopReason).toBe("interrupted");
    // Existing response keys survive the merge (trace intact).
    expect(payload.response.trace.entries).toHaveLength(2);
  });

  test("promotion is idempotent: rows already carrying a stopReason are skipped (AC18)", async () => {
    WorkspaceChats.where.mockResolvedValue([
      tracedOrphan({ stopReason: "interrupted" }),
    ]);

    const handler = makeHandlerForPromotion();
    await handler.chatHistory(20);

    expect(WorkspaceChats.upsert).not.toHaveBeenCalled();
  });

  test("recency guard: a live turn's freshly flushed placeholder is not promoted (0.14)", async () => {
    WorkspaceChats.where.mockResolvedValue([tracedOrphan({ ageMs: 2_000 })]);

    const handler = makeHandlerForPromotion();
    await handler.chatHistory(20);

    expect(WorkspaceChats.upsert).not.toHaveBeenCalled();
  });

  test("rows without a trace are never promoted (AC18)", async () => {
    WorkspaceChats.where.mockResolvedValue([
      {
        id: 88,
        workspaceId: 1,
        user_id: null,
        thread_id: null,
        include: false,
        lastUpdatedAt: new Date(Date.now() - 10 * 60 * 1000),
        response: JSON.stringify({ text: "ghost row, no trace" }),
      },
    ]);

    const handler = makeHandlerForPromotion();
    await handler.chatHistory(20);

    expect(WorkspaceChats.upsert).not.toHaveBeenCalled();
  });

  test("brand-new threads (no prior rows) skip promotion cleanly", async () => {
    WorkspaceChats.where.mockResolvedValue([]);

    const handler = makeHandlerForPromotion();
    const history = await handler.chatHistory(20);

    expect(history).toEqual([]);
    expect(WorkspaceChats.upsert).not.toHaveBeenCalled();
  });

  test("a promoted row then flows into history reconstruction like any traced row", async () => {
    const orphan = tracedOrphan();
    WorkspaceChats.where.mockImplementation(async (_clause, limit, orderBy) => {
      // First call = promotion lookup (include:false); second = history load
      // (include:true). Simulate the promotion making the row visible.
      const includeTrue = JSON.stringify(_clause).includes('"include":true');
      return includeTrue ? [{ ...orphan, include: true }] : [orphan];
    });

    const handler = makeHandlerForPromotion();
    const history = await handler.chatHistory(20);

    // USER + reconstructed intermediates (function result) + final text.
    // The promoted row's empty text yields an empty final message; the
    // function intermediate proves the trace flowed through.
    expect(history.some((m) => m.traceRole === "function")).toBe(true);
  });
});
