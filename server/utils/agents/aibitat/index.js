/* eslint-disable unused-imports/no-unused-vars */
const { EventEmitter } = require("events");
const { APIError } = require("./error.js");
const Providers = require("./providers/index.js");
const { v4 } = require("uuid");
const { ToolReranker } = require("./utils/toolReranker.js");

/**
 * AIbitat is a class that manages the conversation between agents.
 * It is designed to solve a task with LLM.
 *
 * Guiding the chat through a graph of agents.
 */
class AIbitat {
  emitter = new EventEmitter();

  /**
   * Temporary flag to skip the handleExecution function
   * This is used to return the result of a flow execution directly to the chat
   * without going through the handleExecution function (resulting in more LLM processing)
   *
   * Setting Skip execution to true will prevent any further tool calls from being executed.
   * This is useful for flow executions that need to return a result directly to the chat but
   * can also prevent tool-call chaining.
   *
   * @type {boolean}
   */
  skipHandleExecution = false;

  _provider = null;

  /** @type {import("./providers/ai-provider").AgentProviderInstance|null} */
  _providerInstance = null;

  defaultProvider = null;
  defaultInterrupt;
  maxRounds;
  _chats;
  _trackedChatId = null;
  agents = new Map();
  channels = new Map();
  functions = new Map();

  /**
   * Buffer for citations collected during tool execution.
   * Citations are flushed to the frontend when the response is finalized.
   * @type {Array<{id: string, title: string, text: string, chunkSource?: string, score?: number}>}
   */
  _pendingCitations = [];

  /**
   * Buffer for attachments (images) collected during tool execution.
   * Tools can call addToolAttachment() to queue images for injection into the conversation.
   * These are injected as a user message so all providers' existing attachment handling works.
   * @type {Array<{name: string, mime: string, contentString: string}>}
   */
  _toolAttachments = [];

  /**
   * Buffer for clarifying-question surveys completed during tool execution.
   * Each entry is one ask-user invocation (questions + the user's result),
   * drained by the chat-history plugin into workspace_chats.response so the
   * filled-in survey persists alongside citations/outputs.
   * @type {Array<{questions: Array<Object>, result: Object}>}
   */
  _pendingClarifyingQuestionSurveys = [];

  /**
   * Get the default maximum number of tools an agent can chain for a single response.
   * @returns {number}
   */
  static defaultMaxToolCalls() {
    const envMaxToolCalls = parseInt(process.env.AGENT_MAX_TOOL_CALLS, 100);
    return !isNaN(envMaxToolCalls) && envMaxToolCalls > 0
      ? envMaxToolCalls
      : 100;
  }

  /**
   * Create a new AIbitat instance.
   * @param {Object} props - The properties for the AIbitat instance.
   * @param {Array} props.chats - [default: []] The chat history between agents and channels.
   * @param {string} props.interrupt - [default: "NEVER"] The interrupt mode for the AIbitat instance.
   * @param {number} props.maxRounds - [default: 100] The maximum number of rounds for the AIbitat instance.
   * @param {number} props.maxToolCalls - [default: AIbitat.defaultMaxToolCalls()] The maximum number of tools an agent can chain for a single response.
   * @param {string} props.provider - [default: "openai"] The provider for the AIbitat instance.
   * @param {Object} props.handlerProps - The handler properties for the AIbitat instance.
   * @param {Object} rest - The rest of the properties for the AIbitat instance.
   */
  constructor(props = {}) {
    const {
      chats = [],
      interrupt = "NEVER",
      maxRounds = 100,
      maxToolCalls = AIbitat.defaultMaxToolCalls(),
      provider = "openai",
      handlerProps = {}, // Inherited props we can spread so aibitat can access.
      ...rest
    } = props;
    this._chats = chats;
    this.defaultInterrupt = interrupt;
    this.maxRounds = maxRounds;
    this.maxToolCalls = maxToolCalls;
    this.handlerProps = handlerProps;

    this.defaultProvider = {
      provider,
      ...rest,
    };
    this.provider = this.defaultProvider.provider;
    this.model = this.defaultProvider.model;

    /**
     * AbortController that lives for the duration of this AIbitat instance.
     * AIbitat is instantiated fresh per invocation, so its lifetime matches
     * the controller's perfectly. Aborting it cancels any in-flight upstream
     * LLM call (plumbed into the provider via `abortSignal`) and is checked
     * by the agent loop to stop recursing into further provider calls / tools.
     * @type {AbortController}
     */
    this.abortController = new AbortController();

    /**
     * Central flag indicating this run has been aborted.
     * Set by `abort()`. Previously only the chat-history plugin set this
     * (to skip persisting); now it is the authoritative flag.
     * @type {boolean}
     */
    this._aborted = false;

    /**
     * Ordered trace of the current turn's intermediate agent activity
     * (reasoning blocks, pre-tool assistant text, tool calls, tool results).
     * Appended by `handleAsyncExecution`/`handleExecution` at the same sites
     * the `role:"function"` messages are appended. Drained by the chat-history
     * plugin at finalize/abort time and by incremental flushes
     * (agent-full-context-trace plan, Steps 2b/5).
     * @type {Array<{
     *   type: "reasoning"|"tool_call"|"tool_result"|"llm_text"|"truncation_marker",
     *   llmCall?: number,
     *   callId?: string|null,
     *   name?: string,
     *   arguments?: any,
     *   text?: string,
     *   content?: any
     * }>}
     */
    this._traceBuffer = [];

    /**
     * Number of LLM calls made this turn. Bumped at each
     * `providerInstance.stream`/`providerInstance.complete` call; used as the
     * 1-based `llmCall` index on trace entries.
     * @type {number}
     */
    this._traceLlmCalls = 0;

    /**
     * True once the trace hit the size cap and a single `truncation_marker`
     * entry was recorded (N6). No further entries are appended after it.
     * @type {boolean}
     */
    this._traceTruncated = false;

    /**
     * Running serialized size of the trace buffer in bytes, for the
     * append-time cap check (N6).
     * @type {number}
     */
    this._traceBytes = 0;

    /**
     * Step 2b incremental trace flush state (F11/N11/N12).
     * `_traceFlushPending` coalesces bursts: while a flush is queued, further
     * tool completions skip scheduling (the queued flush serializes the newer
     * buffer). `_traceFlushLastRunAt` throttles flushes to a minimum interval
     * so SQLite's single writer is not hammered (default 500 ms).
     * @type {boolean}
     */
    this._traceFlushPending = false;

    /** @type {number} timestamp (ms) of the last executed flush */
    this._traceFlushLastRunAt = 0;
  }

  /**
   * Get the chat history between agents and channels.
   */
  get chats() {
    return this._chats;
  }

  get provider() {
    return this._provider;
  }

  set provider(value) {
    if (value !== null && typeof value !== "string") {
      console.trace(); // print this for user report debugging so call stack is visible
      throw new TypeError(
        `aibitat.provider must be a string tag (e.g. "openai"), got ${typeof value}. ` +
          `Use aibitat.providerInstance to to get/store the provider instance.`
      );
    }
    this._provider = value;
  }

  /** @returns {import("./providers/ai-provider").AgentProviderInstance} */
  get providerInstance() {
    return this._providerInstance;
  }

