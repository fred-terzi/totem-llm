jest.mock("ollama", () => ({
  Ollama: jest.fn(),
}));

jest.mock("../../../../utils/helpers/chat/LLMPerformanceMonitor", () => ({
  LLMPerformanceMonitor: {
    measureAsyncFunction: jest.fn(async (payload) => ({ output: await payload })),
    measureStream: jest.fn((payload) => payload.func),
  },
}));

jest.mock("../../../../utils/EmbeddingEngines/native", () => ({
  NativeEmbedder: jest.fn().mockImplementation(() => ({
    embedTextInput: jest.fn(),
    embedChunks: jest.fn(),
  })),
}));

jest.mock("../../../../utils/helpers/chat/responses", () => ({
  writeResponseChunk: jest.fn(),
  clientAbortedHandler: jest.fn(),
  formatChatHistory: jest.fn((history) => history),
}));

const { Ollama } = require("ollama");
const { OllamaAILLM } = require("../../../../utils/AiProviders/ollama");

describe("OllamaAILLM think level support", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OLLAMA_BASE_PATH = "http://127.0.0.1:11434";
    process.env.OLLAMA_MODEL_PREF = "llama3";
    process.env.OLLAMA_KEEP_ALIVE_TIMEOUT = "300";
    delete process.env.OLLAMA_THINK_LEVEL;
    jest.spyOn(OllamaAILLM, "cacheContextWindows").mockResolvedValue();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes the configured think level to the Ollama chat request", async () => {
    const chatMock = jest.fn().mockResolvedValue({
      message: { content: "ok", thinking: "" },
      prompt_eval_count: 3,
      eval_count: 2,
      eval_duration: 1000000,
    });
    Ollama.mockImplementation(() => ({ chat: chatMock }));

    process.env.OLLAMA_THINK_LEVEL = "off";

    const provider = new OllamaAILLM();
    await provider.getChatCompletion([{ role: "user", content: "hello" }], {
      temperature: 0.2,
    });

    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "llama3",
        think: false,
      })
    );
  });
});
