const OpenAI = require("openai");
const Provider = require("./ai-provider.js");
const InheritMultiple = require("./helpers/classes.js");
const UnTooled = require("./helpers/untooled.js");
const { tooledStream, tooledComplete } = require("./helpers/tooled.js");
const { RetryError } = require("../error.js");
const { VeniceLLM } = require("../../../AiProviders/venice");

/**
 * The agent provider for the Venice AI provider.
 *
 * Venice (https://api.venice.ai/api/v1) is an OpenAI-compatible inference API.
 * Its models advertise native OpenAI `tools`-shape tool calling on the wire, so
 * we use the shared native tool-calling helpers (`tooledStream` /
 * `tooledComplete`) directly rather than the UnTooled prompt-based fallback.
 *
 * The `openai` SDK is configured with Venice's base URL + API key so the
 * standard `chat.completions` endpoint works unchanged.
 *
 * See also `server/utils/AiProviders/venice/index.js` for the chat + streaming
 * LLM connector (this class is the agent-mode counterpart).
 */
class VeniceProvider extends InheritMultiple([Provider, UnTooled]) {
  model;

  constructor(config = {}) {
    const { model = VeniceLLM.DEFAULT_MODEL } = config;
    super();
    const client = new OpenAI({
      baseURL: process.env.VENICE_BASE_PATH || VeniceLLM.DEFAULT_BASE_URL,
      apiKey: process.env.VENICE_API_KEY,
      maxRetries: 3,
    });

    this._client = client;
    this.model =
      model || process.env.VENICE_MODEL_PREF || VeniceLLM.DEFAULT_MODEL;
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
   * Whether this provider supports native OpenAI-compatible tool calling.
   * Venice's models advertise `tools` support on the wire, so we delegate to
   * the LLM connector's capability report (which surfaces `tools: true`).
   * Falls back to `false` if no key is set or the check throws.
   * @returns {Promise<boolean>}
   */
  async supportsNativeToolCalling() {
    if (this._supportsToolCalling !== null) return this._supportsToolCalling;
    try {
      await VeniceLLM.cacheContextWindows();
      const venice = new VeniceLLM(null, this.model);
      const capabilities = venice.getModelCapabilities();
      this._supportsToolCalling = capabilities.tools === true;
    } catch {
      this._supportsToolCalling = false;
    }
    return this._supportsToolCalling;
  }

  async #handleFunctionCallChat({ messages = [] }) {
    return await this.client.chat.completions
      .create({
        model: this.model,
        messages,
      })
      .then((result) => {
        if (!result.hasOwnProperty("choices"))
          throw new Error("Venice chat: No results!");
        if (result.choices.length === 0)
          throw new Error("Venice chat: No results length!");
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
    });
  }

  /**
   * Stream a chat completion with tool calling support.
   * Uses native tool calling when enabled, otherwise falls back to UnTooled.
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
   * Uses native tool calling when enabled, otherwise falls back to UnTooled.
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
   * @returns {number} The cost of the completion (currently 0).
   */
  getCost(_usage) {
    return 0;
  }
}

module.exports = VeniceProvider;
