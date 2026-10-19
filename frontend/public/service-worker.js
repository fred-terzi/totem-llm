const BACKEND_OFFLINE_MESSAGE = "BACKEND_OFFLINE";
const BACKEND_API_PATH = "/api";
// Bump CACHE_NAME whenever this service worker or its precache list changes
// so stale shells are evicted on activate.
const CACHE_NAME = "totem-shell-v2";
const OFFLINE_PAGE = "/offline.html";
// The app shell served for all navigations when the network is unavailable
// (or too slow). The shell boots the SPA client-side, which then renders the
// correct route from the URL - so a discarded background tab restores
// instantly instead of showing a slow blank page or offline.html.
const SHELL_URL = "/";
const NAVIGATION_TIMEOUT_MS = 4000;
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

/**
 * Precache the app shell and the offline page so navigation requests can be
 * served instantly when the network fails or the tab is restored after the
 * mobile OS discarded it.
 */
function precacheShell() {
  return caches.open(CACHE_NAME).then((cache) =>
    Promise.allSettled([cache.add(SHELL_URL), cache.add(OFFLINE_PAGE)])
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Remove caches owned by previous versions of this service worker.
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith("totem-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/**
 * Try the network with a timeout, falling back to the cached app shell (or
 * the offline page) on failure. Network-first keeps the shell fresh after
 * deploys while the cache guarantees an instant restore for discarded tabs
 * and offline usage.
 */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const networkResponse = await Promise.race([
      fetch(request.clone()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("navigation timeout")), NAVIGATION_TIMEOUT_MS)
      ),
    ]);

    if (networkResponse && networkResponse.ok) {
      // Keep a fresh copy of the shell cached for the next restore.
      cache.put(SHELL_URL, networkResponse.clone()).catch(() => {});
      return networkResponse;
    }
    throw new Error("Navigation request failed");
  } catch (error) {
    // Prefer the cached live shell over the offline page so the SPA can
    // boot and render from the current URL. Only fall back to offline.html
    // when no shell has ever been cached.
    const cachedShell = await cache.match(SHELL_URL);
    if (cachedShell) return cachedShell;

    const cachedOffline = await cache.match(OFFLINE_PAGE);
    if (cachedOffline) return cachedOffline;

    return new Response(
      "<html><body><h1>You are offline</h1></body></html>",
      { status: 503, headers: { "Content-Type": "text/html" } }
    );
  }
}

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
    event.respondWith(handleNavigation(request));
  }
});
