const BACKEND_OFFLINE_MESSAGE = "BACKEND_OFFLINE";
const BACKEND_API_PATH = "/api";
const CACHE_NAME = "totem-backend-offline-v1";
const OFFLINE_PAGE = "/offline.html";
let hasNotifiedOffline = false;

function notifyClients() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    clients.forEach((client) => {
      client.postMessage({ type: BACKEND_OFFLINE_MESSAGE });
    });
  });
}

function isBackendRequest(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin && url.pathname.startsWith(BACKEND_API_PATH);
  } catch (error) {
    return false;
  }
}

function isNavigationalRequest(request) {
  return (
    request.mode === "navigate" ||
    (request.method === "GET" && request.headers.get("accept")?.includes("text/html"))
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_PAGE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (isBackendRequest(request)) {
    event.respondWith(
      fetch(request.clone()).catch(() => {
        if (!hasNotifiedOffline) {
          hasNotifiedOffline = true;
          notifyClients();
        }
        return new Response(
          JSON.stringify({
            error: "The backend appears to be offline.",
          }),
          {
            status: 503,
            statusText: "Service Unavailable",
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      })
    );
    return;
  }

  if (isNavigationalRequest(request)) {
    event.respondWith(
      fetch(request.clone())
        .then((response) => {
          if (response && response.ok) {
            return response;
          }
          throw new Error("Navigation request failed");
        })
        .catch(() => caches.match(OFFLINE_PAGE))
    );
  }
});
