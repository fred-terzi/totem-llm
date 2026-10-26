/**
 * Step 2 + 2b + 5 tests: AIbitat trace buffer (`aibitat._traceBuffer`),
 * incremental trace flush, and finalize-time trace persistence.
 *
 * Covers:
 * - append ordering, llmCall numbering (Step 2)
 * - size cap / truncation marker (N6)
 * - clearTrace + _cleanup draining (Step 5.2)
 * - finalize writes response.trace in the upsert payload (Step 5.1, N2)
 * - trace serialization failure is fail-open (N10)
 * - incremental flush after each completed tool call: include untouched,
 *   no debit, full-buffer last-write-wins serialization (F11/AC16, AC19)
 * - flush ownership guards: skipped when aborted/finalized (Step 6.3)
 *
 * Note: `arguments` on tool_call entries is passed through verbatim from the
 * provider's functionCall (parsing happens in the tooled helpers, not aibitat),
 * so fake providers that return string args produce string args in the trace.
 */

jest.mock("../../../../utils/agents/aibitat/providers", () => {
  class FakeProvider {
    static instances = [];
    constructor() {
      this.calls = [];
      this.verbose = false;
      FakeProvider.instances.push(this);
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

jest.mock("../../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    new: jest.fn(async ({ response }) => ({
      chat: { id: 42, response },
      message: null,
    })),
    upsert: jest.fn(async () => ({ chat: {}, message: null })),
    get: jest.fn(async () => ({
      id: 42,
      response: JSON.stringify({ somePlaceholderKey: "keep-me" }),
    })),
  },
}));

jest.mock("../../../../models/workspaceThread", () => ({
  WorkspaceThread: {
    get: jest.fn(async () => null),
    autoRenameThread: jest.fn(async () => {}),
  },
}));

const AIbitat = require("../../../../utils/agents/aibitat/index.js");
const { chatHistory } = require("../../../../utils/agents/aibitat/plugins/chat-history.js");
const { WorkspaceChats } = require("../../../../models/workspaceChats");

const FakeProvider =
  require("../../../../utils/agents/aibitat/providers").OpenAIProvider;

function makeAibitat({ withHistoryPlugin = true } = {}) {
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
  // Mirror the real pipeline's registration (server/utils/agents/defaults.js):
  // the USER agent has interrupt: "ALWAYS", which stops the chat loop after
  // the agent's first reply so tests end deterministically.
  aibitat.agent("USER", {
    role: "I am the human monitor.",
    interrupt: "ALWAYS",
  });
  aibitat.agent("agent", { role: "You are a test agent." });
  if (withHistoryPlugin) aibitat.use(chatHistory.plugin());
  return aibitat;
}

function finalizeCalls() {
  return WorkspaceChats.upsert.mock.calls.filter(
    ([, payload]) => payload?.include === true
  );
}

function resetMocks() {
  FakeProvider.instances = [];
  FakeProvider._streams = true;
  FakeProvider._script = [];
  WorkspaceChats.new.mockClear();
  WorkspaceChats.upsert.mockClear();
  WorkspaceChats.get.mockClear();
}

function drain() {
  return new Promise((r) => setImmediate(r));
}

