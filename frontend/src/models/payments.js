import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

/**
 * Wallet payments API client — the three purchase-session endpoints
 * (`server/endpoints/payments.js`).
 *
 * The feature gate (F1/AC1) is a `204` with no body: it is the discovery
 * signal the buy affordance uses to hide itself. Every method here reports
 * `{ available: false }` for that shape so callers never have to
 * special-case a `204` response twice.
 */
const Payments = {
  /**
   * Feature-gate probe (F1/AC1) — the discovery signal for the buy
   * affordance. Deliberately sends an INVALID packId: the server checks the
   * feature gate BEFORE body validation, so
   *   - feature off  → `204` (gate short-circuits everything),
   *   - feature on   → `400` (unknown packId) — and NO session is created.
   * Either way no purchase session is ever persisted by this probe, and it
   * consumes one rate-limited request per page load at most.
   * @returns {Promise<boolean>} true when the payments feature is on
   */
  paymentsEnabled: async function () {
    try {
      const res = await fetch(`${API_BASE}/credits/purchase-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...baseHeaders() },
        body: JSON.stringify({ packId: "__probe__" }),
      });
      // Any non-204 answer means the gate passed and the endpoint is live.
      return res.status !== 204;
    } catch (e) {
      console.error("[payments] feature probe failed:", e.message);
      return false; // fail-closed: no affordance on network errors
    }
  },

  /**
   * Creates a purchase session for a pack.
   * @param {string} packId - "usd5" | "usd10" | "usd25"
   * @returns {Promise<
   *   | {available: true, session: {id: string, expectedAmountUsdc: string, treasuryAddress: string, usdcAddress: string, chainId: number, expiresAt: string}}
   *   | {available: false}
   *   | {available: true, error: string}
   * >}
   */
  createSession: async function (packId) {
    try {
      const res = await fetch(`${API_BASE}/credits/purchase-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...baseHeaders() },
        body: JSON.stringify({ packId: String(packId || "") }),
      });
      if (res.status === 204) return { available: false };
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          available: true,
          error: data?.message || "Could not start the purchase.",
        };
      }
      return { available: true, session: data };
    } catch (e) {
      console.error("[payments] createSession:", e.message);
      return { available: true, error: "Network error — please try again." };
    }
  },

  /**
   * Confirms a session with a txHash — triggers the server-side F5
   * six-check verification and (on a full pass) the atomic redeem.
   * Safe to call repeatedly for the same txHash: terminal states are
   * answered from the DB and crediting is exactly-once (F6).
   *
   * @param {string} sessionId
   * @param {string} txHash
   * @returns {Promise<
   *   | {available: true, status: string, failureReason?: string|null, session?: object}
   *   | {available: false}
   *   | {available: true, error: string}
   * >}
   */
  confirmSession: async function (sessionId, txHash) {
    try {
      const res = await fetch(
        `${API_BASE}/credits/purchase-session/${encodeURIComponent(sessionId)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...baseHeaders() },
          body: JSON.stringify({ txHash: String(txHash || "") }),
        }
      );
      if (res.status === 204) return { available: false };
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          available: true,
          error: data?.message || "Could not verify the payment.",
        };
      }
      return { available: true, ...data };
    } catch (e) {
      console.error("[payments] confirmSession:", e.message);
      return {
        available: true,
        status: "pending",
        failureReason: "rpc_unavailable",
        error: e.message,
      };
    }
  },

  /**
   * Polls a session's current status (owner-only). Reports state only —
   * verification is (re-)triggered by `confirmSession`.
   * @param {string} sessionId
   * @returns {Promise<
   *   | {available: true, session: object}
   *   | {available: false}
   *   | {available: true, error: string}
   * >}
   */
  getSession: async function (sessionId) {
    try {
      const res = await fetch(
        `${API_BASE}/credits/purchase-session/${encodeURIComponent(sessionId)}`,
        { headers: baseHeaders() }
      );
      if (res.status === 204) return { available: false };
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          available: true,
          error: data?.message || "Could not read the purchase status.",
        };
      }
      return { available: true, session: data?.session ?? null };
    } catch (e) {
      console.error("[payments] getSession:", e.message);
      return { available: true, error: e.message };
    }
  },
};

export default Payments;
