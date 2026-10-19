/**
 * Default-user inference options registry (spec: totem_docs/default-user-inference-options).
 *
 * Defines the three curated inference options a `default`-role user can pick
 * for a workspace, and resolves each option key to a concrete (provider,
 * model) pair at request time from `system_settings` (spec F11/N6 — slugs are
 * admin-changeable without a restart; selections store the option key, F5).
 *
 * Consumers:
 *  - `POST /workspace/:slug/inference-option` (F13) — allowlist validation via
 *    `isValidOptionKey`.
 *  - `GET /system/inference-options` (F14) — picker payload via `listInferenceOptions`.
 *  - `GET|POST /admin/inference-options` (F11) — admin slug configuration.
 *  - Step 3 routing override (F12) — `resolveOption` in the agent path and
 *    `resolveProviderConnector`.
 *
 * Rate/billing note: billing is keyed on the model slug actually used
 * (`server/models/credits.js` `MODEL_RATES`). The free slug MUST stay mapped
 * to 0/0 rates there while it is the configured free option.
 */
const { SystemSettings } = require("../models/systemSettings");

const OPTION_KEYS = {
  FREE: "totem-free",
  ANON: "totem-anon",
  E2EE: "totem-e2ee",
};

/**
 * The option registry. Order defines picker display order (spec F1).
 *
 * - `provider` is the Totem provider id used to build the LLM connector
 *   (`getLLMProvider` / aibitat provider map) for this option.
 * - `settingLabel` is the `system_settings` label holding the admin-configured
 *   model slug (F11).
 * - `fallbackSlug` is the seeded initial slug (F11) — used when the setting is
 *   unset, and written to `system_settings` on first read (N6 seeding).
 * - `isAvailable` gates picker visibility (F14). Option 1 requires the
 *   OpenRouter key (`OpenRouterLLM` throws without it); Options 2/3 require
 *   the Venice key.
 */
const INFERENCE_OPTIONS = [
  {
    key: OPTION_KEYS.FREE,
    label: "Totem Free",
    description:
      "Runs on a free community model. No credits are used, but free models can be rate-limited and may run without agent tools.",
    provider: "openrouter",
    settingLabel: "default_user_inference_option_free",
    fallbackSlug: "nvidia/nemotron-3.5-lightning:free",
    isAvailable: () => !!process.env.OPENROUTER_API_KEY,
  },
  {
    key: OPTION_KEYS.ANON,
    label: "Totem Anon",
    description:
      "Runs on Venice AI anonymously — your chats are not attributable to you upstream. Credits are charged per token.",
    provider: "venice",
    settingLabel: "default_user_inference_option_anon",
    fallbackSlug: "z-ai-glm-5-3-flash",
    isAvailable: () => !!process.env.VENICE_API_KEY,
  },
  {
    key: OPTION_KEYS.E2EE,
    label: "Totem e2ee",
    description:
      "Runs on Venice AI's end-to-end encrypted private-compute endpoint. Credits are charged per token.",
    provider: "venice",
    settingLabel: "default_user_inference_option_e2ee",
    fallbackSlug: "e2ee-glm-5-3-flash",
    isAvailable: () => !!process.env.VENICE_API_KEY,
  },
];

/**
 * @param {string} optionKey
 * @returns {boolean} true iff `optionKey` is a registry option key (allowlist
 * for the F13 write endpoint — unknown keys are rejected with 400, AC 12).
 */
function isValidOptionKey(optionKey) {
  return INFERENCE_OPTIONS.some((option) => option.key === optionKey);
}

/**
 * @param {string} optionKey
 * @returns {Object|null} the registry option, or null for unknown keys.
 */
function getOptionByKey(optionKey) {
  return INFERENCE_OPTIONS.find((option) => option.key === optionKey) || null;
}

/**
 * Resolve the model slug configured for an option, seeding the fallback slug
 * into `system_settings` on first read (same upsert pattern as other
 * `system_settings` consumers — N6). Read per request so admin slug changes
 * (F11) apply without a restart.
 *
 * @param {Object} option - a registry option from `INFERENCE_OPTIONS`.
 * @returns {Promise<string>} the configured model slug.
 */
async function getOptionSlug(option) {
  const stored = await SystemSettings.getValueOrFallback(
    { label: option.settingLabel },
    null
  );
  if (!!stored && typeof stored === "string" && stored.trim()) return stored;

  // Seed-on-first-read: upsert the initial slug so the admin UI (F11) shows
  // an explicit, editable value after first use.
  await SystemSettings._updateSettings({
    [option.settingLabel]: option.fallbackSlug,
  });
  return option.fallbackSlug;
}

/**
 * Resolve an option key to the (provider, model) pair used for routing
 * (F12). Reads the configured slug from `system_settings` per request.
 *
 * @param {string|null} optionKey
 * @returns {Promise<{option: Object, provider: string, model: string}|null>}
 * null for unknown/null keys — callers fall back to legacy routing (N4/OQ-4).
 */
async function resolveOption(optionKey) {
  const option = getOptionByKey(optionKey);
  if (!option) return null;
  const model = await getOptionSlug(option);
  return { option, provider: option.provider, model };
}

/**
 * Picker payload (F14): the three options with current reference slug and
 * availability. Unavailable options are still returned — the frontend filters
 * them out — so the payload shape is stable.
 *
 * @param {boolean} includeSettingLabel - include the `system_settings` label
 * (admin payload only; not exposed to default users).
 * @returns {Promise<Array<Object>>}
 */
async function listInferenceOptions(includeSettingLabel = false) {
  const options = [];
  for (const option of INFERENCE_OPTIONS) {
    const model = await getOptionSlug(option);
    const payload = {
      key: option.key,
      label: option.label,
      description: option.description,
      provider: option.provider,
      model,
      available: option.isAvailable(),
    };
    if (includeSettingLabel) payload.settingLabel = option.settingLabel;
    options.push(payload);
  }
  return options;
}

/**
 * Admin slug update (F11). Accepts a partial map of option key → model slug;
 * only known option keys are written, values must be non-empty strings.
 *
 * @param {Object} slugs - e.g. `{ "totem-free": "some/model:free" }`
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function setOptionSlugs(slugs = {}) {
  const updates = {};
  for (const option of INFERENCE_OPTIONS) {
    if (!(option.key in slugs)) continue;
    const value = slugs[option.key];
    if (typeof value !== "string" || !value.trim()) {
      return {
        success: false,
        error: `Invalid model slug for ${option.key}.`,
      };
    }
    updates[option.settingLabel] = value.trim();
  }
  if (Object.keys(updates).length === 0) {
    return { success: false, error: "No valid inference options provided." };
  }
  return SystemSettings._updateSettings(updates);
}

module.exports = {
  OPTION_KEYS,
  INFERENCE_OPTIONS,
  isValidOptionKey,
  getOptionByKey,
  getOptionSlug,
  resolveOption,
  listInferenceOptions,
  setOptionSlugs,
};
