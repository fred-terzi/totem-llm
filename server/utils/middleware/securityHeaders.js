/**
 * Minimal, dependency-free security header middleware.
 *
 * Applied API-wide before all routes. Static frontend serving additionally
 * sets X-Frame-Options: DENY in server/index.js.
 *
 * CSP is intentionally NOT set here yet — the React frontend uses inline
 * styles and Vite-bundled assets; a strict CSP needs dedicated frontend
 * testing before rollout (tracked as a follow-up in the pre-beta checklist).
 */
function securityHeaders(_request, response, next) {
  // Force browsers to use HTTPS for this host + subdomains for 1 year,
  // including embedded subresources. Only meaningful over HTTPS; harmless
  // over HTTP (ignored by browsers on plain HTTP origins).
  response.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  );
  // Prevent MIME-type sniffing.
  response.setHeader("X-Content-Type-Options", "nosniff");
  // Don't leak referrer to third parties loaded from the app.
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Disable FLoC / interest-cohort advertising surface.
  response.setHeader("Permissions-Policy", "interest-cohort=()");
  // Defensive framing protection for API responses (static files override
  // with DENY explicitly already).
  response.setHeader("X-Frame-Options", "DENY");
  next();
}

module.exports = securityHeaders;
