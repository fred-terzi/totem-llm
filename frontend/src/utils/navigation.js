/**
 * Client-side navigation bridge for code that lives outside of React
 * components (module-level helpers, plain event handlers, etc.).
 *
 * The active React Router navigator registers itself via
 * `registerNavigator` (see <RouterNavigator /> in App.jsx). Calls to
 * `navigateTo` then use client-side routing instead of full page loads,
 * which prevents the SPA from being torn down and re-booted - a
 * particularly visible problem on mobile where a reload loses all
 * in-memory app state.
 */

let navigateFn = null;

/**
 * Register the router's navigate function. Called by <RouterNavigator />.
 * @param {Function | null} fn - React Router's navigate function.
 */
export function registerNavigator(fn) {
  navigateFn = fn;
}

/**
 * Navigate to a path using the React Router when available.
 * @param {string} path - The in-app path to navigate to (e.g. "/workspace/my-ws").
 * @param {object} options - Optional React Router navigate options (e.g. { replace: true }).
 */
export default function navigateTo(path, options = {}) {
  if (typeof navigateFn === "function") {
    navigateFn(path, options);
    return;
  }
  // Fallback for edge cases where the router has not mounted yet.
  // Should not happen in normal usage.
  if (options?.replace) {
    window.location.replace(path);
  } else {
    window.location.href = path;
  }
}
