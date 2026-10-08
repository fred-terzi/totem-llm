const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const {
  handleDefaultStreamResponseV2,
} = require("../../helpers/chat/responses");
const { toValidNumber } = require("../../http");
const { getAnythingLLMUserAgent } = require("../../../endpoints/utils");

/**
 * Venice AI LLM Provider
 *
 * Venice (https://venice.ai) is a hosted, OpenAI-compatible inference API.
 * - Base URL: https://api.venice.ai/api/v1 (do NOT include the `/chat/completions` path —
 *   the OpenAI SDK appends it).
 * - Auth: `Authorization: Bearer <VENICE_API_KEY>`.
 * - Models: use Venice's model slug (e.g. `zai-org-glm-5-1`, `kimi-k2-6`).
 *
 * The wire format is OpenAI-compatible, so we use the `openai` SDK directly.
 * This class intentionally does NOT implement vision/attachments — most Venice
 * text models do not support it, and the agent path (Slice B) is where
 * multimodal inputs would land if needed.
 *
 * Native tool calling is handled by the Aibitat agent provider in Slice B
 * (`server/utils/agents/aibitat/providers/venice.js`), which extends `Provider`
 * and forces the native path. This class is chat + streaming only.
 *
 * Context windows: Venice's `/models` endpoint reports `context_length` (and
 * `model_spec.availableContextTokens`) for every model. We cache these on first
 * construction (same pattern as the Ollama/Cerebras providers) so the message
 * compressor budgets against the real window of the selected model instead of a
 * hardcoded 8k.
 */
class VeniceLLM {
  static DEFAULT_BASE_URL = "https://api.venice.ai/api/v1";
  static DEFAULT_MODEL = "zai-org-glm-5-1";

  /** @see VeniceLLM.cacheContextWindows */
  static modelContextWindows = {};
  /** @see VeniceLLM.cacheContextWindows */
  static modelSpecs = {};
  static modelContextCachePromise = null;

  constructor(embedder = null, modelPreference = null) {
    const { OpenAI: OpenAIApi } = require("openai");
    if (!process.env.VENICE_API_KEY)
      throw new Error("No Venice API key was set.");

    this.className = "VeniceLLM";
    this.basePath = process.env.VENICE_BASE_PATH || VeniceLLM.DEFAULT_BASE_URL;

    this.openai = new OpenAIApi({
      baseURL: this.basePath,
      apiKey: process.env.VENICE_API_KEY,
      defaultHeaders: {
        "User-Agent": getAnythingLLMUserAgent(),
      },
    });

    this.model =
      modelPreference ||
      process.env.VENICE_MODEL_PREF ||
      VeniceLLM.DEFAULT_MODEL;

    this.maxTokens = process.env.VENICE_MAX_TOKENS
      ? toValidNumber(process.env.VENICE_MAX_TOKENS, 1024)
      : 1024;

    // Lazy load the limits to avoid blocking the main thread on cacheContextWindows
    this.limits = null;

    VeniceLLM.cacheContextWindows();

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;

    this.#log(`Initialized Venice: model=${this.model} base=${this.basePath}`);
  }