  /** @param {import("./providers/ai-provider").AgentProviderInstance|null} value */
  set providerInstance(value) {
    this._providerInstance = value;
  }

  /**
   * Install a plugin.
   */
  use(plugin) {
    plugin.setup(this);
    return this;
  }

  /**
   * Register a new chat ID for tracking for a given conversation exchange
   * @param {number} chatId - The ID of the chat to register.
   */
  registerChatId(chatId = null) {
    if (!chatId) return;
    this._trackedChatId = Number(chatId);
  }

  /**
   * Get the tracked chat ID for a given conversation exchange
   * @returns {number|null} The ID of the chat to register.
   */
  get trackedChatId() {
    return this._trackedChatId ?? null;
  }

  /**
   * Clear the tracked chat ID for a given conversation exchange
   */
  clearTrackedChatId() {
    this._trackedChatId = null;
  }

  /**
   * Emit the tracked chat ID to the frontend via the websocket
   * plugin (assumed to be attached).
   * @param {string} [uuid] - The message UUID to associate with this chatId
   */
  emitChatId(uuid = null) {
    if (!this.trackedChatId || !uuid) return null;
    this.socket?.send?.("reportStreamEvent", {
      type: "chatId",
      uuid,
      chatId: this.trackedChatId,
    });
  }

  /**
   * Add citation(s) to be reported when the response is finalized.
   * Citations are buffered and flushed with the correct message UUID.
   * @param {{id: string, title: string, text: string, chunkSource?: string, score?: number}|Array<{id: string, title: string, text: string, chunkSource?: string, score?: number}>} citations - Citation object or array of citation objects
   */
  addCitation(citations) {
    if (!citations) return;
    if (Array.isArray(citations))
      this._pendingCitations.push(...citations.filter(Boolean));
    else if (typeof citations === "object")
      this._pendingCitations.push(citations);
  }

  /**
   * Flush all pending citations to the frontend with the given message UUID.
   * Called automatically when the agent response is finalized.
   * Note: Does not clear citations - they are cleared by chat-history plugin after persisting.
   * @param {string} messageUuid - The UUID of the message to attach citations to
   */
  flushCitations(messageUuid) {
    if (!messageUuid || this._pendingCitations.length === 0) return;
    this.socket?.send?.("reportStreamEvent", {
      type: "citations",
      uuid: messageUuid,
      citations: this._pendingCitations,
    });
  }

  /**
   * Clear all pending citations. Called after citations have been persisted.
   */
  clearCitations() {
    this._pendingCitations = [];
  }

  /**
   * Send routing metadata to the frontend for the given message UUID.
   * Only emits if routing metadata exists in handlerProps.
   * @param {string} messageUuid - The UUID of the message to attach routing info to
   */
  flushRoutingMetadata(messageUuid) {
    const routingMetadata = this.handlerProps?.routingMetadata;
    if (
      !messageUuid ||
      !routingMetadata?.routedTo ||
      !routingMetadata.routedTo.shouldNotify
    )
      return;
    this.socket?.send?.("reportStreamEvent", {
      type: "modelRouteNotification",
      uuid: `${messageUuid}:route`,
      routedTo: routingMetadata.routedTo,
    });
  }

  /**
   * Report the current context (prompt) token usage to the frontend.
   * Emitted after every LLM step so UI displays like the context window
   * indicator can track growth in real time as tool results are appended
   * to the conversation.
   */
  emitContextUsage() {
    const metrics = this.providerInstance?.getUsage();
    if (!metrics) return;
    const promptTokens = Number(metrics.prompt_tokens);
    if (!Number.isFinite(promptTokens) || promptTokens <= 0) return;
    this.socket?.send?.("reportStreamEvent", {
      type: "usageMetrics",
      uuid: `${v4()}:context_usage_step`,
      metrics,
    });
  }

  /**
   * Add an attachment (image) from a tool to be injected into the conversation.
   * The attachment will be added as a user message so the model can "see" it.
   * This leverages existing provider attachment handling for user messages.
   * @param {{name: string, mime: string, contentString: string}} attachment - The attachment object with name, mime type, and base64 data URL
   */
  addToolAttachment(attachment) {
    if (!attachment || !attachment.contentString) return;
    this._toolAttachments.push(attachment);
  }

  /**
   * Add a completed clarifying-question survey to the pending buffer.
   * The chat-history plugin drains this buffer when persisting the agent reply.
   * @param {{questions: Array<Object>, result: Object}} survey - The survey to add
   */
  addClarifyingQuestionSurvey(survey) {
    if (!survey || typeof survey !== "object") return;
    this._pendingClarifyingQuestionSurveys.push(survey);
  }

  /**
   * Clear all pending clarifying-question surveys. Called after surveys
   * have been persisted to the workspace_chats record.
   */
  clearClarifyingQuestionSurveys() {
    this._pendingClarifyingQuestionSurveys = [];
  }

  /**
   * Collect and clear any pending tool attachments.
   * @returns {Array<{name: string, mime: string, contentString: string}>} The collected attachments
   */
  collectToolAttachments() {
    if (this._toolAttachments.length === 0) return [];
    const attachments = [...this._toolAttachments];
    this._toolAttachments = [];
    return attachments;
  }

  /**
   * Maximum serialized size (bytes) a single turn's trace may grow to before
   * it is truncated (N6). Env-tunable via `AGENT_TRACE_MAX_BYTES`.
   * @returns {number}
   */
  static traceMaxBytes() {
    const envMax = parseInt(process.env.AGENT_TRACE_MAX_BYTES, 10);
    return !isNaN(envMax) && envMax > 0
      ? envMax
      : 2 * 1024 * 1024; // 2 MB default
  }

  /**
   * Bump and return the 1-based LLM call counter for this turn.
   * Called once per `providerInstance.stream`/`providerInstance.complete`
   * invocation from the tool-execution loops.
   * @returns {number} The index to stamp on this round's trace entries.
   */
  _nextTraceLlmCall() {
    this._traceLlmCalls += 1;
    return this._traceLlmCalls;
  }

