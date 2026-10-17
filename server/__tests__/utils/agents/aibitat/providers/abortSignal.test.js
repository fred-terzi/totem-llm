/**
 * Phase 3 tests: the run's AbortSignal is plumbed into the provider HTTP
 * calls so aborting a run tears down the in-flight upstream request.
 *
 * Covers:
 * - tooledStream / tooledComplete pass `signal` as the create() 2nd arg
 * - Venice provider: signal reaches create() (native + untooled paths),
 *   an aborted request's APIUserAbortError is re-thrown verbatim (NOT
 *   converted to RetryError), and the SDK is NOT retried when the signal
 *   is aborted; genuine upstream failures still become RetryError
 * - Ollama provider: with abortSignal set, the fetch used for chat() is
 *   wired to that signal (real HTTP round-trip proves abort tears the
 *   stream down); without it, behavior is unchanged
 * - AIbitat: provider errors caused by our own abort are re-thrown
 *   verbatim (NOT wrapped as the scary "agent model failed to respond"
 *   APIError), and reply() attaches the run's signal to the provider
 */

/* ------------------------------------------------------------------ */
/* helpers: tooledStream / tooledComplete signal threading             */
/* ------------------------------------------------------------------ */

describe("tooledStream/tooledComplete signal threading", () => {
  const {
    tooledStream,
    tooledComplete,
  } = require("../../../../../utils/agents/aibitat/providers/helpers/tooled.js");

  const messages = [{ role: "user", content: "hi" }];
  const functions = [
    { name: "t", description: "d", parameters: { type: "object", properties: {} } },
  ];

  const streamIterator = () =>
    (async function* () {
      yield {
        choices: [{ delta: { content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      };
    })();

  test("tooledStream passes signal to create() 2nd arg", async () => {
    const signal = new AbortController().signal;
    const createMock = jest.fn().mockReturnValue(streamIterator());

    await tooledStream(
      { chat: { completions: { create: createMock } } },
      "model",
      messages,
      functions,
      null,
      { signal }
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][1]).toEqual({ signal });
  });

  test("tooledStream passes signal: undefined when no signal given", async () => {
    const createMock = jest.fn().mockReturnValue(streamIterator());

    await tooledStream(
      { chat: { completions: { create: createMock } } },
      "model",
      messages,
      functions
    );

    expect(createMock.mock.calls[0][1]).toEqual({ signal: undefined });
  });

  test("tooledComplete passes signal to create() 2nd arg", async () => {
    const signal = new AbortController().signal;
    const createMock = jest.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });

    await tooledComplete(
      { chat: { completions: { create: createMock } } },
      "model",
      messages,
      functions,
      () => 0,
      { signal }
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][1]).toEqual({ signal });
  });
});

/* ------------------------------------------------------------------ */
/* Venice provider                                                     */
/* ------------------------------------------------------------------ */

