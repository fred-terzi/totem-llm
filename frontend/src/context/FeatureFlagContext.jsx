import React, { createContext, useContext, useEffect, useState } from "react";

/**
 * FeatureFlagContext
 *
 * Provides feature flags to all React components.
 * Fetches live flags from the server at runtime (GET /api/features) so that
 * changes to ~/totem-llm/totem.features.json are reflected without rebuilding
 * the frontend. Falls back to build-time baked-in values if the fetch fails.
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
const buildTimeFeatures =
  typeof __TOTEM_FEATURES__ !== "undefined" ? __TOTEM_FEATURES__ : {};

const FeatureFlagContext = createContext(buildTimeFeatures);

export function FeatureFlagProvider({ children }) {
  const [features, setFeatures] = useState(buildTimeFeatures);

  useEffect(() => {
    const apiBase = import.meta.env.VITE_API_BASE || "/api";
    fetch(`${apiBase}/features`)
      .then((res) => res.json())
      .then(({ features: liveFeatures }) => {
        if (liveFeatures && Object.keys(liveFeatures).length > 0) {
          setFeatures(liveFeatures);
        }
      })
      .catch(() => {
        // Silently fall back to build-time flags if the server is unreachable
      });
  }, []);

  return (
    <FeatureFlagContext.Provider value={features}>
      {children}
    </FeatureFlagContext.Provider>
  );
}

export function useFeatureFlags() {
  return useContext(FeatureFlagContext);
}