  /**
   * Append an entry to the trace buffer with append-time cap enforcement (N6).
   * Once the running serialized size exceeds `AGENT_TRACE_MAX_BYTES`, a single
   * `{ type: "truncation_marker" }` entry is pushed and all subsequent appends
   * are dropped for the rest of the turn.
   * @param {object} entry - A trace entry (see `_traceBuffer` shape).
   */
  _appendTraceEntry(entry) {
    if (!entry || this._traceTruncated) return;

    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(entry));
    } catch {
      size = 0; // unserializable entry content is treated as free
    }

    if (this._traceBytes + size > AIbitat.traceMaxBytes()) {
      this._traceTruncated = true;
      this._traceBuffer.push({ type: "truncation_marker" });
      return;
    }

    this._traceBytes += size;
    this._traceBuffer.push(entry);
  }

  /**
   * Get the current turn's trace in its persistable serialized shape
   * (matches the `response.trace` payload written by the chat-history plugin).
   * @returns {{entries: Array<object>, llmCalls: number, truncated: boolean}}
   */
  getTrace() {
    return {
      entries: [...this._traceBuffer],
      llmCalls: this._traceLlmCalls,
      truncated: this._traceTruncated,
    };
  }

  /**
   * Clear the trace buffer and reset the cap accounting.
   * Called by the chat-history plugin after persisting a turn.
   */
  clearTrace() {
    this._traceBuffer = [];
    this._traceLlmCalls = 0;
    this._traceTruncated = false;
    this._traceBytes = 0;
  }

  /**
   * Minimum interval (ms) between incremental trace flushes (Step 2b).
   * @returns {number}
   */
  static traceFlushIntervalMs() {
    const envMs = parseInt(process.env.AGENT_TRACE_FLUSH_INTERVAL_MS, 10);
    return !isNaN(envMs) && envMs >= 0
      ? envMs
      : 500; // default-on throttle: cheap insurance on SQLite's single writer
  }

  /**
   * Schedule a fire-and-forget incremental trace flush (F11, Step 2b).
   *
   * Called immediately after a completed tool call's `tool_result` entry is
   * appended to the trace buffer. Coalesced (max one pending flush per turn —
   * the pending flush serializes the newest buffer when it runs) and
   * throttled to `AGENT_TRACE_FLUSH_INTERVAL_MS` (default 500 ms).
   *
   * Contract (N11/N12): flushes never flip `include`, never debit credits,
   * never trigger thread rename, and never throw into the tool loop — the
   * chat-history plugin's `_flushTrace` handles all persistence concerns and
   * swallows its own errors. All guards (trackedChatId presence, _aborted /
   * _finalized ownership) live in `_flushTrace` so this scheduler stays dumb.
   */
  scheduleTraceFlush() {
    if (this._traceFlushPending) return; // coalesced — pending flush sees newest buffer

    const now = Date.now();
    const elapsed = now - this._traceFlushLastRunAt;
    const interval = AIbitat.traceFlushIntervalMs();

    const run = () => {
      this._traceFlushPending = false;
      this._traceFlushLastRunAt = Date.now();
      // `flushTrace` is attached by the chat-history plugin (Step 2b).
      // Optional chaining keeps this a no-op in deployments/tests without it.
      try {
        this.flushTrace?.();
      } catch (e) {
        // Never throw into the tool loop (N12).
        this.handlerProps?.log?.(
          `[debug]: trace flush scheduling error (dropped): ${e.message}`
        );
      }
    };

    const wait = Math.max(0, interval - elapsed);
    if (wait === 0) {
      run();
      return;
    }

    this._traceFlushPending = true;
    setTimeout(run, wait);
  }

  /**
   * Add a new agent to the AIbitat.
   *
   * @param name
   * @param config
   * @returns
   */
  agent(name = "", config = {}) {
    this.agents.set(name, config);
    return this;
  }

  /**
   * Add a new channel to the AIbitat.
   *
   * @param name
   * @param members
   * @param config
   * @returns
   */
  channel(name = "", members = [""], config = {}) {
    this.channels.set(name, {
      members,
      ...config,
    });
    return this;
  }

  /**
   * Get the specific agent configuration.
   *
   * @param agent The name of the agent.
   * @throws When the agent configuration is not found.
   * @returns The agent configuration.
   */
  getAgentConfig(agent = "") {
    const config = this.agents.get(agent);
    if (!config) {
      throw new Error(`Agent configuration "${agent}" not found`);
    }
    return {
      role: "You are a helpful AI assistant.",
      //       role: `You are a helpful AI assistant.
      // Solve tasks using your coding and language skills.
      // In the following cases, suggest typescript code (in a typescript coding block) or shell script (in a sh coding block) for the user to execute.
      //     1. When you need to collect info, use the code to output the info you need, for example, browse or search the web, download/read a file, print the content of a webpage or a file, get the current date/time, check the operating system. After sufficient info is printed and the task is ready to be solved based on your language skill, you can solve the task by yourself.
      //     2. When you need to perform some task with code, use the code to perform the task and output the result. Finish the task smartly.
      // Solve the task step by step if you need to. If a plan is not provided, explain your plan first. Be clear which step uses code, and which step uses your language skill.
      // When using code, you must indicate the script type in the code block. The user cannot provide any other feedback or perform any other action beyond executing the code you suggest. The user can't modify your code. So do not suggest incomplete code which requires users to modify. Don't use a code block if it's not intended to be executed by the user.
      // If you want the user to save the code in a file before executing it, put # filename: <filename> inside the code block as the first line. Don't include multiple code blocks in one response. Do not ask users to copy and paste the result. Instead, use 'print' function for the output when relevant. Check the execution result returned by the user.
      // If the result indicates there is an error, fix the error and output the code again. Suggest the full code instead of partial code or code changes. If the error can't be fixed or if the task is not solved even after the code is executed successfully, analyze the problem, revisit your assumption, collect additional info you need, and think of a different approach to try.
      // When you find an answer, verify the answer carefully. Include verifiable evidence in your response if possible.
      // Reply "TERMINATE" when everything is done.`,
      ...config,
    };
  }

  /**
   * Get the specific channel configuration.
   *
   * @param channel The name of the channel.
   * @throws When the channel configuration is not found.
   * @returns The channel configuration.
   */
  getChannelConfig(channel = "") {
    const config = this.channels.get(channel);
    if (!config) {
      throw new Error(`Channel configuration "${channel}" not found`);
    }
    return {
      maxRounds: 10,
      role: "",
      ...config,
    };
  }

  /**
   * Get the members of a group.
   * @throws When the group is not defined as an array in the connections.
   * @param node The name of the group.
   * @returns The members of the group.
   */
  getGroupMembers(node = "") {
    const group = this.getChannelConfig(node);
    return group.members;
  }

  /**
   * The AbortSignal for this run. Pass this (or thread it into provider
   * calls) so in-flight upstream LLM requests are torn down on abort.
   * @returns {AbortSignal}
   */
  get abortSignal() {
    return this.abortController.signal;
  }

  /**
   * Triggered when a plugin, socket, or command is aborted.
   *
   * @param listener
   * @returns
   */
  onAbort(listener = () => null) {
    this.emitter.on("abort", listener);
    return this;
  }

  /**
   * Abort the current run.
   * - Fires the `"abort"` emitter event so existing listeners keep working
   *   (chat-history skips persisting; summarize / web-scraping cancel their
   *   own in-flight work).
   * - Aborts the instance's AbortController so any in-flight upstream LLM
   *   call wired to `abortSignal` is torn down immediately.
   * - Sets `_aborted` centrally so the agent loop can stop recursing
   *   (no further provider calls or tool executions) even if no plugin
   *   was attached to the `"abort"` event.
   */
  abort() {
    this._aborted = true;
    this.abortController.abort();
    this.emitter.emit("abort", null, this);
  }

  /**
   * Triggered when a chat is terminated. After this, the chat can't be continued.
   *
   * @param listener
   * @returns
   */
  onTerminate(listener = () => null) {
    this.emitter.on("terminate", listener);
    return this;
  }

  /**
   * Terminate the chat. After this, the chat can't be continued.
   *
   * @param node Last node to chat with
   */
  terminate(node = "") {
    this.emitter.emit("terminate", node, this);
  }

  /**
   * Triggered when a chat is interrupted by a node.
   *
   * @param listener
   * @returns
   */
  onInterrupt(listener = () => null) {
    this.emitter.on("interrupt", listener);
    return this;
  }

  /**
   * Interruption the chat.
   *
   * @param route The nodes that participated in the interruption.
   * @returns
   */
  interrupt(route) {
    this._chats.push({
      ...route,
      state: "interrupt",
    });
    this.emitter.emit("interrupt", route, this);
  }

  /**
   * Triggered when a message is added to the chat history.
   * This can either be the first message or a reply to a message.
   *
   * @param listener
   * @returns
   */
  onMessage(listener = (chat) => null) {
    this.emitter.on("message", listener);
    return this;
  }

  /**
   * Register a new successful message in the chat history.
   * This will trigger the `onMessage` event.
   *
   * @param message
   */
  newMessage(message) {
    const chat = {
      ...message,
      state: "success",
    };

    this._chats.push(chat);
    this.emitter.emit("message", chat, this);
  }

  /**
   * Triggered when an error occurs during the chat.
   *
   * @param listener
   * @returns
   */
  onError(
    listener = (
      /**
       * The error that occurred.
       *
       * Native errors are:
       * - `APIError`
       * - `AuthorizationError`
       * - `UnknownError`
       * - `RateLimitError`
       * - `ServerError`
       */
      error = null,
      /**
       * The message when the error occurred.
       */
      // eslint-disable-next-line
      {}
    ) => null
  ) {
    this.emitter.on("replyError", listener);
    return this;
  }

  /**
   * Triggered when a tool call completes and returns a result.
   * Used by scheduled jobs to capture tool results for the execution trace.
   *
   * @param listener
   * @returns
   */
  onToolCallResult(listener = () => null) {
    this.emitter.on("toolCallResult", listener);
    return this;
  }

  /**
   * Register an error in the chat history.
   * This will trigger the `onError` event.
   *
   * @param route
   * @param error
   */
  newError(route, error) {
    const chat = {
      ...route,
      content: error instanceof Error ? error.message : String(error),
      state: "error",
    };
    this._chats.push(chat);
    this.emitter.emit("replyError", error, chat);
  }

  /**
   * Triggered when a chat is interrupted by a node.
   *
   * @param listener
   * @returns
   */
  onStart(listener = (chat, aibitat) => null) {
    this.emitter.on("start", listener);
    return this;
  }

  /**
   * Start a new chat.
   *
   * @param message The message to start the chat.
   */
  async start(message) {
    // register the message in the chat history
    this.newMessage(message);
    this.emitter.emit("start", message, this);

    // ask the node to reply
    await this.chat({
      to: message.from,
      from: message.to,
    });

    return this;
  }

  /**
   * Recursively chat between two nodes.
   *
   * @param route
   * @param keepAlive Whether to keep the chat alive.
   */
  async chat(route, keepAlive = true) {
    // Aborted run: stop recursing (no further provider calls or tool
    // executions) and unwind the pipeline through the terminate path so
    // attached sockets/handlers close instead of hanging.
    if (this.abortSignal.aborted) {
      this.terminate(route.to || route.from);
      return;
    }

    // check if the message is for a group
    // if it is, select the next node to chat with from the group
    // and then ask them to reply.
    if (this.channels.get(route.from)) {
      // select a node from the group
      let nextNode;
      try {
        nextNode = await this.selectNext(route.from);
      } catch (error) {
        if (error instanceof APIError) {
          return this.newError({ from: route.from, to: route.to }, error);
        }
        throw error;
      }

      // An abort may have fired while awaiting the routing call.
      if (this.abortSignal.aborted) {
        this.terminate(route.from);
        return;
      }

      if (!nextNode) {
        // TODO: should it throw an error or keep the chat alive when there is no node to chat with in the group?
        // maybe it should wrap up the chat and reply to the original node
        // For now, it will terminate the chat
        this.terminate(route.from);
        return;
      }

      const nextChat = {
        from: nextNode,
        to: route.from,
      };

      if (this.shouldAgentInterrupt(nextNode)) {
        this.interrupt(nextChat);
        return;
      }

      // get chats only from the group's nodes
      const history = this.getHistory({ to: route.from });
      const group = this.getGroupMembers(route.from);
      const rounds = history.filter((chat) => group.includes(chat.from)).length;

      const { maxRounds } = this.getChannelConfig(route.from);
      if (rounds >= maxRounds) {
        this.terminate(route.to);
        return;
      }

      await this.chat(nextChat);
      return;
    }

    // If it's a direct message, reply to the message
    let reply = "";
    try {
      reply = await this.reply(route);
    } catch (error) {
      if (error instanceof APIError) {
        return this.newError({ from: route.from, to: route.to }, error);
      }
      throw error;
    }

    if (
      reply === "TERMINATE" ||
      this.hasReachedMaximumRounds(route.from, route.to)
    ) {
      this.terminate(route.to);
      return;
    }

    const newChat = { to: route.from, from: route.to };

    if (
      reply === "INTERRUPT" ||
      (this.agents.get(route.to) && this.shouldAgentInterrupt(route.to))
    ) {
      this.interrupt(newChat);
      return;
    }

    if (keepAlive) {
      // keep the chat alive by replying to the other node
      await this.chat(newChat, true);
    }
  }

  /**
   * Check if the agent should interrupt the chat based on its configuration.
   *
   * @param agent
   * @returns {boolean} Whether the agent should interrupt the chat.
   */
  shouldAgentInterrupt(agent = "") {
    const config = this.getAgentConfig(agent);
    return this.defaultInterrupt === "ALWAYS" || config.interrupt === "ALWAYS";
  }

  /**
   * Select the next node to chat with from a group. The node will be selected based on the history of chats.
   * It will select the node that has not reached the maximum number of rounds yet and has not chatted with the channel in the last round.
   * If it could not determine the next node, it will return a random node.
   *
   * @param channel The name of the group.
   * @returns The name of the node to chat with.
   */
  async selectNext(channel = "") {
    // get all members of the group
    const nodes = this.getGroupMembers(channel);
    const channelConfig = this.getChannelConfig(channel);

    // TODO: move this to when the group is created
    // warn if the group is underpopulated
    if (nodes.length < 3) {
      console.warn(
        `- Group (${channel}) is underpopulated with ${nodes.length} agents. Direct communication would be more efficient.`
      );
    }

    // get the nodes that have not reached the maximum number of rounds
    const availableNodes = nodes.filter(
      (node) => !this.hasReachedMaximumRounds(channel, node)
    );

    // remove the last node that chatted with the channel, so it doesn't chat again
    const lastChat = this._chats.filter((c) => c.to === channel).at(-1);
    if (lastChat) {
      const index = availableNodes.indexOf(lastChat.from);
      if (index > -1) {
        availableNodes.splice(index, 1);
      }
    }

    // TODO: what should it do when there is no node to chat with?
    if (!availableNodes.length) return;

    // get the provider that will be used for the channel
    // if the channel has a provider, use that otherwise
    // use the GPT-4 because it has a better reasoning
    const provider = this.getProviderForConfig({
      // @ts-expect-error
      model: "gpt-4",
      ...this.defaultProvider,
      ...channelConfig,
    });
    provider.attachHandlerProps(this.handlerProps);
    // Wire the run's abort signal so an abort tears down this routing LLM call.
    provider.abortSignal = this.abortSignal;

    const history = this.getHistory({ to: channel });

    // build the messages to send to the provider
    const messages = [
      {
        role: "system",
        content: channelConfig.role,
      },
      {
        role: "user",
        content: `You are in a role play game. The following roles are available:
${availableNodes.map((node) => `@${node}: ${this.getAgentConfig(node).role}`).join("\n")}.

Read the following conversation.

CHAT HISTORY
${history.map((c) => `@${c.from}: ${c.content}`).join("\n")}

Then select the next role from that is going to speak next.
Only return the role.
`,
      },
    ];

    // ask the provider to select the next node to chat with
    // and remove the @ from the response
    const { result } = await provider.complete(messages);
    const name = result?.replace(/^@/g, "");
    if (this.agents.get(name)) return name;

    // if the name is not in the nodes, return a random node
    return availableNodes[Math.floor(Math.random() * availableNodes.length)];
  }

  /**
   *
   * @param {string} pluginName this name of the plugin being called
   * @returns string of the plugin to be called compensating for children denoted by # in the string.
   * eg: sql-agent:list-database-connections
   * or is a custom plugin
   * eg: @@custom-plugin-name
   */
  #parseFunctionName(pluginName = "") {
    if (!pluginName.includes("#") && !pluginName.startsWith("@@"))
      return pluginName;
    if (pluginName.startsWith("@@")) return pluginName.replace("@@", "");
    return pluginName.split("#")[1];
  }

  /**
   * Extract the user's prompt from the messages array for tool reranking.
   * Gets the content of the last user message.
   * @param {Array} messages - Array of chat messages
   * @returns {string|null} The user's prompt or null if not found
   */
  #extractUserPrompt(messages) {
    if (!messages || !Array.isArray(messages)) return null;

    // Find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user" && msg.content) {
        return typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      }
    }
    return null;
  }

  /**
   * Check if the chat has reached the maximum number of rounds.
   */
  hasReachedMaximumRounds(from = "", to = "") {
    return this.getHistory({ from, to }).length >= this.maxRounds;
  }

  /**
   * Get the chat history between two nodes or all chats to/from a node.
   *
   * @param route
   * @returns
   */
  getOrFormatNodeChatHistory(route) {
    if (this.channels.get(route.to)) {
      return [
        {
          role: "user",
          content: `You are in a whatsapp group. Read the following conversation and then reply.
Do not add introduction or conclusion to your reply because this will be a continuous conversation. Don't introduce yourself.

CHAT HISTORY
${this.getHistory({ to: route.to })
  .map((c) => `@${c.from}: ${c.content}`)
  .join("\n")}

@${route.from}:`,
        },
      ];
    }

    // This is normal chat between user<->agent
    // Include attachments if present (for vision/multimodal support)
    return this.getHistory(route).map((c) => {
      const message = {
        content: c.content,
        role: c.from === route.to ? "user" : "assistant",
      };
      // Pass attachments through for user messages that have them
      if (
        c.attachments &&
        c.attachments.length > 0 &&
        message.role === "user"
      ) {
        message.attachments = c.attachments;
      }
      return message;
    });
  }

  /**
   * Ask the for the AI provider to generate a reply to the chat.
   * This will load the functions that the node can call and the chat history.
   * Then before calling the provider, it will check if the provider supports agent streaming.
   * If it does, it will call the provider asynchronously (streaming).
   * Otherwise, it will call the provider synchronously (non-streaming).
   * `.supportsAgentStreaming` is used to determine if the provider supports agent streaming on the respective provider.
   *
   * @param route.to The node that sent the chat.
   * @param route.from The node that will reply to the chat.
   */
  async reply(route) {
    // Aborted run: don't fire the provider call for this round. Returning
    // empty unwinds the recursion in chat() (keepAlive is off on the abort
    // path) without a scary error; the terminate() fired by the abort guard
    // has already unwound the pipeline.
    if (this.abortSignal.aborted) return "";

    const fromConfig = this.getAgentConfig(route.from);
    const chatHistory = this.getOrFormatNodeChatHistory(route);

    // Fetch fresh parsed file context and inject into the last user message
    if (this.fetchParsedFileContext) {
      const parsedContext = await this.fetchParsedFileContext();
      if (parsedContext) {
        // Find the last user message and append context to it
        for (let i = chatHistory.length - 1; i >= 0; i--) {
          if (chatHistory[i].role === "user") {
            chatHistory[i] = {
              ...chatHistory[i],
              content: chatHistory[i].content + parsedContext,
            };
            break;
          }
        }
      }
    }

    const messages = [
      {
        content: fromConfig.role,
        role: "system",
      },
      ...chatHistory,
    ];

    // get the functions that the node can call
    let functions = fromConfig.functions
      ?.map((name) => this.functions.get(this.#parseFunctionName(name)))
      .filter((a) => !!a);

    // Rerank tools based on user prompt if enabled
    if (ToolReranker.isEnabled() && functions?.length) {
      const toolReranker = new ToolReranker();
      const userPrompt = this.#extractUserPrompt(messages);
      if (userPrompt)
        functions = await toolReranker.rerank(userPrompt, functions);
    } else {
      if (functions?.length > ToolReranker.defaultTopN) {
        this.handlerProps.log?.(
          `

\x1b[44m[HINT]\x1b[0m: You are injecting \x1b[0;93m${functions.length} tools\x1b[0m into every request.
Consider enabling \x1b[0;93mIntelligent Skill Selection\x1b[0m to reduce token usage from tool call bloat by up to \x1b[0;93m80% per request\x1b[0m.
https://docs.anythingllm.com/agent/intelligent-tool-selection

`
        );
      }
    }

    // F16: re-resolve the default-user inference option before each turn if
    // a resolver is attached. Runs BEFORE the model-router hook below — the
    // explicit user option takes priority over `anythingllm-router` (the
    // init path in AgentHandler.#providerSetupAndCheck already bypasses the
    // router when an override is active, so this ordering mirrors it).
    // Mutating this.defaultProvider here is safe: reply() rebuilds the
    // provider instance from it every turn (no cached connector).
    if (this.resolveInferenceOption) {
      const userPrompt =
        this.#extractUserPrompt(messages) || route.content || "";
      const resolved = await this.resolveInferenceOption(userPrompt);
      if (resolved?.provider && resolved?.model) {
        const changed =
          this.defaultProvider.provider !== resolved.provider ||
          this.defaultProvider.model !== resolved.model;
        this.defaultProvider = {
          ...this.defaultProvider,
          provider: resolved.provider,
          model: resolved.model,
        };
        if (changed) {
          // Reuse the router's socket notification so the UI can show the
          // switch ("Switched to …") on the turn it happens.
          this.handlerProps.log?.(
            `[agent]: inference option switched → ${resolved.provider}:${resolved.model}`
          );
          this.handlerProps.routingMetadata = {
            routedTo: {
              provider: resolved.provider,
              model: resolved.model,
              ruleTitle: null,
              ruleType: "inference-option",
              isFallback: false,
              shouldNotify: true,
            },
          };
        }
      }
    }

    // Re-evaluate model router before each turn if a resolver is attached.
    // This ensures routing rules are applied per-message, not just at initialization.
    if (this.resolveRoute) {
      const userPrompt =
        this.#extractUserPrompt(messages) || route.content || "";
      const resolved = await this.resolveRoute(userPrompt);
      if (resolved) {
        this.defaultProvider = {
          ...this.defaultProvider,
          provider: resolved.provider,
          model: resolved.model,
        };
      }
    }

    this.providerInstance = this.getProviderForConfig({
      ...this.defaultProvider,
      ...fromConfig,
    });
    this.providerInstance.attachHandlerProps(this.handlerProps);
    // Wire the run's abort signal so an abort (Stop command, socket close,
    // HTTP client disconnect) tears down the in-flight upstream LLM request
    // instead of burning credits/GPU until the model finishes.
    this.providerInstance.abortSignal = this.abortSignal;

    let content;
    if (this.providerInstance.supportsAgentStreaming) {
      this.handlerProps.log?.(
        "[DEBUG] Provider supports agent streaming - will use async execution!"
      );
      content = await this.handleAsyncExecution(
        messages,
        functions,
        route.from
      );
    } else {
      this.handlerProps.log?.(
        "[DEBUG] Provider does not support agent streaming - will use synchronous execution!"
      );
      content = await this.handleExecution(messages, functions, route.from);
    }

    this.newMessage({ ...route, content });
    return content;
  }

  /**
   * True if the error was caused by us aborting the run (user Stop, socket
   * close, HTTP client disconnect) - NOT by an upstream provider failure.
   * Aborts must never be wrapped into a scary "agent model failed to
   * respond" APIError or converted into a RetryError: the pipeline has
   * already started unwinding (terminate / socket close / partial output).
   *
   * `TimeoutError` qualifies because aborting a fetch/undici request can
   * surface as a TimeoutError in some SDK paths.
   *
   * @param {Error|null} error
   * @returns {boolean}
   */
  #isAbortError(error) {
    if (this.abortSignal?.aborted && error instanceof Error) {
      if (
        error.name === "APIUserAbortError" ||
        error.name === "AbortError" ||
        error.name === "TimeoutError"
      )
        return true;
    }
    return false;
  }

  /**
   * Wrapper for provider calls that catches errors and converts them to APIError.
   * This ensures provider errors are properly surfaced to the user instead of crashing.
   * User aborts are re-thrown verbatim (never wrapped) so plugins can treat
   * them as a quiet unwind rather than a model failure.
   *
   * @param {Function} providerCall - Async function that calls the provider
   * @returns {Promise<any>} - The result of the provider call
   * @throws {APIError} - If the provider call fails
   */
  async #safeProviderCall(providerCall) {
    try {
      return await providerCall();
    } catch (error) {
      if (this.#isAbortError(error)) {
        this.handlerProps?.log?.(
          `[debug]: Provider call aborted - unwinding agent run quietly.`
        );
        throw error;
      }
      console.error(`[AIbitat] Provider error: ${error.message}`, {
        hide_meta: true,
      });
      throw new APIError(`The agent model failed to respond: ${error.message}`);
    }
  }

  /**
   * Handle the async (streaming) execution of the provider
   * with tool calls. Reads the provider from this.providerInstance.
   *
   * @param messages
   * @param functions
   * @param byAgent
   *
   * @returns {Promise<string>}
   */
  async handleAsyncExecution(
    messages = [],
    functions = [],
    byAgent = null,
    depth = 0
  ) {
    // Aborted run: stop recursing instead of firing the next provider call
    // or executing the next tool. Returning empty unwinds the recursion.
    if (this.abortSignal.aborted) return "";

    const eventHandler = (type, data) => {
      this?.socket?.send(type, data);
    };

    // Emit routing notification before the first completion so it appears above the response
    if (depth === 0) this?.flushRoutingMetadata?.(v4());

    /** @type {{ functionCall: { name: string, arguments: string }, textResponse: string }} */
    const traceLlmCall = this._nextTraceLlmCall();
    const completionStream = await this.#safeProviderCall(() =>
      this.providerInstance.stream(messages, functions, eventHandler)
    );

    // Trace capture for this round (Step 2 — agent-full-context-trace):
    // reasoning (when the provider surfaced it) then the assistant's
    // pre-tool / final text, in the order the model produced them.
    if (typeof completionStream?.reasoning === "string" && completionStream.reasoning.trim()) {
      this._appendTraceEntry({
        type: "reasoning",
        llmCall: traceLlmCall,
        text: completionStream.reasoning,
      });
    }
    if (typeof completionStream?.textResponse === "string" && completionStream.textResponse) {
      this._appendTraceEntry({
        type: "llm_text",
        llmCall: traceLlmCall,
        text: completionStream.textResponse,
      });
    }

    if (completionStream.functionCall) {
      const { name, arguments: args } = completionStream.functionCall;
      const fn = this.functions.get(name);
      const reachedToolLimit = depth >= this.maxToolCalls;

      if (reachedToolLimit) {
        this.handlerProps?.log?.(
          `[warning]: Maximum tool call limit (${this.maxToolCalls}) reached. Executing final tool call then generating response.`
        );
        this?.introspect?.(
          `Maximum tool call limit (${this.maxToolCalls}) reached. After this tool I will generate a final response.`
        );
      }

      if (!fn) {
        this._appendTraceEntry({
          type: "tool_call",
          llmCall: traceLlmCall,
          callId: completionStream.functionCall?.id ?? null,
          name,
          arguments: args,
        });
        this._appendTraceEntry({
          type: "tool_result",
          callId: completionStream.functionCall?.id ?? null,
          name,
          content: `Function "${name}" not found. Try again.`,
        });
        return await this.handleAsyncExecution(
          [
            ...messages,
            {
              name,
              role: "function",
              content: `Function "${name}" not found. Try again.`,
              originalFunctionCall: completionStream.functionCall,
            },
          ],
          reachedToolLimit ? [] : functions,
          byAgent,
          depth + 1
        );
      }

      fn.caller = byAgent || "agent";

      if (this.providerInstance?.verbose) {
        this?.introspect?.(
          `${fn.caller} is executing \`${name}\` tool ${JSON.stringify(args, null, 2)}`
        );
      }

      this.handlerProps?.log?.(
        `[debug]: ${fn.caller} is attempting to call \`${name}\` tool ${JSON.stringify(args, null, 2)}`
      );

      const result = await fn.handler(args);
      this.emitter.emit("toolCallResult", {
        toolName: name,
        arguments: args,
        result,
      });

      // Trace capture (Step 2): the tool call + its completed result, in order.
      this._appendTraceEntry({
        type: "tool_call",
        llmCall: traceLlmCall,
        callId: completionStream.functionCall?.id ?? null,
        name,
        arguments: args,
      });
      this._appendTraceEntry({
        type: "tool_result",
        callId: completionStream.functionCall?.id ?? null,
        name,
        content: result,
      });

      // Step 2b: fire-and-forget incremental flush of the trace-so-far.
      this.scheduleTraceFlush();

      // An abort may have fired while the tool was running. Don't start the
      // next LLM round — return the tool result and let the recursion unwind.
      if (this.abortSignal.aborted) {
        this.handlerProps?.log?.(
          `[debug]: Run aborted after tool \`${name}\` completed. Stopping agent loop.`
        );
        return result;
      }

      /**
       * If the tool call has direct output enabled, return the result directly to the chat
       * without any further processing and no further tool calls will be run.
       * For streaming, we need to return the result directly to the chat via the event handler
       * or else no response will be sent to the chat.
       */
      if (this.skipHandleExecution) {
        this.skipHandleExecution = false;
        this?.introspect?.(
          `The tool call has direct output enabled! The result will be returned directly to the chat without any further processing and no further tool calls will be run.`
        );
        this?.introspect?.(`Tool use completed.`);
        this.handlerProps?.log?.(
          `${fn.caller} tool call resulted in direct output! Returning raw result as string. NO MORE TOOL CALLS WILL BE EXECUTED.`
        );
        const directOutputUUID = completionStream?.uuid || v4();
        eventHandler?.("reportStreamEvent", {
          type: "fullTextResponse",
          uuid: directOutputUUID,
          content: result,
        });
        eventHandler?.("reportStreamEvent", {
          type: "usageMetrics",
          uuid: directOutputUUID,
          metrics: this.providerInstance.getUsage(),
        });
        this?.flushCitations?.(directOutputUUID);
        this?.emitChatId?.(directOutputUUID);
        return result;
      }

      const toolAttachments = this.collectToolAttachments();
      const newMessages = [
        ...messages,
        {
          name,
          role: "function",
          content: result,
          originalFunctionCall: completionStream.functionCall,
        },
      ];

      if (toolAttachments.length > 0) {
        this.handlerProps?.log?.(
          `[debug]: Injecting ${toolAttachments.length} image attachment(s) from tool result`
        );
        newMessages.push({
          role: "user",
          content: "[Attached image(s) from tool result]",
          attachments: toolAttachments,
        });
      }

      // Report context usage so the UI can track token growth after this step.
      this.emitContextUsage();

      return await this.handleAsyncExecution(
        newMessages,
        reachedToolLimit ? [] : functions,
        byAgent,
        depth + 1
      );
    }

    const responseUuid = completionStream?.uuid || v4();
    eventHandler?.("reportStreamEvent", {
      type: "usageMetrics",
      uuid: responseUuid,
      metrics: this.providerInstance.getUsage(),
    });
    this?.flushCitations?.(responseUuid);
    this?.emitChatId?.(responseUuid);
    return completionStream?.textResponse;
  }

  /**
   * Handle the synchronous (non-streaming) execution of the provider
   * with tool calls. Reads the provider from this.providerInstance.
   *
   * @param messages
   * @param functions
   * @param byAgent
   * @param depth
   * @param msgUUID - The message UUID to use for event correlation (created at depth=0)
   *
   * @returns {Promise<string>}
   */
  async handleExecution(
    messages = [],
    functions = [],
    byAgent = null,
    depth = 0,
    msgUUID = null
  ) {
    // Aborted run: stop recursing instead of firing the next provider call
    // or executing the next tool. Returning empty unwinds the recursion.
    if (this.abortSignal.aborted) return "";

    // Create a stable UUID at the start of execution for event correlation
    if (!msgUUID) msgUUID = v4();
    const eventHandler = (type, data) => {
      this?.socket?.send(type, data);
    };

    // Emit routing notification before the first completion so it appears above the response
    if (depth === 0) this?.flushRoutingMetadata?.(msgUUID);

    // get the chat completion
    const traceLlmCall = this._nextTraceLlmCall();
    const completion = await this.#safeProviderCall(() =>
      this.providerInstance.complete(messages, functions)
    );

    // Trace capture for this round (Step 2 — agent-full-context-trace):
    // reasoning (when the provider surfaced it) then the assistant's
    // pre-tool / final text, in the order the model produced them.
    if (typeof completion?.reasoning === "string" && completion.reasoning.trim()) {
      this._appendTraceEntry({
        type: "reasoning",
        llmCall: traceLlmCall,
        text: completion.reasoning,
      });
    }
    if (typeof completion?.textResponse === "string" && completion.textResponse) {
      this._appendTraceEntry({
        type: "llm_text",
        llmCall: traceLlmCall,
        text: completion.textResponse,
      });
    }

    if (completion.functionCall) {
      const { name, arguments: args } = completion.functionCall;
      const fn = this.functions.get(name);
      const reachedToolLimit = depth >= this.maxToolCalls;

      if (reachedToolLimit) {
        this.handlerProps?.log?.(
          `[warning]: Maximum tool call limit (${this.maxToolCalls}) reached. Executing final tool call then generating response.`
        );
        this?.introspect?.(
          `Maximum tool call limit (${this.maxToolCalls}) reached. After this tool I will generate a final response.`
        );
      }

      if (!fn) {
        this._appendTraceEntry({
          type: "tool_call",
          llmCall: traceLlmCall,
          callId: completion.functionCall?.id ?? null,
          name,
          arguments: args,
        });
        this._appendTraceEntry({
          type: "tool_result",
          callId: completion.functionCall?.id ?? null,
          name,
          content: `Function "${name}" not found. Try again.`,
        });
        return await this.handleExecution(
          [
            ...messages,
            {
              name,
              role: "function",
              content: `Function "${name}" not found. Try again.`,
              originalFunctionCall: completion.functionCall,
            },
          ],
          reachedToolLimit ? [] : functions,
          byAgent,
          depth + 1,
          msgUUID
        );
      }

      fn.caller = byAgent || "agent";

      if (this.providerInstance?.verbose) {
        this?.introspect?.(
          `[debug]: ${fn.caller} is attempting to call \`${name}\` tool`
        );
      }

      this.handlerProps?.log?.(
        `[debug]: ${fn.caller} is attempting to call \`${name}\` tool`
      );

      const result = await fn.handler(args);
      this.emitter.emit("toolCallResult", {
        toolName: name,
        arguments: args,
        result,
      });

      // Trace capture (Step 2): the tool call + its completed result, in order.
      this._appendTraceEntry({
        type: "tool_call",
        llmCall: traceLlmCall,
        callId: completion.functionCall?.id ?? null,
        name,
        arguments: args,
      });
      this._appendTraceEntry({
        type: "tool_result",
        callId: completion.functionCall?.id ?? null,
        name,
        content: result,
      });

      // Step 2b: fire-and-forget incremental flush of the trace-so-far.
      this.scheduleTraceFlush();

      // An abort may have fired while the tool was running. Don't start the
      // next LLM round — return the tool result and let the recursion unwind.
      if (this.abortSignal.aborted) {
        this.handlerProps?.log?.(
          `[debug]: Run aborted after tool \`${name}\` completed. Stopping agent loop.`
        );
        return result;
      }

      if (this.skipHandleExecution) {
        this.skipHandleExecution = false;
        this?.introspect?.(
          `The tool call has direct output enabled! The result will be returned directly to the chat without any further processing and no further tool calls will be run.`
        );
        this?.introspect?.(`Tool use completed.`);
        this.handlerProps?.log?.(
          `${fn.caller} tool call resulted in direct output! Returning raw result as string. NO MORE TOOL CALLS WILL BE EXECUTED.`
        );
        eventHandler?.("reportStreamEvent", {
          type: "usageMetrics",
          uuid: msgUUID,
          metrics: this.providerInstance.getUsage(),
        });
        this?.flushCitations?.(msgUUID);
        return result;
      }

      const toolAttachments = this.collectToolAttachments();
      const newMessages = [
        ...messages,
        {
          name,
          role: "function",
          content: result,
          originalFunctionCall: completion.functionCall,
        },
      ];

      if (toolAttachments.length > 0) {
        this.handlerProps?.log?.(
          `[debug]: Injecting ${toolAttachments.length} image attachment(s) from tool result`
        );
        newMessages.push({
          role: "user",
          content: "[Attached image(s) from tool result]",
          attachments: toolAttachments,
        });
      }

      // Report context usage so the UI can track token growth after this step.
      this.emitContextUsage();

      return await this.handleExecution(
        newMessages,
        reachedToolLimit ? [] : functions,
        byAgent,
        depth + 1,
        msgUUID
      );
    }

    eventHandler?.("reportStreamEvent", {
      type: "usageMetrics",
      uuid: msgUUID,
      metrics: this.providerInstance.getUsage(),
    });
    this?.flushCitations?.(msgUUID);
    this?.emitChatId?.(msgUUID);
    return completion?.textResponse;
  }

  /**
   * Continue the chat from the last interruption.
   * If the last chat was not an interruption, it will throw an error.
   * Provide a feedback where it was interrupted if you want to.
   *
   * @param feedback The feedback to the interruption if any.
   * @param attachments Optional attachments (images) to include with the feedback.
   * @returns
   */
  async continue(feedback, attachments = []) {
    const lastChat = this._chats.at(-1);
    if (!lastChat || lastChat.state !== "interrupt") {
      throw new Error("No chat to continue");
    }

    // remove the last chat's that was interrupted
    this._chats.pop();

    const { from, to } = lastChat;

    if (this.hasReachedMaximumRounds(from, to)) {
      throw new Error("Maximum rounds reached");
    }

    if (feedback) {
      const message = {
        from,
        to,
        content: feedback,
        ...(attachments?.length > 0 ? { attachments } : {}),
      };

      // register the message in the chat history
      this.newMessage(message);

      // ask the node to reply
      await this.chat({
        to: message.from,
        from: message.to,
      });
    } else {
      await this.chat({ from, to });
    }

    return this;
  }

  /**
   * Retry the last chat that threw an error.
   * If the last chat was not an error, it will throw an error.
   */
  async retry() {
    const lastChat = this._chats.at(-1);
    if (!lastChat || lastChat.state !== "error") {
      throw new Error("No chat to retry");
    }

    // remove the last chat's that threw an error
    // eslint-disable-next-line
    const { from, to } = this?._chats?.pop();

    await this.chat({ from, to });
    return this;
  }

  /**
   * Get the chat history between two nodes or all chats to/from a node.
   */
  getHistory({ from, to }) {
    return this._chats.filter((chat) => {
      const isSuccess = chat.state === "success";

      // return all chats to the node
      if (!from) {
        return isSuccess && chat.to === to;
      }

      // get all chats from the node
      if (!to) {
        return isSuccess && chat.from === from;
      }

      // check if the chat is between the two nodes
      const hasSent = chat.from === from && chat.to === to;
      const hasReceived = chat.from === to && chat.to === from;
      const mutual = hasSent || hasReceived;

      return isSuccess && mutual;
    });
  }

  /**
   * Get provider based on configurations.
   * If the provider is a string, it will return the default provider for that string.
   *
   * @param config The provider configuration.
   * @returns {Providers.OpenAIProvider} The provider instance.
   */
  getProviderForConfig(config) {
    if (typeof config.provider === "object") return config.provider;

    switch (config.provider) {
      case "openai":
        return new Providers.OpenAIProvider({ model: config.model });
      case "anthropic":
        return new Providers.AnthropicProvider({ model: config.model });
      case "lmstudio":
        return new Providers.LMStudioProvider({ model: config.model });
      case "ollama":
        return new Providers.OllamaProvider({ model: config.model });
      case "groq":
        return new Providers.GroqProvider({ model: config.model });
      case "togetherai":
        return new Providers.TogetherAIProvider({ model: config.model });
      case "azure":
        return new Providers.AzureOpenAiProvider({ model: config.model });
      case "koboldcpp":
        return new Providers.KoboldCPPProvider({});
      case "localai":
        return new Providers.LocalAIProvider({ model: config.model });
      case "openrouter":
        return new Providers.OpenRouterProvider({ model: config.model });
      case "mistral":
        return new Providers.MistralProvider({ model: config.model });
      case "generic-openai":
        return new Providers.GenericOpenAiProvider({ model: config.model });
      case "perplexity":
        return new Providers.PerplexityProvider({ model: config.model });
      case "textgenwebui":
        return new Providers.TextWebGenUiProvider({});
      case "bedrock":
        return new Providers.AWSBedrockProvider({});
      case "fireworksai":
        return new Providers.FireworksAIProvider({ model: config.model });
      case "nvidia-nim":
        return new Providers.NvidiaNimProvider({ model: config.model });
      case "moonshotai":
        return new Providers.MoonshotAiProvider({ model: config.model });
      case "deepseek":
        return new Providers.DeepSeekProvider({ model: config.model });
      case "litellm":
        return new Providers.LiteLLMProvider({ model: config.model });
      case "apipie":
        return new Providers.ApiPieProvider({ model: config.model });
      case "xai":
        return new Providers.XAIProvider({ model: config.model });
      case "zai":
        return new Providers.ZAIProvider({ model: config.model });
      case "novita":
        return new Providers.NovitaProvider({ model: config.model });
      case "ppio":
        return new Providers.PPIOProvider({ model: config.model });
      case "gemini":
        return new Providers.GeminiProvider({ model: config.model });
      case "dpais":
        return new Providers.DellProAiStudioProvider({ model: config.model });
      case "cometapi":
        return new Providers.CometApiProvider({ model: config.model });
      case "foundry":
        return new Providers.FoundryProvider({ model: config.model });
      case "giteeai":
        return new Providers.GiteeAIProvider({ model: config.model });
      case "cohere":
        return new Providers.CohereProvider({ model: config.model });
      case "docker-model-runner":
        return new Providers.DockerModelRunnerProvider({ model: config.model });
      case "privatemode":
        return new Providers.PrivatemodeProvider({ model: config.model });
      case "sambanova":
        return new Providers.SambaNovaProvider({ model: config.model });
      case "lemonade":
        return new Providers.LemonadeProvider({ model: config.model });
      case "minimax":
        return new Providers.MinimaxProvider({ model: config.model });
      case "cerebras":
        return new Providers.CerebrasProvider({ model: config.model });
      case "venice":
        return new Providers.VeniceProvider({ model: config.model });
      default:
        throw new Error(
          `Unknown provider: ${config.provider}. Please use a valid provider.`
        );
    }
  }

  /**
   * Register a new function to be called by the AIbitat agents.
   * You are also required to specify the which node can call the function.
   * @param functionConfig The function configuration.
   */
  function(functionConfig) {
    this.functions.set(functionConfig.name, functionConfig);
    return this;
  }
}

module.exports = AIbitat;
