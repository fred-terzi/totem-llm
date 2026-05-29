import { useFeatureFlags } from "@/context/FeatureFlagContext";

/**
 * useFeatureFlag(key)
 *
 * Returns the feature definition for a single feature key.
 * If the key does not exist in the manifest, returns a safe default
 * with `enabled: false` so unknown features are always hidden.
 *
 * @param {string} key - The feature key from totem.features.js
 * @returns {{ enabled: boolean, label: string, tier: string }}
 *
 * @example
 *   const { enabled } = useFeatureFlag("communityHub");
 *   if (!enabled) return null;
 */
export default function useFeatureFlag(key) {
  const flags = useFeatureFlags();
  return flags[key] ?? { enabled: false, label: key, tier: "free" };
}
