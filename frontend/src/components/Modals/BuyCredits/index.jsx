import React, { useEffect, useRef, useState } from "react";
import { X, Warning, CheckCircle, Lightning } from "@phosphor-icons/react";
import ModalWrapper from "@/components/ModalWrapper";
import Payments from "@/models/payments";
import { useCredits } from "@/context/CreditContext";
import { userFromStorage } from "@/utils/request";
import {
  PURCHASE_PACKS,
  buildUsdcTransferCalldata,
  formatUsdcBaseUnits,
  failureReasonCopy,
  resolvePurchaseSession,
} from "@/utils/payments";

/**
 * BuyCreditsModal — the user-facing "Buy credits" flow (spec F9, AC2, AC9).
 *
 * Full flow per pack click:
 *   1. POST /credits/purchase-session      → session with the EXACT payable
 *      amount (`expectedAmountUsdc`) — the server owns all money math (AC2).
 *   2. window.ethereum eth_sendTransaction — ERC-20 `transfer` of the
 *      session's exact amount to the session's treasury address. Calldata is
 *      built client-side with string/BigInt math only (no floats).
 *   3. resolvePurchaseSession              — confirm + poll loop (N6: ≤3 s
 *      cadence) until `credited` / `failed` / `expired`, with human-readable
 *      failure copy for every F5 reason (AC9).
 *   4. On success: `useCredits().refresh()` — the existing F7 refresh flow.
 *
 * Pre-flight states (no affordance is ever broken):
 *   - no-wallet    → desktop-only copy (mobile is out of scope for v1); the
 *     flow never starts.
 *   - wrong-chain  → the connected wallet is on a different chain than the
 *     session's `chainId` (the wrong-chain residual risk from the threat
 *     model) — the user is asked to switch before the send is offered.
 *   - user-mismatch — the connected wallet address differs from the
 *     account's `wallet_address` (the payer-binding check happens
 *     server-side regardless, F5c — this just fails fast with clear copy).
 *
 * The modal NEVER computes a payable amount and NEVER treats a
 * wallet-reported tx as confirmation — both belong to the server.
 */
