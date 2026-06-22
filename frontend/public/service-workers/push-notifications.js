function parseEventData(event) {
    try {
      return event.data.json();
    } catch (e) {
      console.error('Failed to parse event data - is payload valid? .text():\n', event.data.text());
      return null
    }
  }
  
  self.addEventListener('push', function (event) {
    const payload = parseEventData(event);
    if (!payload) return;

    // Update the app-icon badge (PWA homescreen / desktop installs).
    // badge === 0 clears it; badge > 0 shows the count.
    // Gracefully ignored in browsers that don't support the Badging API.
    if (typeof payload.badge === 'number') {
      if (payload.badge > 0) {
        self.navigator?.setAppBadge?.(payload.badge).catch(() => {});
      } else {
        self.navigator?.clearAppBadge?.().catch(() => {});
      }
    }
  
    // options: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification#options
    self.registration.showNotification(payload.title || 'Totem LLM', {
      ...payload,
      icon: '/favicon.png',
    });
  });
  
  self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    const { onClickUrl = null } = event.notification.data || {};
    if (!onClickUrl) return;
    event.waitUntil(clients.openWindow(onClickUrl));
  });