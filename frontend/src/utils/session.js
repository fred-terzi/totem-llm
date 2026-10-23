import { API_BASE } from "./constants";
import { baseHeaders } from "./request";

// Checks current localstorage and validates the session based on that.
// Returns:
//   true  → token validated by the server (HTTP 200)
//   false → server definitively rejected the token (401/403/5xx)
//   null  → network-level failure (fetch threw, e.g. "Failed to fetch")
//
// The null case matters on mobile/PWA: when Android cold-starts the app or
// resumes it from background, the first fetch can fail before the network
// stack re-establishes. That is NOT an expired session — callers must not
// clear the stored token in response to a network error, or users get
// logged out for no reason.
export default async function validateSessionTokenForUser() {
  try {
    const res = await fetch(`${API_BASE}/system/check-token`, {
      method: "GET",
      cache: "default",
      headers: baseHeaders(),
    });
    return res.status === 200;
  } catch {
    return null;
  }
}
