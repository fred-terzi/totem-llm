import React, { createContext, useContext } from "react";

/**
 * FeatureFlagContext
 *
 * Provides build-time feature flags to all React components.
 * Values are baked into the bundle at build time via Vite's `define` —
 * they cannot be changed at runtime.
 *
 * Usage:
 *   import { useFeatureFlags } from "@/context/FeatureFlagContext";
 *   const { communityHub } = useFeatureFlags();
 *   if (!communityHub.enabled) return null;
 *
 * Or use the convenience hook for a single flag:
 *   import useFeatureFlag from "@/hooks/useFeatureFlag";
 *   const { enabled } = useFeatureFlag("communityHub");
 */

/* global __TOTEM_FEATURES__ */
const resolvedFeatures =
  typeof __TOTEM_FEATURES__ !== "undefined" ? __TOTEM_FEATURES__ : {};

const FeatureFlagContext = createContext(resolvedFeatures);

export function FeatureFlagProvider({ children }) {
  return (
    <FeatureFlagContext.Provider value={resolvedFeatures}>
      {children}
    </FeatureFlagContext.Provider>
  );
}

export function useFeatureFlags() {
  return useContext(FeatureFlagContext);
}
