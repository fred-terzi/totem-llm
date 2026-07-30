// Suppress deprecated content-type warning when sending files via the Telegram bot API.
// https://github.com/yagop/node-telegram-bot-api/blob/master/doc/usage.md#sending-files
process.env.NTBA_FIX_350 = 1;
const TelegramBot = require("node-telegram-bot-api");
const {
  ExternalCommunicationConnector,
} = require("../../models/externalCommunicationConnector");
const { BackgroundService } = require("../BackgroundWorkers");
const { MessageQueue } = require("./utils/messageQueue");
const { decryptToken } = require("./utils");
const {
  WorkspaceAgentInvocation,
} = require("../../models/workspaceAgentInvocation");
const { Workspace } = require("../../models/workspace");
const { WorkspaceChats } = require("../../models/workspaceChats");
const {
  isVerified,
  sendPairingRequest,
  approveUser,
  denyUser,
  revokeUser,
} = require("./utils/verification");
const { BOT_COMMANDS } = require("./utils/commands");
const { handleKeyboardQueryCallback } = require("./utils/navigation");
const {
  downloadTelegramFile,
  transcribeAudio,
  documentToText,
  photoToAttachment,
} = require("./utils/media");

class TelegramBotService {
  static _instance = null;
  static #MAX_POLLING_RETRIES = 10;
  static #BASE_RETRY_DELAY_MS = 1000;
  static #MAX_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes
  static #NETWORK_ERROR_PATTERNS = [
    "EPIPE",
    "EPROTO",
    "ECONNABORTED",
    "EHOSTDOWN",
    "ENETDOWN",
    "EADDRNOTAVAIL",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EAI_AGAIN",
    "EFATAL",
    "socket hang up",
    "network",
    "timeout",
    "bad gateway",
    "flood",
    "429",
    "409",
    "500",
    "501",
    "502",
    "503",
    "504",
    "520",
    "521",
    "522",
    "523",
    "524",
  ];

  /** @type {TelegramBot|null} */
  #bot = null;
  #config = null;
  #queue = new MessageQueue();
  #pollingRetry = { timer: null, count: 0 };
  // Per-chat state: { workspaceSlug, threadSlug }
  #chatState = new Map();
  // Pending pairing requests: chatId -> { code, telegramUsername, firstName }
  #pendingPairings = new Map();
  // Active workers per chat: chatId -> { worker, jobId }
  #activeWorkers = new Map();
  // Pending tool approval requests: requestId -> { worker, chatId, messageId }
  #pendingToolApprovals = new Map();
  // Bot's own Telegram user ID (resolved once on startup)
  #myUserId = null;
  #botUsername = null;

  constructor() {
    if (TelegramBotService._instance) return TelegramBotService._instance;
    TelegramBotService._instance = this;
  }

  get isRunning() {
    return this.#bot !== null;
  }

  get pendingPairings() {
    const pairings = [];
    for (const [chatId, data] of this.#pendingPairings) {
      pairings.push({ chatId: String(chatId), ...data });
    }
    return pairings;
  }

  #log(text, ...args) {
    console.log(`\x1b[35m[TelegramBot]\x1b[0m ${text}`, ...args);
  }

  async start(config) {
    if (this.#bot) await this.stop();
    this.#config = config;

    // Clear pending updates on startup, keeping only the last message per chat
    // This prevents processing a backlog of messages when the bot restarts.
    this.#bot = new TelegramBot(config.bot_token, { polling: false });
    const lastMessages = await this.#clearPendingUpdates();
    this.#bot.startPolling();

    // Restore per-user workspace/thread state from saved config
    for (const user of config.approved_users || []) {
      if (user.active_workspace) {
        this.#chatState.set(Number(user.chatId), {
          workspaceSlug: user.active_workspace,
          threadSlug: user.active_thread || null,
        });
      }
    }

    // Restore linked group state from DB
    for (const group of config.linked_groups || []) {
      this.#chatState.set(Number(group.chatId), {
        workspaceSlug: group.workspaceSlug,
        threadSlug: group.threadSlug || null,
      });
      this.#log(
        `Restored linked group ${group.chatId} → workspace "${group.workspaceSlug}"`
      );
    }

    // Resolve the live bot account details so group mention routing uses the
    // actual connected bot username, not an unreliable empty field on the SDK instance.
    const me = await this.#bot.getMe();
    this.#myUserId = me.id;
    this.#botUsername = me.username || this.#config.bot_username || null;

    this.#setupHandlers();
    await this.#registerCommands();
    this.#log(`Started polling as @${config.bot_username || "unknown"}`);

    // Process only the last message from each chat that was pending
    if (lastMessages.size > 0) {
      this.#log(
        `Processing ${lastMessages.size} pending message(s) from startup`
      );
      const ctx = this.#createContext();
      for (const [chatId, msg] of lastMessages) {
        if (!isVerified(this.#config.approved_users, chatId)) continue;
        this.#processPendingMessage(ctx, msg);
      }
    }
  }

  /**
   * Process a single pending message from startup.
   * Handles both commands and regular messages.
   */
  #processPendingMessage(ctx, msg) {
    const text = msg.text || "";

    // Handle commands
    if (text.startsWith("/")) {
      const commandMatch = text.match(/^\/(\w+)/);
      if (!commandMatch) return;

      const commandName = commandMatch[1];
      const command = BOT_COMMANDS.find((c) => c.command === commandName);
      if (command) {
        const handler = command.initHandler();
        handler(ctx, msg.chat.id, text);
        return;
      }
    }

    // Handle regular messages
    this.#handleMessage(ctx, msg);
  }

  /**
   * Check if the instance is running in multi-user mode
   * @returns {Promise<boolean>}
   */
  async checkMultiUserMode() {
    const { SystemSettings } = require("../../models/systemSettings");
    return await SystemSettings.isMultiUserMode();
  }

  updateConfig(updates) {
    if (!this.#config) return;
    Object.assign(this.#config, updates);
  }

  /**
   * Stop the bot and clear all state.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.#bot) return;

    // Clear any pending retry timer
    if (this.#pollingRetry.timer) {
      clearTimeout(this.#pollingRetry.timer);
      this.#pollingRetry.timer = null;
    }
    this.#pollingRetry.count = 0;

    try {
      await this.#bot.stopPolling();
    } catch {
      // Polling may already be stopped
    }

    // Kill any active workers before clearing state
    for (const chatId of this.#activeWorkers.keys()) {
      this.abortChat(chatId);
    }
    this.#bot = null;
    this.#config = null;
    this.#queue.clear();
    this.#chatState.clear();
    this.#pendingPairings.clear();
    this.#activeWorkers.clear();
    this.#pendingToolApprovals.clear();
    this.#log("Stopped");
  }

  /**
   * Self-cleanup when the bot token becomes invalid (e.g., bot deleted).
   * Stops polling and removes the connector from the database.
   */
  async #selfCleanup(reason) {
    this.#log(`Self-cleanup triggered: ${reason}`);
    await this.stop();
    await ExternalCommunicationConnector.delete("telegram");
    this.#log("Connector deleted due to invalid token");
  }

  /**
   * Check if an error is a transient network issue that warrants retry.
   */
  #isNetworkError(error) {
    const msg = (error.message || "").toLowerCase();
    return TelegramBotService.#NETWORK_ERROR_PATTERNS.some(
      (p) => msg.includes(p.toLowerCase()) || error.code === p
    );
  }

  /**
   * Handle polling errors with retry logic for network issues.
   * - 401 errors: Self-cleanup and delete connector (token invalid)
   * - Network errors (ETIMEDOUT, ECONNRESET, etc.): Retry with exponential backoff
   * - Other errors: Stop polling immediately
   */
  async #handlePollingError(error) {
    // Ignore errors while already waiting to retry
    if (this.#pollingRetry.timer) return;
    this.#log("Polling error:", error.message);

    // 401 = invalid token, cleanup and stop
    if (error.message?.includes("401")) {
      this.#log(
        "Got 401 - bot token invalid. Stopping and deleting connector."
      );
      return this.#selfCleanup("401 Unauthorized");
    }

    // For non-network errors, stop immediately, but don't delete the connector
    if (!this.#isNetworkError(error)) {
      this.#log(`Got HTTP error ${error.message}. Stopping polling.`);
      return await this.stop();
    }

    // Network error - attempt retry with exponential backoff
    const maxRetries = TelegramBotService.#MAX_POLLING_RETRIES;
    this.#pollingRetry.count++;
    if (this.#pollingRetry.count > maxRetries) {
      this.#log(
        `Network error. Max retries (${maxRetries}) exceeded. Stopping.`
      );
      this.#pollingRetry.count = 0;
      return await this.stop();
    }

    const delay = Math.min(
      TelegramBotService.#BASE_RETRY_DELAY_MS *
        Math.pow(2, this.#pollingRetry.count - 1),
      TelegramBotService.#MAX_RETRY_DELAY_MS
    );
    this.#log(
      `Network error. Retry ${this.#pollingRetry.count}/${maxRetries} in ${Math.round(delay / 1000)}s...`
    );

    this.#pollingRetry.timer = setTimeout(async () => {
      this.#pollingRetry.timer = null;
      if (!this.#bot || !this.#config) return;

      try {
        await this.#bot.stopPolling();
      } catch {}

      this.#log("Attempting to restart polling...");
      try {
        await this.#bot.startPolling();
        this.#log("Polling restarted successfully.");
      } catch (err) {
        this.#log("Failed to restart polling:", err.message);
        await this.stop();
      }
    }, delay);
  }

  /**
   * Clear pending updates on startup, keeping only the last user message per chat.
   * This prevents processing a backlog of messages when the bot restarts.
   * @returns {Promise<Map<number, object>>} Map of chatId -> last message to process
   */
  async #clearPendingUpdates() {
    const lastMessages = new Map();
    try {
      // Fetch all pending updates (up to 100)
      const updates = await this.#bot.getUpdates({ limit: 100, timeout: 0 });
      if (!updates || updates.length === 0) return lastMessages;

      this.#log(`Found ${updates.length} pending update(s) on startup`);

      // Find the last message per chat (including commands)
      for (const update of updates) {
        const msg = update.message;
        if (!msg) continue;

        const chatId = msg.chat.id;
        // Keep overwriting to get the last message per chat
        lastMessages.set(chatId, msg);
      }

      // Mark all updates as processed by requesting with offset past the last one
      const lastUpdateId = updates[updates.length - 1].update_id;
      await this.#bot.getUpdates({
        offset: lastUpdateId + 1,
        limit: 1,
        timeout: 0,
      });

      this.#log(
        `Cleared pending updates, will process ${lastMessages.size} last message(s)`
      );
    } catch (error) {
      this.#log("Failed to clear pending updates:", error.message);
    }
    return lastMessages;
  }

  async #registerCommands() {
    try {
      const commands = BOT_COMMANDS.map((c) => ({
        command: c.command,
        description: c.description,
      }));
      await this.#bot.setMyCommands(commands);
    } catch (error) {
      this.#log("Failed to register commands:", error.message);
    }
  }

  #getState(chatId) {
    if (!this.#chatState.has(chatId)) {
      this.#chatState.set(chatId, {
        workspaceSlug: this.#config.default_workspace,
        threadSlug: null,
      });
    }
    return this.#chatState.get(chatId);
  }

  #setState(chatId, updates) {
    const state = this.#getState(chatId);
    Object.assign(state, updates);
    this.#persistChatState(chatId, state);
  }

  async #persistChatState(chatId, state) {
    const approved = (this.#config.approved_users || []).map((u) => {
      if (String(u.chatId) === String(chatId)) {
        return {
          ...u,
          active_workspace: state.workspaceSlug,
          active_thread: state.threadSlug,
        };
      }
      return u;
    });
    this.#config.approved_users = approved;
    await ExternalCommunicationConnector.updateConfig("telegram", {
      approved_users: approved,
    });
  }

  /**
   * Build a context object that handler modules use to access
   * the bot instance, config, and state helpers.
   */
  #createContext() {
    return {
      bot: this.#bot,
      config: this.#config,
      getState: (chatId) => this.#getState(chatId),
      setState: (chatId, updates) => this.#setState(chatId, updates),
      log: (text, ...args) => this.#log(text, ...args),
    };
  }

  async approvePendingUser(chatId) {
    await approveUser(this.#bot, chatId, this.#config, this.#pendingPairings);
  }

  async denyPendingUser(chatId) {
    await denyUser(this.#bot, chatId, this.#pendingPairings);
  }

  async revokeExistingUser(chatId) {
    await revokeUser(chatId, this.#config);
  }

  /**
   * Reset the polling retry state and clear the timer if it exists.
   */
  #resetPollingRetry() {
    this.#pollingRetry.count = 0;
    if (this.#pollingRetry.timer) clearTimeout(this.#pollingRetry.timer);
    this.#pollingRetry.timer = null;
  }

  #setupHandlers() {
    const ctx = this.#createContext();
    // Track per-chat type ("private" | "group" | "supergroup" | "channel") so handlers don't need to re-read msg.chat.type
    const chatTypes = new Map();
    ctx._chatType = chatTypes;

    const guard = async (msg, handler) => {
      if (!this.#config) {
        this.#log("[MSG][DROPPED] no config");
        return;
      }
      this.#resetPollingRetry(); // Reset the polling on successful message receipt

      const chatId = msg.chat.id;
      const chatType = msg.chat.type;
      const senderId = msg.from?.id ?? "null";
      const senderName =
        msg.sender_chat?.title ?? msg.from?.first_name ?? "unknown";
      this.#log(
        `[IN] chat=${chatId} type=${chatType} from=${senderName}(#${senderId}) text="${(msg.text || "").slice(0, 80)}"`
      );

      chatTypes.set(chatId, chatType);

      // Groups: check if linked and whether message targets the bot
      this.#log(`[MSG] group? ${["group", "supergroup"].includes(chatType)}`);
      if (["group", "supergroup"].includes(chatType)) {
        const { isGroupLinked } = require("./utils/verification");
        const { linked, groupEntry: _groupEntry } = isGroupLinked(
          this.#config.linked_groups,
          chatId
        );
        this.#log(
          `[MSG] group(${chatId}) linked=${linked} config_keys=[${(this.#config.linked_groups || []).map((g) => g.chatId)}]`
        );

        if (!linked) {
          // Allow /link (with or without argument) to bypass the link check so a group can be linked in the first place
          const rawText = msg.text || "";
          if (rawText.startsWith("/link") || rawText.startsWith("/Link")) {
            this.#log(
              "[MSG] COMMAND detected -> running handler (link cmd on ungroup)"
            );
            handler.call(this, chatId);
            return;
          }
          this.#log("[MSG][DROPPED] not linked");
          return;
        }

        // Commands always run in linked groups
        if (msg.text?.startsWith("/")) {
          this.#log(`[MSG] COMMAND detected -> running handler`);
          handler.call(this, chatId);
          return;
        }

        // Non-command messages require @mention or /totem prefix.
        // Use the resolved username from the live API/config, not the SDK instance field.
        const { isDirectingToBot } = require("./utils/verification");
        const botUsername = this.#botUsername || this.#config.bot_username || "";
        const isDirected = isDirectingToBot(msg, botUsername);
        this.#log(`[MSG] text_mention=${isDirected} (botUser=@${botUsername})`);
        if (!isDirected) {
          // Save the non-directed message to thread history without responding.
          const senderName = msg.from?.first_name || msg.from?.username || "Unknown";
          this.#log(`[MSG] Archiving: ${senderName} says "${(msg.text || "").slice(0, 60)}"`);

          const workspace = await Workspace.get({
            slug: _groupEntry.workspaceSlug,
          });
          if (workspace) {
            try {
              await WorkspaceChats.new({
                workspaceId: workspace.id,
                prompt: `${senderName}: ${(msg.text || "").trim()}`,
                response: { text: "", sources: [], type: "group" },
                threadId: msg?.topic_message_thread_id || null,
              });
            } catch (err) {
              this.#log(`[MSG] Failed to archive message:`, err.message);
            }
          }
          return;
        }

        this.#log(`[MSG] running handler for @mention`);
        handler.call(this, chatId);
        return;
      }

      // Private chats: require approval
      const verified = isVerified(this.#config.approved_users, msg.chat.id);
      this.#log(
        `[MSG] private chat(${chatId}) verified=${verified} approved=[${(this.#config.approved_users || []).map((u) => u.chatId)}]`
      );
      if (!verified) {
        sendPairingRequest(this.#bot, msg, this.#pendingPairings);
        return;
      }

      this.#log(`[MSG] running handler for private chat`);
      handler.call(this, chatId);
    };

    // Register all commands (history is registered separately below)
    for (const command of BOT_COMMANDS) {
      if (command.skipAutoSetup) continue;
      const handler = command.initHandler();
      this.#bot.onText(new RegExp(`\\/${command.command}`), (msg) =>
        guard(msg, () => handler(ctx, msg.chat.id, msg.text))
      );
    }

    // Register /history separately so we can pass the message text for argument parsing
    // Ex: /history 25 shows last 25 messages
    this.#bot.onText(/\/history(.*)/, (msg) => {
      const handler = BOT_COMMANDS.find(
        (c) => c.command === "history"
      ).initHandler();
      guard(msg, () => handler(ctx, msg.chat.id, msg.text));
    });

    // Register /link and /unlink directly (group-only, skip auto-setup)
    this.#bot.onText(/\/link(.*)/, (msg) => {
      if (!["group", "supergroup"].includes(msg.chat.type)) return;
      const handler = BOT_COMMANDS.find(
        (c) => c.command === "link"
      )?.initHandler();
      // Telegram may send the command in either of these forms:
      //   /link <workspace>
      //   /link@BotUsername <workspace>
      // Strip the command prefix and optional mention suffix so only the workspace name is passed to the handler.
      const arg = (msg.text || "").replace(/^\/link(?:@[\w_]+)?\s*/i, "");
      if (!arg.trim()) {
        guard(msg, () =>
          ctx.bot.sendMessage(
            msg.chat.id,
            `<b>Usage:</b> <code>/link &lt;workspace name&gt;</code>\n\nThis links the current group to a workspace. Messages in this group (when @mentioning the bot) will be routed to that workspace.`
          )
        );
        return;
      }
      if (handler) guard(msg, () => handler(ctx, msg.chat.id, arg.trim()));
    });

    this.#bot.onText(/\/unlink$/, (msg) => {
      if (!["group", "supergroup"].includes(msg.chat.type)) return;
      const handler = BOT_COMMANDS.find(
        (c) => c.command === "unlink"
      )?.initHandler();
      if (handler) guard(msg, () => handler(ctx, msg.chat.id));
    });

    // When bot is removed from a group, clean up state
    this.#bot.on("left_chat_member", (msg) => {
      if (!this.#myUserId) return;
      if (msg.left_chat_member?.id !== this.#myUserId) return;
      const chatId = msg.chat.id;
      this.#chatState.delete(chatId);
      this.#log(`Bot removed from group ${chatId} - state cleared`);

      // Also remove from linked_groups config
      const groups = (this.#config.linked_groups || []).filter(
        (g) => String(g.chatId) !== String(chatId)
      );
      if (groups.length < (this.#config.linked_groups || []).length) {
        ExternalCommunicationConnector.updateConfig("telegram", {
          linked_groups: groups,
        })
          .then(() => {
            this.#config.linked_groups = groups;
            this.#log(`Removed group ${chatId} from linked_groups config`);
          })
          .catch((err) => {
            this.#log(
              `Failed to update linked_groups for group removal:`,
              err.message
            );
          });
      }
    });

    // Register callback queries, used for workspace/thread selection, tool approval, etc.
    this.#bot.on("callback_query", (query) =>
      handleKeyboardQueryCallback(ctx, query, {
        pendingToolApprovals: this.#pendingToolApprovals,
        log: this.#log.bind(this),
      })
    );

    this.#bot.on("message", (msg) => {
      if (msg.text?.startsWith("/")) return;
      guard(msg, () => this.#handleMessage(ctx, msg));
    });

    this.#bot.on("polling_error", (error) => {
      this.#handlePollingError(error);
    });
  }

  async #runChatJob(ctx, chatId, payload) {
    const state = this.#getState(chatId);
    try {
      const bgService = new BackgroundService();
      const jobId = `handle-telegram-chat-${Date.now()}`;
      let invocationUuid = null;
      let wasAborted = false;

      await bgService.bree.add({
        name: jobId,
        path: require("path").resolve(
          __dirname,
          "../../jobs/handle-telegram-chat.js"
        ),
      });

      await bgService.bree.run(jobId);
      const worker = bgService.bree.workers.get(jobId);

      const msg = ctx.message;
      if (worker && typeof worker.send === "function") {
        worker.send({
          botToken: this.#config.bot_token,
          chatId,
          messageThreadId: msg?.topic_message_thread_id || null,
          workspaceSlug: state.workspaceSlug,
          threadSlug: state.threadSlug,
          ...payload,
        });
      }

      if (worker) {
        worker.on("message", (msg) => {
          if (msg?.type === "closeInvocation") invocationUuid = msg.uuid;
          if (msg?.type === "toolApprovalRequest") {
            this.#handleToolApprovalRequest(worker, msg);
          }
        });
        this.#activeWorkers.set(chatId, { worker, jobId, bgService });
      }

      await new Promise((resolve, reject) => {
        worker.on("exit", async (code) => {
          this.#activeWorkers.delete(chatId);
          try {
            await bgService.bree.remove(jobId);
          } catch {}
          if (code === 0 || wasAborted) resolve();
          else reject(new Error(`Job ${jobId} exited with code ${code}`));
        });

        worker.on("error", async (err) => {
          this.#activeWorkers.delete(chatId);
          try {
            await bgService.bree.remove(jobId);
          } catch {}
          reject(err);
        });

        const active = this.#activeWorkers.get(chatId);
        if (active) {
          active.markAborted = () => {
            wasAborted = true;
          };
        }
      });

      if (invocationUuid) await WorkspaceAgentInvocation.close(invocationUuid);
    } catch (error) {
      this.#activeWorkers.delete(chatId);
      if (error.message?.includes("aborted")) return;
      this.#log("Chat worker error:", error.message);
      await ctx.bot.sendMessage(
        chatId,
        "Sorry, something went wrong. Please try again."
      );
    }
  }

  /**
   * Abort any active LLM worker for a given chat.
   * @param {number} chatId
   * @returns {boolean} True if a worker was aborted, false otherwise.
   */
  abortChat(chatId) {
    const active = this.#activeWorkers.get(chatId);
    if (!active) return false;

    const { worker, jobId, bgService, markAborted } = active;
    this.#log(`Aborting worker for chat ${chatId} (job: ${jobId})`);

    if (markAborted) markAborted();

    try {
      worker.kill("SIGTERM");
    } catch (err) {
      this.#log(`Failed to kill worker: ${err.message}`);
    }

    this.#activeWorkers.delete(chatId);

    try {
      bgService.bree.remove(jobId).catch(() => {});
    } catch {}

    return true;
  }

  /**
   * Handle a tool approval request from a worker process.
   * Sends a Telegram message with Approve/Deny inline keyboard buttons.
   * @param {Worker} worker - The worker process requesting approval
   * @param {Object} msg - The tool approval request message
   */
  async #handleToolApprovalRequest(worker, msg) {
    const { requestId, chatId, skillName, payload, description, timeoutMs } =
      msg;

    this.#log(
      `Tool approval request received: ${skillName} (requestId: ${requestId})`
    );

    try {
      const payloadText =
        payload && Object.keys(payload).length > 0
          ? `\n\n<b>Parameters:</b>\n<code>${JSON.stringify(payload, null, 2)}</code>`
          : "";

      const descText = description ? `\n${description}` : "";

      const messageText =
        `🔧 <b>Tool Approval Required</b>\n\n` +
        `The agent wants to execute: <b>${skillName}</b>${descText}${payloadText}\n\n` +
        `Do you want to allow this action?`;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: "✅ Approve",
              callback_data: `tool:approve:${requestId}`,
            },
            { text: "❌ Deny", callback_data: `tool:deny:${requestId}` },
          ],
        ],
      };

      const sent = await this.#bot.sendMessage(chatId, messageText, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });

      this.#pendingToolApprovals.set(requestId, {
        worker,
        chatId,
        messageId: sent.message_id,
        skillName,
      });

      // Auto-cleanup if timeout expires (worker will also timeout)
      setTimeout(() => {
        if (this.#pendingToolApprovals.has(requestId)) {
          this.#pendingToolApprovals.delete(requestId);
          this.#bot
            .editMessageText(
              `⏱️ Tool approval for <b>${skillName}</b> timed out.`,
              {
                chat_id: chatId,
                message_id: sent.message_id,
                parse_mode: "HTML",
              }
            )
            .catch(() => {});
        }
      }, timeoutMs + 1000);
    } catch (error) {
      this.#log("Failed to send tool approval request:", error.message);
      // Send denial back to worker if we can't show the UI
      try {
        const response = {
          type: "toolApprovalResponse",
          requestId,
          approved: false,
        };
        if (worker && typeof worker.send === "function") {
          worker.send(response);
        } else if (worker && typeof worker.postMessage === "function") {
          worker.postMessage(response);
        }
      } catch {}
    }
  }

  #shouldVoiceRespond(isVoiceMessage) {
    if (!this.#config) return false;
    const mode = this.#config.voice_response_mode || "text_only";
    if (mode === "always_voice") return true;
    if (mode === "mirror" && isVoiceMessage) return true;
    return false;
  }

  #handleMessage(ctx, msg) {
    const chatId = msg.chat.id;

    // Voice messages: transcribe then send to LLM
    if (msg.voice || msg.audio) {
      this.#queue.enqueue(chatId, async () => {
        try {
          const audioInfo = msg.voice || msg.audio;
          const fileId = audioInfo.file_id;
          const mimeType = audioInfo.mime_type || "audio/ogg";
          await ctx.bot.sendChatAction(chatId, "typing");
          const audioBuffer = await downloadTelegramFile(ctx.bot, fileId);
          const transcription = await transcribeAudio(audioBuffer, mimeType);
          if (!transcription?.trim()) {
            await ctx.bot.sendMessage(
              chatId,
              "Could not transcribe the voice message."
            );
            return;
          }
          await this.#runChatJob(ctx, chatId, {
            message: transcription,
            voiceResponse: this.#shouldVoiceRespond(true),
          });
        } catch (error) {
          this.#log("Voice handling error:", error.message);
          const isConfigError =
            error.message.includes("transcription") ||
            error.message.includes("Whisper") ||
            error.message.includes("OpenAI");
          await ctx.bot.sendMessage(
            chatId,
            isConfigError
              ? error.message
              : "Failed to process voice message. Please try again."
          );
        }
      });
      return;
    }

    // Photo messages: extract image and send to LLM with vision
    if (msg.photo) {
      this.#queue.enqueue(chatId, async () => {
        try {
          await ctx.bot.sendChatAction(chatId, "typing");
          const attachment = await photoToAttachment(ctx.bot, msg.photo);
          await this.#runChatJob(ctx, chatId, {
            message: msg.caption || "Describe this image.",
            attachments: [attachment],
            voiceResponse: this.#shouldVoiceRespond(false),
          });
        } catch (error) {
          this.#log("Photo handling error:", error.message);
          await ctx.bot.sendMessage(
            chatId,
            "Failed to process the image. Please try again."
          );
        }
      });
      return;
    }

    // Document messages: parse and send extracted text to LLM
    if (msg.document) {
      this.#queue.enqueue(chatId, async () => {
        try {
          await ctx.bot.sendChatAction(chatId, "typing");
          const filename = msg.document.file_name || "document";
          const docBuffer = await downloadTelegramFile(
            ctx.bot,
            msg.document.file_id
          );
          const { text, filename: docName } = await documentToText(
            docBuffer,
            filename
          );

          const userPrompt = msg.caption?.trim()
            ? msg.caption.trim()
            : "Summarize this document.";
          const fullMessage = `The user has shared a document named "${docName}". Here is the extracted content:\n\n---\n${text}\n---\n\nUser's request: ${userPrompt}`;

          await this.#runChatJob(ctx, chatId, {
            message: fullMessage,
            voiceResponse: this.#shouldVoiceRespond(false),
          });
        } catch (error) {
          this.#log("Document handling error:", error.message);
          await ctx.bot.sendMessage(
            chatId,
            error.message.includes("collector")
              ? error.message
              : "Failed to process the document. Please try again."
          );
        }
      });
      return;
    }

    if (!msg.text) return;
    this.#queue.enqueue(chatId, async () => {
      await this.#runChatJob(ctx, chatId, {
        message: msg.text,
        voiceResponse: this.#shouldVoiceRespond(false),
      });
    });
  }

  /**
   * Verify a bot token with the Telegram API without starting polling.
   */
  static async verifyToken(token) {
    try {
      const bot = new TelegramBot(token, { polling: false });
      const me = await bot.getMe();
      return { valid: true, username: me.username, error: null };
    } catch (error) {
      return { valid: false, username: null, error: error.message };
    }
  }

  /**
   * Boot the bot from database config on server startup.
   * Decrypts the stored bot token before starting.
   * @returns {Promise<void>}
   */
  static async bootIfActive() {
    const service = new TelegramBotService();
    try {
      const connector = await ExternalCommunicationConnector.get("telegram");
      if (!connector || !connector.active || !connector.config.bot_token)
        return;

      const config = { ...connector.config };
      config.bot_token = decryptToken(config.bot_token);
      if (!config.bot_token) {
        console.log(
          "\x1b[35m[TelegramBot]\x1b[0m Failed to decrypt bot token. Re-connect to fix."
        );
        return;
      }

      await service.start(config);
    } catch (error) {
      console.log(
        "\x1b[35m[TelegramBot]\x1b[0m Failed to boot:",
        error.message
      );
    }
  }
}

module.exports = { TelegramBotService };
