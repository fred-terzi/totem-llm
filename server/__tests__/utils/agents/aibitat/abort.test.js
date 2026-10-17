/**
 * Phase 2 tests: the agent loop respects the abort primitive from Phase 1.
 *
 * Covers:
 * - abort before start: no provider call, terminate fired
 * - abort while a tool is running: tool completes, but no further LLM rounds
 * - abort mid-run terminates (onTerminate listeners fire → socket/handler unwind)
 * - abort while feedback is pending (websocket plugin): resolves as bail, no continue()
 *
 * Note: reply() recreates the provider instance each round, so the fake
 * provider tracks ALL instances via a static registry.
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
      return {
        functionCall: { name: "sleep-tool", arguments: "{}" },
        textResponse: "",
        uuid: "u",
      };
    }
    async complete(messages, functions) {
      this.calls.push({ type: "complete", messages, functions });
      return {
        functionCall: { name: "sleep-tool", arguments: "{}" },
        textResponse: "",
      };
    }
  }
  return { OpenAIProvider: FakeProvider };
});

const AIbitat = require("../../../../utils/agents/aibitat/index.js");
const {
  websocket,
} = require("../../../../utils/agents/aibitat/plugins/websocket.js");

const FakeProvider =
  require("../../../../utils/agents/aibitat/providers").OpenAIProvider;

function totalProviderCalls() {
  return FakeProvider.instances.reduce(
    (n, p) => n + p.calls.length,
    0
  );
}

function makeAibitat({ handlerProps = {} } = {}) {
  const aibitat = new AIbitat({
    chats: [],
    maxRounds: 10,
    maxToolCalls: 10,
    provider: "openai",
    model: "gpt-4",
    handlerProps,
  });
  aibitat.agent("agent", { role: "You are a test agent." });
  return aibitat;
}

function fakeSocket() {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
    send() {},
    on() {},
    removeAllListeners() {},
    handleFeedback: null,
  };
}

describe("AIbitat abort loop guards (Phase 2)", () => {
  beforeEach(() => {
    FakeProvider.instances = [];
    FakeProvider._streams = true;
  });

  test("abort before start: no provider call and terminate is emitted", async () => {
    const aibitat = makeAibitat();

    let terminated = 0;
    aibitat.onTerminate(() => terminated++);

    aibitat.abort();
    await aibitat.start({ from: "USER", to: "agent", content: "hi" });

    expect(totalProviderCalls()).toBe(0);
    expect(terminated).toBeGreaterThanOrEqual(1);
  });

  test("abort while tool is running (streaming path): no further LLM round", async () => {
    const aibitat = makeAibitat();

    aibitat.function({
      name: "sleep-tool",
      handler: async () => {
        // abort fires "mid-tool"
        aibitat.abort();
        return "tool-done";
      },
    });

    await aibitat.start({
      from: "USER",
      to: "agent",
      content: "use the tool",
    });

    // exactly one LLM round — the recursion after the tool did NOT fire again
    expect(totalProviderCalls()).toBe(1);
    expect(aibitat._aborted).toBe(true);
  });

  test("abort after tool (synchronous path): no further LLM round", async () => {
    FakeProvider._streams = false;
    const aibitat = makeAibitat();

    aibitat.function({
      name: "sleep-tool",
      handler: async () => {
        aibitat.abort();
        return "sync-tool-done";
      },
    });

    await aibitat.start({
      from: "USER",
      to: "agent",
      content: "use the tool",
    });

    expect(totalProviderCalls()).toBe(1);
  });

  test("websocket plugin: abort while feedback pending resolves as bail (no continue)", async () => {
    const aibitat = makeAibitat({
      handlerProps: { log: () => {} },
    });
    const socket = fakeSocket();

    // attach the websocket plugin
    aibitat.use(
      websocket.plugin({ socket, muteUserReply: true, introspection: true })
    );

    let continued = 0;
    aibitat.continue = async () => {
      continued++;
    };

    // capture the registered interrupt listener and invoke it so
    // askForFeedback (socket.handleFeedback) is pending
    const interruptListener = aibitat.emitter.listeners("interrupt")[0];
    const handlerPromise = interruptListener({ from: "agent", to: "USER" });

    // the handler awaits askForFeedback → socket.handleFeedback is now set
    await new Promise((r) => setImmediate(r));
    expect(typeof socket.handleFeedback).toBe("function");

    // abort while waiting for feedback
    aibitat.abort();

    // wait for the async interrupt handler to settle
    await handlerPromise;

    // bail command → socket closed; continue() never called
    expect(socket.closed).toBe(true);
    expect(continued).toBe(0);
  });
});
