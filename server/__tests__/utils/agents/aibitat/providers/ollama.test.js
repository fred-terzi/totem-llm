jest.mock("ollama", () => ({
  Ollama: jest.fn(),
}));

jest.mock("../../../../../utils/agents/aibitat/providers/ai-provider", () => {
  return class Provider {
    constructor() {
      this.deduplicator = { reset() {} };
    }

    providerLog() {}

    cleanMsgs(messages) {
      return messages;
    }
  };
});

jest.mock("../../../../../utils/agents/aibitat/providers/helpers/untooled", () => {
  return class UnTooled {};
});

jest.mock("../../../../../utils/AiProviders/ollama", () => ({
  OllamaAILLM: {
    promptWindowLimit: jest.fn(() => 4096),
    maxContextWindow: jest.fn(() => 8192),
    cacheContextWindows: jest.fn().mockResolvedValue(),
    applyOllamaFetch: jest.fn(() => jest.fn()),
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
});
