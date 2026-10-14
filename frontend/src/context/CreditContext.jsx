import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { API_BASE, CONTEXT_USAGE_EVENT } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

/**
 * CreditContext
 *
 * Owns the live credit balance for the signed-in account and keeps it in sync
 * with the server. "Credits" is the customer-facing unit — the badge displays
 * an opaque integer and never exposes the underlying microdollar value.
 *
 * Behavior (robust by design):
 *   - Fetches the balance on mount from GET /credits (authenticated).
 *   - While a load is in flight, exposes `loading: true` so the UI can show a
 *     neutral placeholder instead of a stale/hardcoded number.
 *   - `refresh()` re-fetches; it is exposed so other components can force a
 *     reload (e.g. after buying credits) and can be called concurrently
 *     without causing duplicate in-flight requests.
 *   - Subscribes to the existing `CONTEXT_USAGE_EVENT` (emitted after every
 *     chat turn) so the badge stays accurate as credits are spent.
 *   - Never throws to the consumer; network/auth failures resolve to
 *     `error: true` with the last-known (or null) balance so the UI degrades
 *     gracefully rather than crashing.
 *
 * Usage:
 *   const { credits, loading, error, refresh } = useCredits();
 */

const CreditContext = createContext({
  credits: null,
  loading: true,
  error: false,
  refresh: () => {},
});

export function CreditProvider({ children }) {
  const [credits, setCredits] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Guards concurrent fetches so a burst of usage events / refresh() calls
  // collapse into a single in-flight request.
  const inFlight = useRef(null);
  const mounted = useRef(true);

  const fetchBalance = useCallback(async () => {
    if (inFlight.current) return inFlight.current;

    const request = (async () => {
      try {
        const res = await fetch(`${API_BASE}/credits`, {
          method: "GET",
          headers: baseHeaders(),
        });

        if (!res.ok) throw new Error(`GET /credits -> ${res.status}`);

        const data = await res.json();
        const balance = Number(data?.balance);

        if (mounted.current) {
          setCredits(Number.isFinite(balance) ? balance : 0);
          setError(false);
          setLoading(false);
        }
      } catch (e) {
        console.warn("[credits] failed to load balance:", e.message);
        if (mounted.current) {
          setError(true);
          setLoading(false);
        }
      }
    })();

    inFlight.current = request;
    try {
      await request;
    } finally {
      inFlight.current = null;
    }
  }, []);

  // Initial load + keep the badge in sync after every chat turn.
  useEffect(() => {
    mounted.current = true;
    fetchBalance();

    const onUsage = () => fetchBalance();
    window.addEventListener(CONTEXT_USAGE_EVENT, onUsage);

    return () => {
      mounted.current = false;
      window.removeEventListener(CONTEXT_USAGE_EVENT, onUsage);
    };
  }, [fetchBalance]);

  const value = useMemo(
    () => ({
      credits,
      loading,
      error,
      refresh: fetchBalance,
    }),
    [credits, loading, error, fetchBalance]
  );

  return (
    <CreditContext.Provider value={value}>{children}</CreditContext.Provider>
  );
}

/**
 * Hook to read the live credit balance.
 * @returns {{credits: number|null, loading: boolean, error: boolean, refresh: () => void}}
 */
export function useCredits() {
  return useContext(CreditContext);
}

export default CreditContext;