  #log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
  }

  static #slog(text, ...args) {
    console.log(`\x1b[36m[VeniceLLM]\x1b[0m ${text}`, ...args);
  }

  async assertModelContextLimits() {
    if (this.limits !== null) return;
    await VeniceLLM.cacheContextWindows();
    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };
    this.#log(
      `model ${this.model} is using a max context window of ${this.promptWindowLimit()}/${VeniceLLM.maxContextWindow(this.model)} tokens.`
    );
  }

  /**
   * Cache the context windows for the Venice models.
   * This is done once and then cached for the lifetime of the server. This is
   * absolutely necessary to ensure that the context windows are correct.
   *
   * Venice exposes both a top-level `context_length` and
   * `model_spec.availableContextTokens` for every model on `GET /models` - we
   * prefer `availableContextTokens` and fall back to `context_length`.
   * @param {boolean} force - Force the cache to be refreshed.
   * @returns {Promise<void>} - A promise that resolves when the cache is refreshed.
   */
  static async cacheContextWindows(force = false) {
    if (VeniceLLM.modelContextCachePromise)
      return VeniceLLM.modelContextCachePromise;
    if (Object.keys(VeniceLLM.modelContextWindows).length > 0 && !force) return;
    if (!process.env.VENICE_API_KEY)
      return VeniceLLM.#slog(
        `No VENICE_API_KEY set - skipping context window cache.`
      );

    const cachePromise = (async () => {
      try {
        const { OpenAI: OpenAIApi } = require("openai");
        const venice = new OpenAIApi({
          baseURL: process.env.VENICE_BASE_PATH || VeniceLLM.DEFAULT_BASE_URL,
          apiKey: process.env.VENICE_API_KEY,
          defaultHeaders: {
            "User-Agent": getAnythingLLMUserAgent(),
          },
        });

        const { data: models } = await venice.models.list();
        if (!models?.length) return;

        const modelContextWindows = {};
        const modelSpecs = {};
        models.forEach((model) => {
          const contextWindow = Number(
            model?.model_spec?.availableContextTokens ?? model?.context_length
          );
          if (!contextWindow || isNaN(contextWindow) || contextWindow <= 0)
            return;
          modelContextWindows[model.id] = contextWindow;
          if (model?.model_spec) modelSpecs[model.id] = model.model_spec;
        });

        VeniceLLM.modelContextWindows = modelContextWindows;
        VeniceLLM.modelSpecs = modelSpecs;
        VeniceLLM.#slog(`Context windows cached for all models!`);
      } catch (e) {
        VeniceLLM.#slog(`Error caching context windows`, e.message);
      }
    })();

    VeniceLLM.modelContextCachePromise = cachePromise;
    try {
      await cachePromise;
    } finally {
      if (VeniceLLM.modelContextCachePromise === cachePromise)
        VeniceLLM.modelContextCachePromise = null;
    }
  }

  #appendContext(contextTexts = []) {
    if (!contextTexts || !contextTexts.length) return "";
    return (
      "\nContext:\n" +
      contextTexts
        .map((text, i) => {
          return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
        })
        .join("")
    );
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(modelName) {
    if (Object.keys(VeniceLLM.modelContextWindows).length === 0) {
      VeniceLLM.#slog(
        "No context windows cached - Context window may be inaccurately reported."
      );
      return Number(process.env.VENICE_MODEL_TOKEN_LIMIT) || 8192;
    }

    let userDefinedLimit = null;
    const systemDefinedLimit = VeniceLLM.maxContextWindow(modelName);

    if (
      process.env.VENICE_MODEL_TOKEN_LIMIT &&
      !isNaN(Number(process.env.VENICE_MODEL_TOKEN_LIMIT)) &&
      Number(process.env.VENICE_MODEL_TOKEN_LIMIT) > 0
    )
      userDefinedLimit = Number(process.env.VENICE_MODEL_TOKEN_LIMIT);

    // The user defined limit is always higher priority than the context window limit, but it cannot be higher than the context window limit
    // so we return the minimum of the two, if there is no user defined limit, we return the system defined limit as-is.
    if (userDefinedLimit !== null)
      return Math.min(userDefinedLimit, systemDefinedLimit);

    // Unlike Ollama (local runtimes that silently truncate prompts beyond their
    // allocated num_ctx, hence its 16,384 safety cap), Venice is a hosted API
    // that honors the context window reported by /models and returns an
    // explicit 400 on overflow. Report the model's real window as-is.
    return systemDefinedLimit;
  }

  promptWindowLimit() {
    return this.constructor.promptWindowLimit(this.model);
  }

  static maxContextWindow(modelName = null) {
    if (Object.keys(VeniceLLM.modelContextWindows).length === 0 || !modelName)
      return 8192;
    // Unknown model slug (typo'd or newer than the cache) → conservative 8192,
    // matching the cold-cache fallback above.
    return Number(VeniceLLM.modelContextWindows[modelName]) || 8192;
  }

  // Venice is OpenAI-compatible at the wire level. Any model slug the account
  // has access to is valid; the model list is surfaced via `getVeniceModels`
  // in `server/utils/helpers/customModels.js`.
  async isValidChatCompletionModel(modelName = "") {
    return !!modelName;
  }

  /**
   * Venice text models do not uniformly support image attachments; we treat
   * attachments as unsupported in this class. If a future model needs vision,
   * add the content-array generation here (OpenAI-style `image_url` parts).
   * @param {{userPrompt:string, attachments: import("../../helpers").Attachment[]}} _props
   * @returns {string}
   */
  #generateContent({ userPrompt, attachments: _attachments = [] }) {
    return userPrompt;
  }

  /**
   * Construct the user prompt for this model.
   * @param {{attachments: import("../../helpers").Attachment[]}} param0
   * @returns
   */
  constructPrompt({
    systemPrompt = "",
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [],
  }) {
    const prompt = {
      role: "system",
      content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
    };
    return [
      prompt,
      ...chatHistory,
      {
        role: "user",
        content: this.#generateContent({ userPrompt, attachments }),
      },
    ];
  }

  /**
   * Parses and prepends reasoning from the response if the model is a
   * reasoning model (e.g. Kimi K2.6, GLM 5.1) that returns a separate
   * `reasoning_content` field on the assistant message.
   * @param {Object} response - a `choices[0]` entry from the Venice response.
   * @returns {string}
   */
  #parseReasoningFromResponse({ message }) {
    let textResponse = message?.content ?? "";
    if (
      !!message?.reasoning_content &&
      message.reasoning_content.trim().length > 0
    )
      textResponse = `<think>${message.reasoning_content}</think>${textResponse}`;
    return textResponse;
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    const result = await LLMPerformanceMonitor.measureAsyncFunction(
      this.openai.chat.completions
        .create({
          model: this.model,
          messages,
          temperature,
          max_tokens: this.maxTokens,
        })
        .catch((e) => {
          throw new Error(e.message);
        })
    );

    if (
      !result.output.hasOwnProperty("choices") ||
      result.output.choices.length === 0
    )
      return null;

    const usage = {
      prompt_tokens: result.output.usage?.prompt_tokens || 0,
      completion_tokens: result.output.usage?.completion_tokens || 0,
      total_tokens: result.output.usage?.total_tokens || 0,
      duration: result.duration,
    };

    return {
      textResponse: this.#parseReasoningFromResponse(result.output.choices[0]),
      metrics: {
        ...usage,
        outputTps:
          usage.duration > 0 ? usage.completion_tokens / usage.duration : 0,
        model: this.model,
        provider: this.className,
        timestamp: new Date(),
      },
    };
  }

  async streamGetChatCompletion(messages = null, { temperature = 0.7 }) {
    const measuredStreamRequest = await LLMPerformanceMonitor.measureStream({
      func: this.openai.chat.completions.create({
        model: this.model,
        stream: true,
        messages,
        temperature,
        max_tokens: this.maxTokens,
      }),
      messages,
      runPromptTokenCalculation: true,
      modelTag: this.model,
      provider: this.className,
    });
    return measuredStreamRequest;
  }

  handleStream(response, stream, responseProps) {
    return handleDefaultStreamResponseV2(response, stream, responseProps);
  }

  /**
   * Returns the capabilities of the model. Venice models advertise native
   * tool calling on the wire (OpenAI `tools` shape), so we surface that
   * capability so the agent path can trust it. Reasoning is model-specific
   * (Kimi K2.6, GLM 5.1, Claude Opus 4.7, GPT-5.4 Pro, …) — we mark it as
   * `true` optimistically since Venice's reasoning models are a known set
   * and the response shape is OpenAI-compatible. Vision / image generation
   * are not supported by this class.
   * @returns {{tools: boolean, reasoning: boolean, imageGeneration: boolean, vision: boolean}}
   */
  getModelCapabilities() {
    const spec = VeniceLLM.modelSpecs[this.model];
    if (!spec?.capabilities) {
      // Cache is cold (or the model vanished from /models) - keep the old
      // optimistic defaults rather than disabling tool calling outright.
      return {
        tools: true,
        reasoning: true,
        imageGeneration: false,
        vision: false,
      };
    }
    const capabilities = spec.capabilities;
    return {
      tools: capabilities.supportsFunctionCalling === true,
      reasoning: capabilities.supportsReasoning === true,
      imageGeneration: false, // text-model endpoint; image gen is a separate API surface
      vision: capabilities.supportsVision === true,
    };
  }

  // Simple wrapper for dynamic embedder & normalize interface for all LLM implementations
  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    await this.assertModelContextLimits();
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = {
  VeniceLLM,
};
