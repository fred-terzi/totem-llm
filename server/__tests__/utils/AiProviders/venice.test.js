const mockListModels = jest.fn();

jest.mock("openai", () => {
  const mockOpenAI = jest.fn().mockImplementation(() => ({
    models: { list: mockListModels },
  }));
  mockOpenAI.OpenAI = mockOpenAI;
  return mockOpenAI;
});

jest.mock("../../../utils/EmbeddingEngines/native", () => ({
  NativeEmbedder: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../../endpoints/utils", () => ({
  getAnythingLLMUserAgent: jest.fn(() => "test-agent"),
}));

jest.mock("../../../utils/agents/aibitat/providers/ai-provider", () =>
  class Provider {
    constructor() {
      this.deduplicator = { reset() {} };
    }

    providerLog() {}
  }
);

jest.mock("../../../utils/agents/aibitat/providers/helpers/untooled", () =>
  class UnTooled {}
);

const { VeniceLLM } = require("../../../utils/AiProviders/venice");
const VeniceProvider = require("../../../utils/agents/aibitat/providers/venice");

describe("VeniceLLM model metadata cache", () => {
  const originalApiKey = process.env.VENICE_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VENICE_API_KEY = "test-key";
    VeniceLLM.modelContextWindows = {};
    VeniceLLM.modelSpecs = {};
    VeniceLLM.modelContextCachePromise = null;
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  });

  it("shares an in-flight request and caches context and capability metadata", async () => {
    let resolveModels;
    mockListModels.mockReturnValue(
      new Promise((resolve) => {
        resolveModels = resolve;
      })
    );

    const initialLoad = VeniceLLM.cacheContextWindows(true);
    const concurrentLoad = VeniceLLM.cacheContextWindows();

    expect(mockListModels).toHaveBeenCalledTimes(1);
    resolveModels({
      data: [
        {
          id: "venice-test-model",
          context_length: 65536,
          model_spec: {
            availableContextTokens: 32768,
            capabilities: { supportsFunctionCalling: true },
          },
        },
      ],
    });

    await Promise.all([initialLoad, concurrentLoad]);

    expect(VeniceLLM.modelContextWindows["venice-test-model"]).toBe(32768);
    expect(
      VeniceLLM.modelSpecs["venice-test-model"].capabilities
        .supportsFunctionCalling
    ).toBe(true);
    expect(VeniceLLM.promptWindowLimit("venice-test-model")).toBe(32768);
  });

  it("waits for model metadata before deciding native tool support", async () => {
    let resolveModels;
    mockListModels.mockReturnValue(
      new Promise((resolve) => {
        resolveModels = resolve;
      })
    );
    const provider = new VeniceProvider({ model: "venice-test-model" });
    let resolved = false;
    const capabilityCheck = provider
      .supportsNativeToolCalling()
      .then((supportsTools) => {
        resolved = true;
        return supportsTools;
      });

    await Promise.resolve();
    expect(resolved).toBe(false);

    resolveModels({
      data: [
        {
          id: "venice-test-model",
          context_length: 65536,
          model_spec: {
            capabilities: { supportsFunctionCalling: false },
          },
        },
      ],
    });

    await expect(capabilityCheck).resolves.toBe(false);
    expect(mockListModels).toHaveBeenCalledTimes(1);
  });
});