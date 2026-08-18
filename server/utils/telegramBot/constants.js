/**
 * Minimum interval between Telegram message edits (ms) to avoid rate limiting
 * https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
 */
const STREAM_EDIT_INTERVAL = 1_200;

/**
 * Interval for refreshing draft before it expires (ms).
 * Telegram drafts are ephemeral and auto-expire after ~30s, but we
 * refresh at 1.5× the old edit interval to stay ahead of that window.
 */
const DRAFT_REFRESH_INTERVAL = 1_200;

/**
 * Telegram messages cap at 4096 chars. We use 4000 to leave headroom
 * so we can finalize the current message and continue in a new one.
 */
const MAX_MSG_LEN = 4000;

/**
 * The cursor character to use for streaming responses.
 * Looks like a blinking block, but doesn't actually blink.
 */
const CURSOR_CHAR = "\u258d";

/**
 * Incrementing counter seed for per-stream draft IDs.
 * Each stream gets its own draft_id so concurrent chats don't collide.
 */
let draftIdSeed = Math.floor(Math.random() * 1_000_000);

function nextDraftId() {
  return ++draftIdSeed;
}

module.exports = {
  STREAM_EDIT_INTERVAL,
  DRAFT_REFRESH_INTERVAL,
  MAX_MSG_LEN,
  CURSOR_CHAR,
  nextDraftId,
};