describe("AIbitat trace buffer (Step 2)", () => {
  beforeEach(() => resetMocks());
  afterEach(() => {
    delete process.env.AGENT_TRACE_MAX_BYTES;
    delete process.env.AGENT_TRACE_FLUSH_INTERVAL_MS;
  });

  test("records reasoning, tool_call, and tool_result in execution order with llmCall indices", async () => {
    // No history plugin → no finalize cleanup, buffer stays inspectable.
    const aibitat = makeAibitat({ withHistoryPlugin: false });
    FakeProvider._script = [
      () => ({
        functionCall: { id: "call_1", name: "tool-a", arguments: "{}" },
        textResponse: "let me check",
        reasoning: "I should use tool-a first",
        uuid: "u1",
      }),
      () => ({ textResponse: "all done", functionCall: null, uuid: "u2" }),
    ];
    aibitat.function({ name: "tool-a", handler: async () => "tool-a-result" });

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    const trace = aibitat.getTrace();
    expect(trace.llmCalls).toBe(2);
    expect(trace.truncated).toBe(false);
    expect(trace.entries).toEqual([
      { type: "reasoning", llmCall: 1, text: "I should use tool-a first" },
      { type: "llm_text", llmCall: 1, text: "let me check" },
      {
        type: "tool_call",
        llmCall: 1,
        callId: "call_1",
        name: "tool-a",
        arguments: "{}",
      },
      {
        type: "tool_result",
        callId: "call_1",
        name: "tool-a",
        content: "tool-a-result",
      },
      { type: "llm_text", llmCall: 2, text: "all done" },
    ]);
  });

  test("records the tool loop on the synchronous (non-streaming) path too", async () => {
    FakeProvider._streams = false;
    const aibitat = makeAibitat({ withHistoryPlugin: false });
    FakeProvider._script = [
      () => ({
        functionCall: { id: "call_s1", name: "sync-tool", arguments: '{"x":1}' },
        textResponse: "",
      }),
      () => ({ textResponse: "sync done", functionCall: null }),
    ];
    aibitat.function({ name: "sync-tool", handler: async () => "sync-result" });

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    expect(aibitat.getTrace().entries).toEqual([
      {
        type: "tool_call",
        llmCall: 1,
        callId: "call_s1",
        name: "sync-tool",
        arguments: '{"x":1}',
      },
      {
        type: "tool_result",
        callId: "call_s1",
        name: "sync-tool",
        content: "sync-result",
      },
      { type: "llm_text", llmCall: 2, text: "sync done" },
    ]);
  });

  test("records an unknown-function tool_call + error tool_result and continues", async () => {
    const aibitat = makeAibitat({ withHistoryPlugin: false });
    FakeProvider._script = [
      () => ({
        functionCall: { id: "call_nf", name: "no-such-tool", arguments: "{}" },
        textResponse: "",
      }),
      () => ({ textResponse: "recovered", functionCall: null }),
    ];

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    expect(aibitat.getTrace().entries).toEqual([
      {
        type: "tool_call",
        llmCall: 1,
        callId: "call_nf",
        name: "no-such-tool",
        arguments: "{}",
      },
      {
        type: "tool_result",
        callId: "call_nf",
        name: "no-such-tool",
        content: 'Function "no-such-tool" not found. Try again.',
      },
      { type: "llm_text", llmCall: 2, text: "recovered" },
    ]);
  });

  test("size cap: over-cap appends push a single truncation_marker and stop (N6)", async () => {
    process.env.AGENT_TRACE_MAX_BYTES = "700";

    const aibitat = makeAibitat({ withHistoryPlugin: false });
    FakeProvider._script = [
      () => ({
        functionCall: { id: "call_big", name: "big-tool", arguments: "{}" },
        textResponse: "",
      }),
      () => ({ textResponse: "done", functionCall: null }),
    ];
    aibitat.function({
      name: "big-tool",
      handler: async () => "x".repeat(10_000),
    });

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    const trace = aibitat.getTrace();
    expect(trace.truncated).toBe(true);
    const markers = trace.entries.filter((e) => e.type === "truncation_marker");
    expect(markers).toHaveLength(1);
    // No entries after the marker.
    const markerIdx = trace.entries.findIndex(
      (e) => e.type === "truncation_marker"
    );
    expect(markerIdx).toBe(trace.entries.length - 1);
  });

  test("clearTrace resets buffer, counter, and cap accounting", async () => {
    process.env.AGENT_TRACE_MAX_BYTES = "700";

    const aibitat = makeAibitat({ withHistoryPlugin: false });
    aibitat._appendTraceEntry({ type: "llm_text", llmCall: 1, text: "big" });
    aibitat._appendTraceEntry({
      type: "tool_result",
      name: "t",
      content: "y".repeat(5000),
    });
    expect(aibitat.getTrace().truncated).toBe(true);

    aibitat.clearTrace();

    expect(aibitat.getTrace()).toEqual({
      entries: [],
      llmCalls: 0,
      truncated: false,
    });
    // Cap is lifted after clearing.
    aibitat._appendTraceEntry({ type: "llm_text", llmCall: 1, text: "fresh" });
    expect(aibitat.getTrace().truncated).toBe(false);
    expect(aibitat.getTrace().entries).toHaveLength(1);
  });

  test("clearTrace is idempotent and safe on a fresh instance", () => {
    const aibitat = makeAibitat({ withHistoryPlugin: false });
    expect(() => aibitat.clearTrace()).not.toThrow();
    expect(aibitat.getTrace().entries).toEqual([]);
  });
});

