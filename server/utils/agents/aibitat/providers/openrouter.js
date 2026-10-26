const OpenAI = require("openai");
const Provider = require("./ai-provider.js");
const InheritMultiple = require("./helpers/classes.js");
const UnTooled = require("./helpers/untooled.js");
const { tooledStream, tooledComplete } = require("./helpers/tooled.js");
const { RetryError } = require("../error.js");
const { freeOptionRateLimitError } = require("../../../freeModelRateLimit");

/**
 * The agent provider for the OpenRouter provider.
 * Supports true OpenAI-compatible tool calling when enabled via ENV,
 * falling back to the UnTooled prompt-based approach otherwise.
 * @extends {Provider}
 * @extends {UnTooled}
 */
class OpenRouterProvider extends InheritMultiple([Provider, UnTooled]) {
  model;

  constructor(config = {}) {
    const { model = "openrouter/auto" } = config;
    super();
    const client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      maxRetries: 3,
      defaultHeaders: {
        "HTTP-Referer": "https://beta.totemai.xyz/",
        "X-Title": "Totem",
      },
    });

    this._client = client;
    this.model = model;
    this.verbose = true;
    this._supportsToolCalling = null;
  }

  get client() {
    return this._client;
  }

  get supportsAgentStreaming() {
    return true;
  }

  /**
   * Step 4 (F5, agent-full-context-trace): OpenRouter models vary in both
   * tool calling AND reasoning support, and the native
   * `supportsNativeToolCallingViaEnv` gate only covers tools. Assistant
   * reasoning history (`reasoning_content` replay) is therefore OFF by
   * default — many upstream models 400 on unknown assistant fields.
   * Operators can enable it per-deployment via
   * `PROVIDER_SUPPORTS_REASONING_HISTORY=openrouter` (mirrors the
   * native-tool-calling env gate).
   * @returns {boolean}
   */
  get supportsReasoningHistory() {
    return this.supportsReasoningHistoryViaEnv("openrouter");
  }

  /**
   * Whether this provider supports native OpenAI-compatible tool calling.
   * - Since OpenRouter models vary in tool calling support, we check the ENV.
   * - If the ENV is not set, we default to false.
   * @returns {boolean}
   */
  supportsNativeToolCalling() {
    if (this._supportsToolCalling !== null) return this._supportsToolCalling;
    const supportsToolCalling =
      this.supportsNativeToolCallingViaEnv("openrouter");
    if (supportsToolCalling)
      this.providerLog(
        "OpenRouter supports native tool calling is ENABLED via ENV."
      );
    else
      this.providerLog(
        "OpenRouter supports native tool calling is DISABLED via ENV. Will use UnTooled instead."
      );
    this._supportsToolCalling = supportsToolCalling;
    return supportsToolCalling;
  }

  async #handleFunctionCallChat({ messages = [] }) {
    return await this.client.chat.completions
      .create({
        model: this.model,
        messages,
        user: this.executingUserId,
      })
      .then((result) => {
        if (!result.hasOwnProperty("choices"))
          throw new Error("OpenRouter chat: No results!");
        if (result.choices.length === 0)
          throw new Error("OpenRouter chat: No results length!");
        return result.choices[0].message.content;
      })
      .catch((_) => {
        return null;
      });
  }

  async #handleFunctionCallStream({ messages = [] }) {
    return await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      messages,
      user: this.executingUserId,
    });
  }

  /**
   * Stream a chat completion with tool calling support.
   * Uses native tool calling when enabled via ENV, otherwise falls back to UnTooled.
   */
  async stream(messages, functions = [], eventHandler = null) {
    const useNative =
      functions.length > 0 && (await this.supportsNativeToolCalling());

    if (!useNative) {
      return await UnTooled.prototype.stream.call(
        this,
        messages,
        functions,
        this.#handleFunctionCallStream.bind(this),
        eventHandler
      );
    }

    this.providerLog(
      "Provider.stream (tooled) - will process this chat completion."
    );

    try {
      return await tooledStream(
        this.client,
        this.model,
        messages,
        functions,
        eventHandler,
        { provider: this }
      );
    } catch (error) {
      console.error(error.message, error);
      // F8: upstream 429 on the configured free-option slug → rethrow with a
      // stable marker so the client-facing mapping can show the F8 wording.
      const freeLimitError = await freeOptionRateLimitError(error, this.model);
      if (freeLimitError) throw freeLimitError;
      if (error instanceof OpenAI.AuthenticationError) throw error;
      if (
        error instanceof OpenAI.RateLimitError ||
        error instanceof OpenAI.InternalServerError ||
        error instanceof OpenAI.APIError
      ) {
        throw new RetryError(error.message);
      }
      throw error;
    }
  }

  /**
   * Create a non-streaming completion with tool calling support.
   * Uses native tool calling when enabled via ENV, otherwise falls back to UnTooled.
   */
  async complete(messages, functions = []) {
    const useNative =
      functions.length > 0 && (await this.supportsNativeToolCalling());

    if (!useNative) {
      return await UnTooled.prototype.complete.call(
        this,
        messages,
        functions,
        this.#handleFunctionCallChat.bind(this)
      );
    }

    try {
      const result = await tooledComplete(
        this.client,
        this.model,
        messages,
        functions,
        this.getCost.bind(this),
        { provider: this }
      );

      if (result.retryWithError) {
        return this.complete([...messages, result.retryWithError], functions);
      }

      return result;
    } catch (error) {
      // F8: upstream 429 on the configured free-option slug → rethrow with a
      // stable marker so the client-facing mapping can show the F8 wording.
      const freeLimitError = await freeOptionRateLimitError(error, this.model);
      if (freeLimitError) throw freeLimitError;
      if (error instanceof OpenAI.AuthenticationError) throw error;
      if (
        error instanceof OpenAI.RateLimitError ||
        error instanceof OpenAI.InternalServerError ||
        error instanceof OpenAI.APIError
      ) {
        throw new RetryError(error.message);
      }
      throw error;
    }
  }

  /**
   * Get the cost of the completion.
   * @param _usage The completion to get the cost for.
   * @returns The cost of the completion.
   */
  getCost(_usage) {
    return 0;
  }
}

module.exports = OpenRouterProvider;
