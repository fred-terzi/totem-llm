jest.mock("ollama", () => ({
  Ollama: jest.fn(),
}));

jest.mock("../../../../../utils/agents/aibitat/providers/ai-provider", () => {
  return class Provider {
    constructor() {
      this.deduplicator = { reset() {} };
    }

    providerLog() {}

    resetUsage() {}

    recordUsage() {}

    cleanMsgs(messages) {
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
      return jest.fn();
    }

    async getModelCapabilities() {
      return { tools: true };
    }
  },
}));

const { Ollama } = require("ollama");
const OllamaProvider = require("../../../../../utils/agents/aibitat/providers/ollama");

describe("OllamaProvider think level support", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OLLAMA_BASE_PATH = "http://127.0.0.1:11434";
    delete process.env.OLLAMA_THINK_LEVEL;
  });

  it("adds think false to agent requests when off is selected", async () => {
    const chatMock = jest.fn().mockResolvedValue({
      message: { content: "ok" },
    });
    Ollama.mockImplementation(() => ({ chat: chatMock }));

    process.env.OLLAMA_THINK_LEVEL = "off";
    const provider = new OllamaProvider({ model: "demo-model" });

    await provider.complete([{ role: "user", content: "hi" }]);

    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "demo-model",
        think: false,
      })
    );
  });

  it("adds a synthetic user turn when native tool requests have no user message", async () => {
    const chatMock = jest.fn().mockResolvedValue(
      (async function* () {})()
    );
    Ollama.mockImplementation(() => ({ chat: chatMock }));

    const provider = new OllamaProvider({ model: "demo-model" });
    await provider.stream([], [
      {
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
      },
    ]);

    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "Continue." }],
      })
    );
  });
});
