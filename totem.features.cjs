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
 *   L1   Available in all build profiles where the feature is enabled.
 *   L2   Reserved for a additional tiers of builds (future enforcement).
 *
 * ─── Adding a new feature ─────────────────────────────────────────────────────
 *   1. Add the key to the `FEATURE_DEFINITIONS` object below.
 *   2. Set `enabled: false` in any profile where it should be hidden.
 *   3. Use `useFeatureFlag('yourKey')` in React components to gate UI.
 *   4. Use `requireFeature('yourKey')` middleware on server routes to gate APIs.
 */

/** @typedef {{ label: string, tier: 'L1'|'L2'|'L3' }} FeatureDef */

/**
 * Master list of every feature Totem LLM knows about.
 * Keys are used throughout the codebase — treat them as stable identifiers.
 *
 * Boolean features: profile value is `true` (enabled) or `false` (disabled).
 * List features:    profile value is an array (enabled + restricted to listed values),
 *                   `null` (enabled, no restriction), or `false` (disabled entirely).
 *
 * @type {Record<string, FeatureDef>}
 */
const FEATURE_DEFINITIONS = {
  communityHub: {
    label: "Community Hub",
    tier: "L2",
  },
  modelRouter: {
    label: "Model Router",
    tier: "L2",
  },
  /**
   * Controls which LLM providers appear in the provider dropdown.
   * Profile value:
   *   null           → show all providers (no restriction)
   *   ['ollama', …]  → show only the listed provider values
   *   false          → disable the feature entirely (hides all — avoid unless intentional)
   */
  llmProviders: {
    label: "LLM Provider Allowlist",
    tier: "L1",
  },
  brandingWhitelabel: {
    label: "Branding & Whitelabeling",
    tier: "L2",
  },
  /**
   * Controls whether the File System Access agent skill is available.
   * When enabled, agents can read, write, and manage files on the host filesystem.
   */
  filesystemAgent: {
    label: "File System Access",
    tier: "L2",
  },
  /**
   * Controls whether the documentation link is visible in the footer.
   * When disabled, the help docs link is hidden from the UI.
   */
  documentationLink: {
    label: "Documentation Link",
    tier: "L2",
  },
  /**
   * Multi-User Mode: when enabled, users can create accounts and have personalized settings.
   */
  multiUser: {
    label: "Multi-User Mode",
    tier: "L2",
  },
  /**
   * Totem LLM Mobile: This is entirely AnythingLLM mobile, it needs to be disabled. 
   */
  mobile: {
    label: "Totem LLM Mobile",
    tier: "L2",
  },
};

/**
 * Build profiles — define which features are enabled for each build target.
 * Add a new profile object here when you need a new distribution variant.
 *
 * @type {Record<string, Record<string, boolean>>}
 */
const PROFILES = {
  /** Default npm — minimal feature set */
  npm: {
    communityHub: false,
    modelRouter: false,
    llmProviders: ["ollama", "openrouter"],
    brandingWhitelabel: false,
    filesystemAgent: true,
    documentationLink: false,
    multiUser: false,
    mobile: false,
  },

  /** Future L1-tier build — includes all features for testing and iteration before wider release */
  "L1": {
    communityHub: false,
    modelRouter: true,
    llmProviders: ["ollama", "openrouter"], 
    filesystemAgent: true,
    documentationLink: false,
    multiUser: false,
    mobile: false,
  },

  /** Future L2-tier build — includes all features for testing and iteration before wider release */
  "L2": {
    communityHub: true,
    modelRouter: true,
    llmProviders: ["ollama", "openrouter"],
    brandingWhitelabel: true,
    filesystemAgent: true,
    documentationLink: true,
    multiUser: false,
    mobile: false,
  },

  /** Full source build — mirrors upstream AnythingLLM capabilities */
  source: {
    communityHub: true,
    modelRouter: true,
    llmProviders: ["ollama", "openrouter"],
    brandingWhitelabel: true,
    filesystemAgent: true,
    documentationLink: true,
    multiUser: true,
    mobile: false,
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
