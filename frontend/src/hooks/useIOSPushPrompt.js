import { useEffect } from "react";
import { subscribeToPushNotifications } from "@/hooks/useWebPushNotifications";

/**
 * On iOS Safari 16.4+ the browser only supports Web Push when the app is
 * installed as a PWA (Add to Home Screen) and the permission prompt can
 * only be shown in response to a direct user gesture.
 *
 * This hook wires up a one-shot `touchend` listener that:
 *  1. Only fires when running as a standalone PWA on iOS
 *  2. Only fires once (removed immediately after the first tap)
 *  3. Only acts when permission has not yet been granted/denied
 *
 * The call to subscribeToPushNotifications asks the user for permission
 * (askToEnable = true) and, if granted, registers the push subscription.
 */
export default function useIOSPushPrompt() {
  useEffect(() => {
    // Only needed on iOS standalone PWA
    if (typeof window === "undefined") return;
    const isIOS =
      /iphone|ipad|ipod/i.test(window.navigator?.userAgent ?? "") ||
      (window.navigator?.platform === "MacIntel" &&
        window.navigator?.maxTouchPoints > 1);
    const isStandalone = window.navigator?.standalone === true;
    if (!isIOS || !isStandalone) return;

    // Already decided — nothing to do
    if (
      typeof Notification !== "undefined" &&
      Notification.permission !== "default"
    )
      return;

    // Push not supported in this context
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    const onFirstTap = () => {
      document.removeEventListener("touchend", onFirstTap);
      // askToEnable=true → will call Notification.requestPermission()
      subscribeToPushNotifications(true).catch(() => {});
    };

    document.addEventListener("touchend", onFirstTap, { passive: true });
    return () => document.removeEventListener("touchend", onFirstTap);
  }, []);
}
