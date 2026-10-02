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
 */
class VeniceLLM {
  static DEFAULT_BASE_URL = "https://api.venice.ai/api/v1";
  static DEFAULT_MODEL = "zai-org-glm-5-1";

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

    // Venice models vary widely in context window; default to a conservative 8k.
    // Override with VENICE_MODEL_TOKEN_LIMIT if you know the model's real window.
    this.promptWindow = Number(process.env.VENICE_MODEL_TOKEN_LIMIT) || 8192;

    this.limits = {
      history: this.promptWindow * 0.15,
      system: this.promptWindow * 0.15,
      user: this.promptWindow * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;

    this.#log(`Initialized Venice: model=${this.model} base=${this.basePath}`);
  }

  #log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
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

  static promptWindowLimit(_modelName) {
    // Venice does not expose a single public context-window endpoint for all
    // models; we rely on the ENV override or a conservative default.
    return Number(process.env.VENICE_MODEL_TOKEN_LIMIT) || 8192;
  }

  promptWindowLimit() {
    return this.constructor.promptWindowLimit(this.model);
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
    return {
      tools: true,
      reasoning: true,
      imageGeneration: false,
      vision: false,
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
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = {
  VeniceLLM,
};