export default function BuyCreditsModal({ onClose }) {
  const { refresh } = useCredits();

  // "packs" (choose) → "sending" (wallet prompt open) → "verifying"
  // → "credited" | "failed" | "expired" | "pending" | "wrong-chain"
  const [phase, setPhase] = useState("packs");
  const [session, setSession] = useState(null); // server session record
  const [failureReason, setFailureReason] = useState(null);
  const [error, setError] = useState(null); // transport/validation errors
  const [txHash, setTxHash] = useState(null);
  const [walletChainId, setWalletChainId] = useState(null);

  const mountedRef = useRef(true);
  const cancelRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRef.current = true;
    };
  }, []);

  const hasWallet = typeof window !== "undefined" && !!window.ethereum;

  /**
   * The pack click — the whole purchase flow.
   */
  const handlePackSelect = async (pack) => {
    setError(null);
    setFailureReason(null);
    setSession(null);
    setTxHash(null);

    if (!hasWallet) return; // affordance copy explains; flow never starts

    // ── 1. Create the purchase session (server owns the amount, AC2). ──
    const created = await Payments.createSession(pack.id);
    if (!mountedRef.current) return;
    if (!created.available) {
      // Feature turned off between render and click — surface it; the badge
      // affordance hides on next mount (AC1).
      setFailureReason("feature_disabled");
      setPhase("failed");
      return;
    }
    if (created.error) {
      setError(created.error);
      return;
    }

    const purchase = created.session;
    setSession(purchase);

    // ── 2. Pre-flight: connected account + chain check. ────────────────
    let accounts;
    try {
      accounts = await window.ethereum.request({ method: "eth_accounts" });
    } catch {
      accounts = [];
    }
    if (!accounts || accounts.length === 0) {
      setError(
        "No wallet account is connected. Connect your wallet and try again."
      );
      return;
    }
    const from = accounts[0];

    let chainIdHex;
    try {
      chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
    } catch {
      chainIdHex = null;
    }
    if (!chainIdHex || parseInt(chainIdHex, 16) !== Number(purchase.chainId)) {
      setWalletChainId(chainIdHex ? parseInt(chainIdHex, 16) : null);
      setPhase("wrong-chain");
      return;
    }

    // The F5c payer-binding check happens server-side regardless (the
    // server matches the receipt's `from` against the ACCOUNT's
    // wallet_address) — this is just a fast, clear client-side signal.
    const accountWallet = String(
      userFromStorage()?.wallet_address || ""
    ).toLowerCase();
    if (accountWallet && accountWallet !== String(from).toLowerCase()) {
      setError(
        `Connected wallet (${shortAddress(from)}) doesn't match this account's wallet (${shortAddress(accountWallet)}). Sign in with ${shortAddress(accountWallet)} to buy credits.`
      );
      return;
    }

    // ── 3. Build calldata from the SERVER's session record only. ───────
    // The tx target is the USDC TOKEN CONTRACT — an ERC-20 `transfer` is a
    // call ON the token contract with the recipient (treasury) encoded in
    // the calldata. A tx sent to the treasury address directly is a silent
    // no-op that still mines successfully (manual-test finding, Step 6).
    const tokenAddress = String(purchase.usdcAddress || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
      // Fail-closed (N3): no token contract from the server → never send.
      setError(
        "The purchase session is missing the token contract address. Please try again."
      );
      return;
    }
    let data;
    try {
      data = buildUsdcTransferCalldata({
        recipient: purchase.treasuryAddress,
        amountBaseUnits: purchase.expectedAmountUsdc,
      });
    } catch (e) {
      console.error("[payments] calldata build failed:", e.message);
      setError("Could not prepare the payment. Please try again.");
      return;
    }

    // ── 4. Send through the wallet (user signs; keys never leave it). ──
    setPhase("sending");
    let hash;
    try {
      hash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [
          {
            to: tokenAddress, // the USDC contract, NOT the treasury
            from,
            value: "0x0", // ERC-20: the token amount rides in calldata
            data, // transfer(treasury, expectedAmountUsdc)
          },
        ],
      });
    } catch (e) {
      if (!mountedRef.current) return;
      // Code 4001 = user rejected in the wallet — back to packs, no error.
      if (e?.code === 4001) {
        setPhase("packs");
        return;
      }
      setError(e?.message || "The wallet rejected the transaction.");
      setPhase("packs");
      return;
    }
    if (!mountedRef.current) return;
    if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(String(hash))) {
      setError("The wallet did not return a transaction hash.");
      setPhase("packs");
      return;
    }
    setTxHash(String(hash));

    // ── 5. Drive to a terminal state (confirm + poll, N6 cadence). ─────
    setPhase("verifying");
    const result = await resolvePurchaseSession({
      sessionId: purchase.id,
      txHash: String(hash),
      confirmFn: (sessionId, hash_) =>
        Payments.confirmSession(sessionId, hash_),
      statusFn: (sessionId) => Payments.getSession(sessionId),
      isCancelled: () => cancelRef.current,
    });
    if (!mountedRef.current || result.status === "cancelled") return;

    if (result.status === "credited" || result.status === "already-redeemed") {
      setPhase("credited");
      // F7: refresh the badge through the existing context flow.
      refresh();
      return;
    }
    if (result.status === "pending") {
      // Verification window exceeded — the background sweeper owns the
      // session from here (it keeps retrying until the TTL, AC10).
      setPhase("pending");
      return;
    }
    setFailureReason(result.failureReason ?? null);
    setPhase(result.status); // "failed" | "expired"
  };

  const usdc = session ? formatUsdcBaseUnits(session.expectedAmountUsdc) : null;
  const chainLabel =
    Number(session?.chainId) === 84532 ? "Base Sepolia (testnet)" : "Base";

  return (
    <ModalWrapper isOpen={true}>
      <div className="w-full max-w-2xl bg-theme-bg-secondary rounded-lg shadow border-2 border-theme-modal-border overflow-hidden">
        <div className="relative p-6 border-b rounded-t border-theme-modal-border">
          <div className="w-full flex gap-x-2 items-center">
            <Lightning size={24} className="text-amber-400" weight="bold" />
            <h3 className="text-xl font-semibold text-white overflow-hidden overflow-ellipsis whitespace-nowrap">
              Buy credits
            </h3>
          </div>
          <button
            onClick={onClose}
            type="button"
            aria-label="Close"
            className="absolute top-4 right-4 transition-all duration-300 bg-transparent rounded-lg text-sm p-1 inline-flex items-center hover:bg-theme-modal-border hover:border-theme-modal-border hover:border-opacity-50 border-transparent border"
          >
            <X size={24} weight="bold" className="text-white" />
          </button>
        </div>

        <div
          className="h-full w-full overflow-y-auto"
          style={{ maxHeight: "calc(100vh - 200px)" }}
        >
          <div className="py-7 px-9 space-y-4 flex-col">
            {/* ── Pack selection (AC2 — integer-exact labels) ──────────── */}
            {(phase === "packs" || phase === "sending") && (
              <>
                <p className="text-sm text-white">
                  Pick an amount. Payment is USDC on{" "}
                  <span className="font-semibold">Base</span>, sent directly
                  from your wallet.
                </p>
                <div className="flex flex-col gap-y-2">
                  {PURCHASE_PACKS.map((pack) => (
                    <button
                      key={pack.id}
                      type="button"
                      disabled={phase === "sending"}
                      onClick={() => handlePackSelect(pack)}
                      className="flex items-center justify-between w-full rounded-lg border border-white/10 bg-theme-settings-input-bg px-4 py-3 text-left hover:border-white/25 disabled:opacity-50 transition-colors"
                    >
                      <span className="flex flex-col">
                        <span className="text-white text-sm font-semibold">
                          {pack.credits.toLocaleString("en-US")} credits
                        </span>
                        <span className="text-zinc-400 text-xs">
                          ${pack.usd}.00 — paid in USDC on Base
                        </span>
                      </span>
                      <span className="text-white text-sm font-medium tabular-nums">
                        {pack.usd} USDC
                      </span>
                    </button>
                  ))}
                </div>
                {!hasWallet && (
                  <p className="text-amber-400 text-xs flex items-start gap-x-1.5">
                    <Warning size={14} className="mt-0.5 shrink-0" />
                    Buying credits needs a desktop wallet extension (MetaMask,
                    Rainbow, …). Mobile purchase isn't supported yet — open this
                    site on desktop, sign in with your wallet, and your balance
                    is waiting for you.
                  </p>
                )}
                {error && (
                  <p className="text-red-400 text-xs">Error: {error}</p>
                )}
              </>
            )}

            {/* ── Wrong chain (threat-model residual risk, surfaced) ──── */}
            {phase === "wrong-chain" && session && (
              <>
                <p className="text-sm text-white flex items-start gap-x-2">
                  <Warning
                    size={18}
                    className="text-amber-400 mt-0.5 shrink-0"
                  />
                  <span>
                    Your wallet is on a different network. This purchase expects{" "}
                    <b>{chainLabel}</b> (chain id {session.chainId}
                    {walletChainId
                      ? `, your wallet is on chain id ${walletChainId}`
                      : ""}
                    ). Sending on the wrong network can lose your funds.
                  </span>
                </p>
                <p className="text-zinc-400 text-xs">
                  Switch your wallet to {chainLabel} and try again.
                </p>
                <div className="flex items-center gap-x-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setPhase("packs")}
                    className="text-zinc-950 bg-white hover:bg-zinc-300 text-sm font-semibold rounded-lg h-[34px] px-4"
                  >
                    Back to packs
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="text-zinc-400 hover:text-zinc-200 text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {/* ── Verifying ────────────────────────────────────────────── */}
            {phase === "verifying" && session && (
              <>
                <p className="text-sm text-white">
                  Verifying your payment on-chain…
                </p>
                <p className="text-zinc-400 text-xs break-all">
                  Transaction: <span className="tabular-nums">{txHash}</span>
                </p>
                <p className="text-zinc-400 text-xs">
                  {usdc} USDC → {chainLabel}. This usually takes a few seconds.
                  You can close this window — verification continues in the
                  background and your credits arrive automatically.
                </p>
                <div className="flex items-center gap-x-2 pt-2">
                  <span className="h-3 w-3 rounded-full bg-amber-400 animate-pulse" />
                  <button
                    type="button"
                    onClick={onClose}
                    className="text-zinc-400 hover:text-zinc-200 text-sm"
                  >
                    Close
                  </button>
                </div>
              </>
            )}

            {/* ── Success (AC3 — badge already refreshed) ──────────────── */}
            {phase === "credited" && (
              <>
                <p className="text-sm text-white flex items-center gap-x-2">
                  <CheckCircle
                    size={18}
                    className="text-emerald-400 shrink-0"
                  />
                  Payment confirmed — your credits are in your balance.
                </p>
                {usdc && (
                  <p className="text-zinc-400 text-xs">
                    {usdc} USDC received on {chainLabel}.
                  </p>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="text-zinc-950 bg-white hover:bg-zinc-300 text-sm font-semibold rounded-lg h-[34px] px-4 self-start"
                >
                  Done
                </button>
              </>
            )}

            {/* ── Failure / expiry (AC9 — human-readable reason) ───────── */}
            {(phase === "failed" || phase === "expired") && (
              <>
                <p className="text-sm text-white flex items-start gap-x-2">
                  <Warning size={18} className="text-red-400 mt-0.5 shrink-0" />
                  <span>{failureReasonCopy(failureReason)}</span>
                </p>
                {txHash && (
                  <p className="text-zinc-500 text-xs break-all">
                    Transaction hash (keep for support): {txHash}
                  </p>
                )}
                <div className="flex items-center gap-x-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setPhase("packs")}
                    className="text-zinc-950 bg-white hover:bg-zinc-300 text-sm font-semibold rounded-lg h-[34px] px-4"
                  >
                    Start over
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="text-zinc-400 hover:text-zinc-200 text-sm"
                  >
                    Close
                  </button>
                </div>
              </>
            )}

            {/* ── Handed off to the background sweeper ─────────────────── */}
            {phase === "pending" && (
              <>
                <p className="text-sm text-white">
                  Your payment is taking longer than usual to verify. No action
                  is needed — it completes automatically, and your credits
                  appear in your balance the moment it does.
                </p>
                {txHash && (
                  <p className="text-zinc-500 text-xs break-all">
                    Transaction hash: {txHash}
                  </p>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="text-zinc-950 bg-white hover:bg-zinc-300 text-sm font-semibold rounded-lg h-[34px] px-4 self-start"
                >
                  Got it
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </ModalWrapper>
  );
}

/**
 * 0x1234…abcd truncation for inline wallet-address copy.
 * @param {string} address
 * @returns {string}
 */
function shortAddress(address) {
  const addr = String(address || "");
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
