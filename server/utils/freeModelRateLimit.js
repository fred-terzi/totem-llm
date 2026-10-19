/**
 * F8 — upstream rate-limit mapping for the default-user "Totem Free"
 * inference option (spec: totem_docs/default-user-inference-options).
 *
 * There is no Totem-side rate limit on Option 1 (N2). When the upstream
 * OpenRouter free tier returns HTTP 429, that error is detected at the first
 * catch site and rethrown carrying a stable marker; the marker is mapped to
 * the exact F8 wording at the points where agent/chat errors reach the
 * client (the aibitat `websocket` plugin's onError handler and the `chat.js`
 * SSE catch blocks). Unmapped errors keep the standard error shape (N5).
 *
 * The marker is a plain substring of the error message rather than a custom
 * error class because the agent path stringifies errors twice on the way to
 * the socket (provider catch → `RetryError`/`APIError` wrapping in AIbitat's
 * `#safeProviderCall` → `error.message` on the socket) — a class would not
 * survive that round-trip.
 *
 * Detection is deliberately narrow: only the OpenAI-SDK 429 shape (status,
 * error name, or "429 …" message prefix) matches, and mapping to the F8
 * wording additionally requires the affected model to be the *currently
 * configured* free-option slug (checked per request against
 * `system_settings` via the inference-options registry) — an admin hitting a
 * rate limit on a paid OpenRouter model keeps the standard error.
 */
const FREE_MODEL_RATE_LIMIT_MARKER = "[totem_free_model_rate_limited]";

/** Exact F8 wording — the only rate-limit message a user can see (N5). */
const FREE_MODEL_RATE_LIMIT_MESSAGE =
  "The free model is rate-limited right now. Switch to Anonymous or E2EE inference to continue.";

/**
 * Detect an upstream HTTP 429 / rate-limit error. Matches the OpenAI SDK
 * `RateLimitError` shapes surfaced by both OpenRouter code paths
 * (`server/utils/AiProviders/openRouter` and the aibitat provider): an
 * explicit `status`, the error class name, or an SDK-generated "429 …"
 * message prefix.
 *
 * @param {Error|{status?:number,name?:string,message?:string}|string|null} error
 * @returns {boolean}
 */
function isUpstreamRateLimitError(error) {
  if (!error) return false;
  if (Number(error.status) === 429) return true;
  if (error.name === "RateLimitError") return true;
  const message = typeof error === "string" ? error : error.message;
  return typeof message === "string" && /\b429\b/.test(message);
}

/**
 * Embed the stable marker into an error message so it survives the
 * agent path's error re-wrapping.
 * @param {string} originalMessage
 * @returns {string}
 */
function markFreeModelRateLimit(originalMessage = "") {
  return `${FREE_MODEL_RATE_LIMIT_MARKER} ${originalMessage}`.trim();
}

/**
 * @param {string|null} message
 * @returns {boolean} true when the message carries the F8 marker.
 */
function isFreeModelRateLimitMessage(message) {
  return (
    typeof message === "string" &&
    message.includes(FREE_MODEL_RATE_LIMIT_MARKER)
  );
}

/**
 * Client-facing mapping: a marker-carrying message becomes the exact F8
 * wording (replacing any surrounding wrapper text such as "The agent model
 * failed to respond: …"); every other message passes through unchanged.
 * @param {string|null} message
 * @returns {string|null}
 */
function mapFreeModelRateLimitMessage(message) {
  return isFreeModelRateLimitMessage(message)
    ? FREE_MODEL_RATE_LIMIT_MESSAGE
    : message;
}

/**
 * Throw-site helper shared by both OpenRouter code paths. When the caught
 * error is an upstream 429 AND the affected model is the currently
 * configured free-option slug, returns a new Error carrying the marker;
 * otherwise returns null so the caller keeps its existing error handling.
 *
 * Registry resolution failures downgrade to null (fail-open to the standard
 * error shape — never mask an error with a wrong mapping, N5).
 *
 * @param {Error} error - the caught upstream error
 * @param {string|null} model - the model slug the request was made with
 * @returns {Promise<Error|null>}
 */
async function freeOptionRateLimitError(error, model = null) {
  if (!isUpstreamRateLimitError(error)) return null;
  try {
    const { isConfiguredFreeSlug } = require("./inferenceOptions");
    if (await isConfiguredFreeSlug(model)) {
      return new Error(
        markFreeModelRateLimit(error?.message || "Upstream rate limit.")
      );
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = {
  FREE_MODEL_RATE_LIMIT_MARKER,
  FREE_MODEL_RATE_LIMIT_MESSAGE,
  isUpstreamRateLimitError,
  markFreeModelRateLimit,
  isFreeModelRateLimitMessage,
  mapFreeModelRateLimitMessage,
  freeOptionRateLimitError,
};
