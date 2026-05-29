/**
 * requireFeature(key) — Totem LLM build-time feature gate middleware
 *
 * Returns a 404 for any route that belongs to a feature disabled in the
 * current TOTEM_BUILD_PROFILE. This keeps API surface consistent with
 * the frontend: if the UI is hidden, the API is unavailable too.
 *
 * Usage (in an endpoints file):
 *   const { requireFeature } = require("../utils/middleware/requireFeature");
 *
 *   function myEndpoints(app) {
 *     if (!app) return;
 *     app.use("/my-feature", requireFeature("myFeature"));
 *     app.get("/my-feature", ...);
 *   }
 *
 * Note: Because this is open-source, this middleware is a UX guard, not a
 * security boundary. For paid/licensed features, add a separate license-check
 * middleware on top of this one.
 */

const { resolveFeatures } = require("../../../totem.features.cjs");

// Resolve once at startup — not per-request — since the value is build-time.
let _resolvedFeatures = null;
function getFeatures() {
  if (!_resolvedFeatures) _resolvedFeatures = resolveFeatures();
  return _resolvedFeatures;
}

/**
 * @param {string} key - Feature key from totem.features.js
 * @returns {import("express").RequestHandler}
 */
function requireFeature(key) {
  return function totemFeatureGate(_req, res, next) {
    const features = getFeatures();
    const feature = features[key];
    if (!feature || !feature.enabled) {
      return res.sendStatus(404).end();
    }
    next();
  };
}

module.exports = { requireFeature };