describe("Trace persistence at finalize (Step 5)", () => {
  beforeEach(() => resetMocks());
  afterEach(() => {
    delete process.env.AGENT_TRACE_MAX_BYTES;
    delete process.env.AGENT_TRACE_FLUSH_INTERVAL_MS;
  });

  test("finalize upserts response.trace with the full buffer on the same row (N2)", async () => {
    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => ({
        functionCall: { id: "call_1", name: "tool-a", arguments: "{}" },
        textResponse: "checking",
      }),
      () => ({ textResponse: "final", functionCall: null }),
    ];
    aibitat.function({ name: "tool-a", handler: async () => "result-1" });

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    expect(finalizeCalls()).toHaveLength(1);
    const [chatId, payload] = finalizeCalls()[0];
    expect(chatId).toBe(42);
    expect(payload.include).toBe(true);
    expect(payload.response.trace).toBeTruthy();
    expect(payload.response.trace.entries).toHaveLength(4);
    expect(payload.response.trace.llmCalls).toBe(2);
    expect(payload.response.trace.truncated).toBe(false);
    expect(payload.response.text).toBe("final");
  });

  test("_cleanup drains the trace buffer after persisting (Step 5.2)", async () => {
    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => ({ textResponse: "plain answer", functionCall: null }),
    ];

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    expect(aibitat.getTrace()).toEqual({
      entries: [],
      llmCalls: 0,
      truncated: false,
    });
  });

  test("trace serialization failure is fail-open: row saves with trace: null (N10)", async () => {
    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => ({ textResponse: "answer", functionCall: null }),
    ];
    aibitat.getTrace = () => {
      throw new Error("boom");
    };

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    expect(finalizeCalls()).toHaveLength(1);
    const [, payload] = finalizeCalls()[0];
    expect(payload.response.trace).toBeNull();
    expect(payload.response.text).toBe("answer");
  });
});

describe("Incremental trace flush (Step 2b — F11/AC16/AC19)", () => {
  beforeEach(() => resetMocks());
  beforeEach(() => {
    process.env.AGENT_TRACE_FLUSH_INTERVAL_MS = "0";
  });
  afterEach(() => {
    delete process.env.AGENT_TRACE_MAX_BYTES;
    delete process.env.AGENT_TRACE_FLUSH_INTERVAL_MS;
  });

  test("flush after a completed tool call merges trace into the row without touching include", async () => {
    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => ({
        functionCall: { id: "call_1", name: "tool-a", arguments: "{}" },
        textResponse: "",
      }),
      () => ({ textResponse: "final", functionCall: null }),
    ];
    aibitat.function({ name: "tool-a", handler: async () => "result-1" });

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });
    await drain(); // flushes are fire-and-forget — let them settle

    // Flush upserts carry no include key (N11: include stays untouched).
    const flushCalls = WorkspaceChats.upsert.mock.calls.filter(
      ([, payload]) => payload?.include === undefined
    );
    expect(flushCalls.length).toBeGreaterThanOrEqual(1);

    const [, flushPayload] = flushCalls[0];
    // Read-modify-write: placeholder keys are preserved (0.15).
    expect(flushPayload.response.somePlaceholderKey).toBe("keep-me");
    // At flush time (right after tool #1 completed): tool_call + tool_result
    // entries exist. The pre-tool llm_text was empty ("" textResponse on
    // tool-call turns), so 2 entries is the expected minimum.
    expect(flushPayload.response.trace.entries.length).toBeGreaterThanOrEqual(2);
  });

  test("flush failures are swallowed and the turn proceeds (AC19/N12)", async () => {
    WorkspaceChats.upsert.mockImplementationOnce(async () => {
      throw new Error("DB busy");
    });

    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => ({
        functionCall: { id: "call_1", name: "tool-a", arguments: "{}" },
        textResponse: "",
      }),
      () => ({ textResponse: "final", functionCall: null }),
    ];
    aibitat.function({ name: "tool-a", handler: async () => "result-1" });

    await expect(
      aibitat.start({ from: "USER", to: "agent", content: "hi" })
    ).resolves.toBeTruthy();
    await drain();

    // Turn finalized despite the flush error.
    expect(finalizeCalls()).toHaveLength(1);
    expect(finalizeCalls()[0][1].response.text).toBe("final");
  });

  test("flush is skipped once the run is aborted (row ownership — Step 6.3)", async () => {
    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => ({
        functionCall: { id: "call_1", name: "tool-a", arguments: "{}" },
        textResponse: "",
      }),
    ];
    aibitat.function({
      name: "tool-a",
      handler: async () => {
        aibitat.abort(); // abort mid-tool — the abort save owns the row now
        return "result-1";
      },
    });

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });
    await drain();

    // No flush upsert may fire after abort() — only the placeholder create.
    expect(WorkspaceChats.upsert).not.toHaveBeenCalled();
  });

  test("flush is skipped when trackedChatId has been cleared (post-cleanup)", async () => {
    const aibitat = makeAibitat();
    aibitat.clearTrackedChatId();

    await aibitat.flushTrace?.();

    expect(WorkspaceChats.upsert).not.toHaveBeenCalled();
    expect(WorkspaceChats.get).not.toHaveBeenCalled();
  });

  test("no flush payload ever flips include to true (N11)", async () => {
    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => ({
        functionCall: { id: "call_1", name: "tool-a", arguments: "{}" },
        textResponse: "",
      }),
      () => ({ textResponse: "final", functionCall: null }),
    ];
    aibitat.function({ name: "tool-a", handler: async () => "r" });

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });
    await drain();

    // Exactly one include:true write exists — the finalize. Every flush is
    // include-blind by contract.
    expect(finalizeCalls()).toHaveLength(1);
    expect(finalizeCalls()[0][1].response.text).toBe("final");
  });
});

