/**
 * Simple in-memory, per-IP rate limiter middleware.
 *
 * Intended for public, unauthenticated endpoints (e.g. the future public
 * email-registration endpoint) where abuse deterrence matters but no auth
 * identity exists to key off of.
 *
 * Design mirrors the wallet endpoint's in-memory nonce store: a module-level
 * `Map` with periodic cleanup, no external dependencies, and process-local
 * state (acceptable for a single-process SQLite-backed deployment; if the
 * server ever scales horizontally this should move to Redis or similar).
 *
 * Configuration via env vars (read once at module load):
 *   PUBLIC_SIGNUP_RATE_LIMIT      — max requests per window per IP (default 5)
 *   PUBLIC_SIGNUP_RATE_WINDOW_MS  — window length in ms (default 1 hour)
 */

const hitCounts = new Map(); // ip → { count, windowStart }
const CLEANUP_INTERVAL_MS = 60_000;

const MAX_HITS = parseInt(process.env.PUBLIC_SIGNUP_RATE_LIMIT || "5", 10);
const WINDOW_MS = parseInt(
  process.env.PUBLIC_SIGNUP_RATE_WINDOW_MS || String(60 * 60 * 1000),
  10
);

// Periodically sweep expired windows so the Map cannot grow unboundedly.
// Unref'd so the timer never keeps the process (or jest) alive on its own.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hitCounts) {
    if (now - entry.windowStart > WINDOW_MS) hitCounts.delete(ip);
  }
}, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

/**
 * Resolve the client IP for rate-limit keying.
 * Prefers the standard `X-Forwarded-For` first hop when present (reverse-proxy
 * deployments), falling back to the socket address. Note: X-Forwarded-For is
 * client-controllable when no proxy strips it, so spoofed headers can rotate
 * the bucket — acceptable for deterrence purposes; a deployment behind a
 * trusted proxy gets correct per-client limiting.
 * @param {import('express').Request} request
 * @returns {string}
 */
function clientIp(request) {
  const forwarded = request.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return request.ip || request.socket?.remoteAddress || "unknown";
}

/**
 * Express middleware factory.
 * @param {object} [options]
 * @param {number} [options.max] - Override max hits per window.
 * @param {number} [options.windowMs] - Override window length in ms.
 * @param {string} [options.message] - Rejection body message.
 * @returns {(request: import('express').Request, response: import('express').Response, next: Function) => Promise<void>}
 */
function rateLimiter(options = {}) {
  const max = options.max ?? MAX_HITS;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const message =
    options.message || "Too many attempts. Please try again later.";

  return async function (request, response, next) {
    const ip = clientIp(request);
    const now = Date.now();

    let entry = hitCounts.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
      hitCounts.set(ip, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      response.status(429).json({ error: message });
      return;
    }

    next();
    return;
  };
}

/** Test/diagnostic helper: clear all buckets. */
function resetRateLimiter() {
  hitCounts.clear();
}

module.exports = {
  rateLimiter,
  resetRateLimiter,
  clientIp,
};
