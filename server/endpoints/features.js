const { resolveFeatures } = require("../../totem.features.cjs");

function featureEndpoints(app) {
  if (!app) return;

  /**
   * GET /api/features
   * Returns the resolved feature flags for the current build profile.
   * This is the runtime source of truth for the frontend.
   */
  app.get("/features", (_, response) => {
    try {
      const features = resolveFeatures();
      return response.status(200).json({ features });
    } catch (e) {
      console.error("[features] Failed to resolve features:", e.message);
      return response.status(500).json({ features: {}, error: e.message });
    }
  });
}

module.exports = { featureEndpoints };
