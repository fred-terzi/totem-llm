/**
 * Totem LLM Feature Manifest
 *
 * This file is the single source of truth for which features are available
 * in each build of Totem LLM. It is read by:
 *   - Vite at build time (baked into the frontend bundle as __TOTEM_FEATURES__)
 *   - The Node.js server at runtime (for API route gating)
 *
 * To select a profile, set the TOTEM_BUILD_PROFILE environment variable
 * before building or running the server. Defaults to "npm" if unset.
 *
 *   TOTEM_BUILD_PROFILE=source yarn build
 *
 * ─── Tiers ────────────────────────────────────────────────────────────────────
 *   free      Available in all build profiles where the feature is enabled.
 *   standard  Intended for paid or higher-tier builds (future enforcement).
 *   premium   Intended for premium paid builds (future enforcement).
 *
 * ─── Adding a new feature ─────────────────────────────────────────────────────
 *   1. Add the key to the `FEATURE_DEFINITIONS` object below.
 *   2. Set `enabled: false` in any profile where it should be hidden.
 *   3. Use `useFeatureFlag('yourKey')` in React components to gate UI.
 *   4. Use `requireFeature('yourKey')` middleware on server routes to gate APIs.
 */

/** @typedef {{ label: string, tier: 'free'|'standard'|'premium' }} FeatureDef */

/**
 * Master list of every feature Totem LLM knows about.
 * Keys are used throughout the codebase — treat them as stable identifiers.
 *
 * @type {Record<string, FeatureDef>}
 */
const FEATURE_DEFINITIONS = {
  communityHub: {
    label: "Community Hub",
    tier: "premium",
  },
  modelRouter: {
    label: "Model Router",
    tier: "standard",
  },
};

/**
 * Build profiles — define which features are enabled for each build target.
 * Add a new profile object here when you need a new distribution variant.
 *
 * @type {Record<string, Record<string, boolean>>}
 */
const PROFILES = {
  /** Default npm / Docker release — minimal feature set */
  npm: {
    communityHub: false,
    modelRouter: false,
  },

  /** Future free-tier desktop app */
  "desktop-free": {
    communityHub: false,
    modelRouter: true,
  },

  /** Future paid desktop app */
  "desktop-premium": {
    communityHub: true,
    modelRouter: true,
  },

  /** Full source build — mirrors upstream AnythingLLM capabilities */
  source: {
    communityHub: true,
    modelRouter: true,
  },
};

/**
 * Resolves the active feature map for the current TOTEM_BUILD_PROFILE.
 * Each entry is the feature definition merged with its enabled state.
 *
 * @returns {Record<string, { label: string, tier: string, enabled: boolean }>}
 */
function resolveFeatures() {
  const profileName = process.env.TOTEM_BUILD_PROFILE || "npm";
  const profile = PROFILES[profileName];

  if (!profile) {
    const valid = Object.keys(PROFILES).join(", ");
    throw new Error(
      `[totem.features] Unknown TOTEM_BUILD_PROFILE "${profileName}". Valid profiles: ${valid}`
    );
  }

  const resolved = {};
  for (const [key, def] of Object.entries(FEATURE_DEFINITIONS)) {
    resolved[key] = {
      label: def.label,
      tier: def.tier,
      // Default to false for safety if a feature is missing from the profile
      enabled: profile[key] === true,
    };
  }
  return resolved;
}

module.exports = { resolveFeatures, FEATURE_DEFINITIONS, PROFILES };
