function parseEventData(event) {
    try {
      return event.data.json();
    } catch (e) {
      console.error('Failed to parse event data - is payload valid? .text():\n', event.data.text());
      return null
    }
  }

  /**
   * Update the app-icon badge count.
   * Chrome/Edge desktop support navigator.setAppBadge in the service worker.
   * iOS Safari (16.4+) only supports it from the page main thread, so we
   * also broadcast a message to all open clients as a fallback.
   * @param {number} count
   */
  function updateAppBadge(count) {
    // Try directly in the SW first (works on Chrome/Edge/Android)
    if (typeof self.navigator?.setAppBadge === 'function') {
      (count > 0
        ? self.navigator.setAppBadge(count)
        : self.navigator.clearAppBadge()
      ).catch(() => {});
    }
    // Broadcast to page so iOS PWA can call navigator.setAppBadge from the
    // main thread (the only context where it works on iOS Safari).
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        clientList.forEach((client) => {
          client.postMessage({ type: 'SET_APP_BADGE', count });
        });
      })
      .catch(() => {});
  }
  
  self.addEventListener('push', function (event) {
    const payload = parseEventData(event);
    if (!payload) return;

    // Update badge if the payload carries a count
    if (typeof payload.badge === 'number') {
      updateAppBadge(payload.badge);
    }
  
    // options: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification#options
    const { badge: _badge, ...notificationOptions } = payload;
    event.waitUntil(
      self.registration.showNotification(payload.title || 'Totem LLM', {
        ...notificationOptions,
        icon: '/favicon.png',
      })
    );
  });
  
  self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    const { onClickUrl = null } = event.notification.data || {};
    if (!onClickUrl) return;
    event.waitUntil(clients.openWindow(onClickUrl));
  });