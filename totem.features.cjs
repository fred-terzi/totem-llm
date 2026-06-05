/**
 * Totem LLM Feature Manifest
 *
 * This file reads feature definitions and profiles from config/totem.features.json.
 * It is read by:
 *   - Vite at build time (baked into the frontend bundle as __TOTEM_FEATURES__)
 *   - The Node.js server at runtime (for API route gating)
 *
 * To select a profile, set the TOTEM_BUILD_PROFILE environment variable
 * before building or running the server. Defaults to "npm" if unset.
 *
 *   TOTEM_BUILD_PROFILE=source yarn build
 *
 * ─── Adding a new feature ─────────────────────────────────────────────────────
 *   1. Add the key to `FEATURE_DEFINITIONS` in config/totem.features.json
 *   2. Set `enabled: false` in any profile where it should be hidden.
 *   3. Use `useFeatureFlag('yourKey')` in React components to gate UI.
 *   4. Use `requireFeature('yourKey')` middleware on server routes to gate APIs.
 */

const path = require('path');
const { FEATURE_DEFINITIONS, PROFILES } = require('./config/totem.features.json');

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
    const profileValue = profile[key];
    // Arrays and null signal a list-type feature (enabled with optional restriction).
    // false or missing signals a boolean feature that is disabled.
    const isListFeature = Array.isArray(profileValue) || profileValue === null;
    resolved[key] = {
      label: def.label,
      tier: def.tier,
      enabled: isListFeature ? true : profileValue === true,
      // `allowlist` is null (no restriction) or a string[] of permitted values
      allowlist: isListFeature ? (Array.isArray(profileValue) ? profileValue : null) : null,
    };
  }
  return resolved;
}

module.exports = { resolveFeatures, FEATURE_DEFINITIONS, PROFILES };