// ---- Step 3b: stop reason plumbing (F12/AC17) ----

describe("Step 3b: stop reason persistence", () => {
  beforeEach(() => resetMocks());
  afterEach(() => {
    delete process.env.AGENT_TRACE_MAX_BYTES;
    delete process.env.AGENT_TRACE_FLUSH_INTERVAL_MS;
  });

  test("a completed turn persists stopReason: 'completed' (F12)", async () => {
    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => ({ textResponse: "all done", functionCall: null, uuid: "u" }),
    ];
    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    const finalizes = finalizeCalls();
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0][1].response.stopReason).toBe("completed");
  });

  test("a provider error persists stopReason: 'provider_error' with include:true and the trace-so-far (AC17)", async () => {
    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => {
        throw new Error("upstream 500");
      },
    ];
    aibitat.function({ name: "tool-a", handler: async () => "r" });

    await aibitat.start({ from: "USER", to: "agent", content: "hi" });
    await drain();

    // The error-path save is the only include:true write for this turn.
    const finalizes = finalizeCalls();
    expect(finalizes).toHaveLength(1);
    const response = finalizes[0][1].response;
    expect(response.stopReason).toBe("provider_error");
    expect(response.type).toBe("error");
    // 0.8: text must always be a string or the UI history skips the row.
    expect(typeof response.text).toBe("string");
    expect(response.text).toContain("upstream 500");
    expect(finalizes[0][1].include).toBe(true);
    expect(aibitat._finalized).toBe(true);
  });

  test("abort() records stopReason: 'user_abort' centrally (readable by the Step 6 abort save)", () => {
    const aibitat = makeAibitat({ withHistoryPlugin: false });
    aibitat.abort();
    expect(aibitat.stopReason).toBe("user_abort");
    expect(aibitat._aborted).toBe(true);
  });

  test("finalize after abort does NOT claim the row (abort path owns it — Step 6)", async () => {
    const aibitat = makeAibitat();
    aibitat._aborted = true; // simulate abort mid-turn
    aibitat.registerChatId(42);
    aibitat.newMessage({ from: "USER", to: "agent", content: "q" });
    aibitat.newMessage({ from: "agent", to: "USER", content: "partial" });

    // The finalize listener bails on _aborted (existing behavior).
    await drain();
    expect(finalizeCalls()).toHaveLength(0);
    // And it never claimed the row — the Step 6 abort save still can.
    expect(aibitat._finalized).toBe(false);
  });

  test("a turn with a pre-recorded error reason finalizes with that reason, not 'completed'", async () => {
    const aibitat = makeAibitat();
    FakeProvider._script = [
      () => ({ textResponse: "recovered", functionCall: null, uuid: "u" }),
    ];
    aibitat.setStopReason("provider_error"); // error occurred, turn recovered
    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    const finalizes = finalizeCalls();
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0][1].response.stopReason).toBe("provider_error");
  });

  test("setStopReason is first-writer-wins (an error reason survives a later non-error record attempt)", () => {
    const aibitat = makeAibitat({ withHistoryPlugin: false });
    aibitat.setStopReason("provider_error");
    aibitat.setStopReason("completed"); // ignored — first writer wins
    expect(aibitat.stopReason).toBe("provider_error");
  });
});
