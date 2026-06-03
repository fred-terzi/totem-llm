import { useEffect } from "react";
import showToast from "@/utils/toast";

export default function useBackendOfflineNotifications() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event) => {
      const message = event?.data;
      if (!message || message?.type !== "BACKEND_OFFLINE") {
        return;
      }

      showToast(
        "The backend appears to be offline. Please ensure the CLI/server is running in the terminal.",
        "error",
        { clear: true }
      );
    };

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);

    navigator.serviceWorker
      .register("/service-worker.js")
      .catch((error) => {
        console.error("Failed to register backend offline service worker", error);
      });

    return () => {
      navigator.serviceWorker.removeEventListener(
        "message",
        handleServiceWorkerMessage
      );
    };
  }, []);
}
