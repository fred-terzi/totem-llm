const { isVerified, isGroupLinked } = require("../verification");
const { resolveCallbackHandler } = require("./callbacks");

/**
 * Handle inline keyboard callback queries (workspace/thread selection, tool approval, etc).
 * @param {BotContext} ctx
 * @param {object} query - Telegram callback query object
 * @param {object} [options={}] - Optional dependencies that specific handlers may need
 */
async function handleKeyboardQueryCallback(ctx, query, options = {}) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // Allow both verified users (private chats) and linked groups
  const verified = isVerified(ctx.config.approved_users, chatId);
  const groupLinked = isGroupLinked(ctx.config.linked_groups, chatId).linked;

  if (!verified && !groupLinked) {
    await ctx.bot.answerCallbackQuery(query.id, {
      text: "You are not approved.",
    });
    return;
  }

  try {
    const handler = resolveCallbackHandler(data);
    if (!handler) throw new Error(`Callback handler not found: ${data}`);
    await handler({ ctx, chatId, query, messageId, data, ...options });
  } catch (error) {
    ctx.log("Callback error:", error.message);
    await ctx.bot.answerCallbackQuery(query.id, {
      text: "Something went wrong.",
    });
  }
}

module.exports = {
  handleKeyboardQueryCallback,
};
