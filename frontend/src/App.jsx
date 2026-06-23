import React, { Suspense, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { AuthProvider } from "@/AuthContext";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import i18n from "./i18n";

import { PfpProvider } from "./PfpContext";
import { LogoProvider } from "./LogoContext";
import { FullScreenLoader } from "./components/Preloader";
import { ThemeProvider } from "./ThemeContext";
import { PWAModeProvider } from "./PWAContext";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import ImageLightbox from "@/components/ImageLightbox";
import { ErrorBoundary } from "react-error-boundary";
import ErrorBoundaryFallback from "./components/ErrorBoundaryFallback";
import useBackendOfflineNotifications from "@/hooks/useBackendOfflineNotifications";
import { closeAllPersistedAgentSockets } from "@/utils/chat/agent";
import useIOSPushPrompt from "@/hooks/useIOSPushPrompt";

/**
 * Listen for SET_APP_BADGE messages broadcast by the push service worker.
 * iOS Safari only allows navigator.setAppBadge from the page (main thread),
 * so the SW posts a message here and we call the API on its behalf.
 */
function useAppBadgeListener() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
      return;
    const handler = (event) => {
      if (event.data?.type !== "SET_APP_BADGE") return;
      const count = event.data.count ?? 0;
      if (count > 0) {
        navigator.setAppBadge?.(count).catch(() => {});
      } else {
        navigator.clearAppBadge?.().catch(() => {});
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () =>
      navigator.serviceWorker.removeEventListener("message", handler);
  }, []);
}

export default function App() {
  const location = useLocation();
  useBackendOfflineNotifications();
  useAppBadgeListener();
  useIOSPushPrompt();

  // Close all parked agent WebSocket sessions when the tab is closed so the
  // server-side invocations are properly cleaned up.
  useEffect(() => {
    const handleUnload = () => closeAllPersistedAgentSockets();
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, []);

  return (
    <ErrorBoundary
      FallbackComponent={ErrorBoundaryFallback}
      onError={console.error}
      resetKeys={[location.pathname]}
    >
      <ThemeProvider>
        <PWAModeProvider>
          <Suspense fallback={<FullScreenLoader />}>
            <AuthProvider>
              <LogoProvider>
                <PfpProvider>
                  <I18nextProvider i18n={i18n}>
                    <Outlet />
                    <ToastContainer />
                    <KeyboardShortcutsHelp />
                    <ImageLightbox />
                  </I18nextProvider>
                </PfpProvider>
              </LogoProvider>
            </AuthProvider>
          </Suspense>
        </PWAModeProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