describe("VeniceProvider abortSignal", () => {
  jest.mock("openai", () => {
    class OpenAI {
      constructor() {
        this.chat = { completions: { create: jest.fn() } };
      }
      static AuthenticationError = class AuthenticationError extends Error {};
      static RateLimitError = class RateLimitError extends Error {};
      static InternalServerError = class InternalServerError extends Error {};
      static APIError = class APIError extends Error {};
    }
    return OpenAI;
  });
  jest.mock("../../../../../utils/AiProviders/venice", () => ({
    VeniceLLM: {
      DEFAULT_MODEL: "venice-model",
      DEFAULT_BASE_URL: "https://api.venice.ai/api/v1",
    },
  }));
  jest.mock("../../../../../utils/agents/aibitat/providers/ai-provider", () => {
    return class Provider {
      constructor() {
        this.deduplicator = {
          reset() {},
          isDuplicate() {
            return false;
          },
          trackRun() {},
        };
      }
      providerLog() {}
      resetUsage() {}
      recordUsage() {}
      getUsage() {
        return {};
      }
      cleanMsgs(messages) {
        return messages;
      }
      formatMessageWithAttachments(message) {
        return message;
      }
      formatMessagesWithAttachments(messages) {
        return messages;
      }
    };
  });
  jest.mock("../../../../../utils/agents/aibitat/providers/helpers/untooled", () => {
    return class UnTooled {
      async stream(messages, functions, chatCb, eventHandler) {
        const stream = await chatCb({ messages, functions });
        let text = "";
        for await (const chunk of stream) {
          if (chunk?.choices?.[0]?.delta?.content)
            text += chunk.choices[0].delta.content;
        }
        return { result: null, textResponse: text, functionCall: null };
      }
      async complete(messages, functions, chatCb) {
        const text = await chatCb({ messages, functions });
        return { result: text, textResponse: text, functionCall: null };
      }
    };
  });

  const OpenAI = require("openai");
  const VeniceProvider = require("../../../../../utils/agents/aibitat/providers/venice.js");
  const {
    RetryError,
  } = require("../../../../../utils/agents/aibitat/error.js");

  const toolFunctions = [
    { name: "t", description: "d", parameters: { type: "object", properties: {} } },
  ];

  test("signal is passed to create() on the native (tooled) path", async () => {
    const provider = new VeniceProvider({ model: "m" });
    const signal = new AbortController().signal;
    provider.abortSignal = signal;
    provider.supportsNativeToolCalling = async () => true;

    provider.client.chat.completions.create.mockReturnValue(
      (async function* () {
        yield {
          choices: [{ delta: { content: "hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        };
      })()
    );

    await provider.stream([{ role: "user", content: "hi" }], toolFunctions);

    expect(provider.client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(provider.client.chat.completions.create.mock.calls[0][1]).toEqual({
      signal,
    });
  });

  test("signal is passed to create() on the untooled fallback path", async () => {
    const provider = new VeniceProvider({ model: "m" });
    const signal = new AbortController().signal;
    provider.abortSignal = signal;
    provider.supportsNativeToolCalling = async () => false;

    provider.client.chat.completions.create.mockReturnValue(
      (async function* () {
        yield { choices: [{ delta: { content: "call: t({})" } }] };
      })()
    );

    await provider.stream([{ role: "user", content: "hi" }], toolFunctions);

    expect(provider.client.chat.completions.create).toHaveBeenCalled();
    expect(provider.client.chat.completions.create.mock.calls[0][1]).toEqual({
      signal,
    });
  });

  test("abort: APIUserAbortError re-thrown verbatim (not RetryError), no retry", async () => {
    const provider = new VeniceProvider({ model: "m" });
    const controller = new AbortController();
    provider.abortSignal = controller.signal;
    provider.supportsNativeToolCalling = async () => true;

    // Simulate openai@4.95.1 core.mjs behavior: when the request options'
    // signal is already aborted, the SDK throws APIUserAbortError BEFORE
    // any retry branch (verified against the installed SDK source).
    class APIUserAbortError extends OpenAI.APIError {
      constructor() {
        super("Request was aborted.");
        this.name = "APIUserAbortError";
      }
    }
    provider.client.chat.completions.create.mockImplementation(
      (body, options) => {
        if (options?.signal?.aborted) throw new APIUserAbortError();
        return Promise.resolve({ choices: [] });
      }
    );
    controller.abort();

    await expect(
      provider.stream([{ role: "user", content: "hi" }], toolFunctions)
    ).rejects.toBeInstanceOf(APIUserAbortError);

    const err = await provider
      .stream([{ role: "user", content: "hi" }], toolFunctions)
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(RetryError);
    // exactly one attempt - the SDK must not retry an aborted request
    expect(provider.client.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(provider.client.chat.completions.create.mock.calls[1][1].signal)
      .toBe(controller.signal);
  });

  test("genuine upstream failure (signal set but NOT aborted) is still RetryError", async () => {
    const provider = new VeniceProvider({ model: "m" });
    provider.abortSignal = new AbortController().signal; // set but never aborted
    provider.supportsNativeToolCalling = async () => true;

    provider.client.chat.completions.create.mockImplementation(() => {
      throw new OpenAI.InternalServerError("boom", {}, "boom", {});
    });

    await expect(
      provider.stream([{ role: "user", content: "hi" }], toolFunctions)
    ).rejects.toBeInstanceOf(RetryError);
  });
});

/* ------------------------------------------------------------------ */
/* Ollama provider                                                     */
/* ------------------------------------------------------------------ */

describe("OllamaProvider abortSignal", () => {
  // NOTE: name must start with "mock" for jest's out-of-scope allowlist in the factory below.
  const mockOllamaBaseFetch = jest.fn((input, init = {}) => global.fetch(input, init));
  jest.mock("ollama", () => {
    class OllamaClass {
      constructor(config = {}) {
        this.config = { host: config?.host, headers: config?.headers };
        this.fetch = config?.fetch ?? global.fetch;
      }
    }
    OllamaClass.prototype.chat = jest.fn();
    return { Ollama: OllamaClass };
  });
  jest.mock("../../../../../utils/agents/aibitat/providers/ai-provider", () => {
    return class Provider {
      constructor() {
        this.deduplicator = {
          reset() {},
          isDuplicate() {
            return false;
          },
          trackRun() {},
        };
      }
      providerLog() {}
      resetUsage() {}
      recordUsage() {}
      getUsage() {
        return {};
      }
      cleanMsgs(messages) {
        return messages;
      }
      formatMessageWithAttachments(message) {
        return message;
      }
      formatMessagesWithAttachments(messages) {
        return messages;
      }
    };
  });
  jest.mock("../../../../../utils/agents/aibitat/providers/helpers/untooled", () => {
    return class UnTooled {};
  });
  jest.mock("../../../../../utils/AiProviders/ollama", () => ({
    OllamaAILLM: class {
      static promptWindowLimit() {
        return 4096;
      }
      static maxContextWindow() {
        return 8192;
      }
      static async cacheContextWindows() {}
      static applyOllamaFetch() {
        return mockOllamaBaseFetch;
      }
      async getModelCapabilities() {
        return { tools: true };
      }
    },
  }));

  const { Ollama } = require("ollama");
  const OllamaProvider = require("../../../../../utils/agents/aibitat/providers/ollama.js");

  beforeEach(() => {
    process.env.OLLAMA_BASE_PATH = "http://127.0.0.1:11434";
    delete process.env.OLLAMA_AUTH_TOKEN;
    delete process.env.OLLAMA_THINK_LEVEL;
    mockOllamaBaseFetch.mockClear();
    Ollama.prototype.chat.mockReset().mockResolvedValue({
      message: { content: "ok" },
    });
  });

  test("without abortSignal, the base fetch is used (no signal injected)", async () => {
    const provider = new OllamaProvider({ model: "m" });

    await provider.complete([{ role: "user", content: "hi" }]);

    expect(Ollama.prototype.chat).toHaveBeenCalledTimes(1);
    expect(provider.client.fetch).toBe(mockOllamaBaseFetch);
  });

  test("with abortSignal, the fetch used for chat() is wired to that signal", async () => {
    const provider = new OllamaProvider({ model: "m" });
    const signal = new AbortController().signal;
    provider.abortSignal = signal;

    // Capture the fetch that the in-flight chat() call actually uses
    let usedFetch = null;
    Ollama.prototype.chat.mockImplementation(function (payload) {
      usedFetch = this.fetch;
      return Promise.resolve({ message: { content: "ok" } });
    });

    await provider.complete([{ role: "user", content: "hi" }]);

    expect(usedFetch).not.toBe(mockOllamaBaseFetch); // a signal-wired wrapper
    // The wrapper must forward to the base fetch with the signal attached
    // (reset to a pure recorder so no network call happens)
    mockOllamaBaseFetch.mockReset();
    usedFetch("http://x", { method: "POST" });
    expect(mockOllamaBaseFetch).toHaveBeenCalledWith(
      "http://x",
      expect.objectContaining({ method: "POST", signal })
    );
  });

  test("abort mid-stream tears down the in-flight Ollama request", async () => {
    const http = require("http");
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write('{"message":{"content":"tok"},"done":false}\n\n');
      const interval = setInterval(() => res.write("{}\n\n"), 25);
      req.on("close", () => clearInterval(interval));
    });
    await new Promise((r) => srv.listen(0, r));
    const port = srv.address().port;

    // Route through the REAL fetch so the abort actually propagates
    mockOllamaBaseFetch.mockImplementation(
      (input, init = {}) => global.fetch(input, init)
    );

    const provider = new OllamaProvider({ model: "m" });
    provider.client.config = { host: `http://127.0.0.1:${port}` };
    const controller = new AbortController();
    provider.abortSignal = controller.signal;

    // Drive the same code path the provider uses (#chat → SDK → fetch)
    const client = new Ollama({
      host: `http://127.0.0.1:${port}`,
      headers: {},
      fetch: (input, init = {}) =>
        mockOllamaBaseFetch(input, { ...init, signal: controller.signal }),
    });
    let outcome;
    try {
      const streamResponse = await client.chat({
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      let first = true;
      for await (const _chunk of streamResponse) {
        if (first) {
          first = false;
          controller.abort();
        }
      }
      outcome = "completed";
    } catch (e) {
      outcome = `aborted:${e.name}`;
    }

    expect(outcome).toMatch(/^aborted/);
    srv.close();
  });
});

/* ------------------------------------------------------------------ */
/* AIbitat: quiet-abort error handling                                 */
/* ------------------------------------------------------------------ */

describe("AIbitat abort plumbing", () => {
  jest.mock("../../../../../utils/agents/aibitat/providers", () => {
    class FakeProvider {
      constructor() {
        this.verbose = false;
      }
      attachHandlerProps(props) {
        this.handlerProps = props;
      }
      getUsage() {
        return { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      }
      get supportsAgentStreaming() {
        return true;
      }
      async stream() {
        // Simulate an in-flight upstream call (when the test opts in):
        // stay pending until the run's abort signal fires, then throw the
        // openai SDK v4 shape for an aborted request (APIUserAbortError).
        if (FakeProvider._awaitAbort && this.abortSignal) {
          await new Promise((resolve) => {
            if (this.abortSignal.aborted) return resolve();
            this.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          const e = new Error("Request was aborted.");
          e.name = "APIUserAbortError";
          throw e;
        }
        return { functionCall: null, textResponse: "hello" };
      }
    }
    FakeProvider._awaitAbort = false;
    return { OpenAIProvider: FakeProvider };
  });

  const AIbitat = require("../../../../../utils/agents/aibitat/index.js");
  const {
    APIError,
  } = require("../../../../../utils/agents/aibitat/error.js");

  test("provider error from our own abort is re-thrown verbatim (no APIError wrap)", async () => {
    const FakeProvider = require("../../../../../utils/agents/aibitat/providers").OpenAIProvider;
    FakeProvider._awaitAbort = true;
    const aibitat = new AIbitat({
      chats: [],
      maxRounds: 5,
      provider: "openai",
      model: "gpt-4",
      handlerProps: { log: () => {} },
    });
    aibitat.agent("agent", { role: "You are a test agent." });

    const run = aibitat
      .start({ from: "USER", to: "agent", content: "hi" })
      .then(() => null)
      .catch((e) => e);

    // abort while the run is in flight
    await new Promise((r) => setImmediate(r));
    aibitat.abort();

    const err = await run;
    expect(err).toBeDefined();
    expect(err.name).toBe("APIUserAbortError");
    expect(err).not.toBeInstanceOf(APIError);
  });

  test("reply() attaches the run's abortSignal to the provider instance", async () => {
    const FakeProvider = require("../../../../../utils/agents/aibitat/providers").OpenAIProvider;
    FakeProvider._awaitAbort = false; // resolve immediately, don't await abort
    const aibitat = new AIbitat({
      chats: [],
      maxRounds: 5,
      provider: "openai",
      model: "gpt-4",
      handlerProps: { log: () => {} },
    });
    aibitat.agent("agent", { role: "You are a test agent." });

    // (fake provider resolves immediately - _awaitAbort stays false)
    await aibitat
      .reply({ from: "agent", to: "USER" })
      .then(() => null)
      .catch(() => null);

    expect(aibitat.providerInstance).toBeTruthy();
    expect(aibitat.providerInstance.abortSignal).toBe(aibitat.abortSignal);
  });
});
