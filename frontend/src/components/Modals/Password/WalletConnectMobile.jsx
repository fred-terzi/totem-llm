import React, { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { SignClient } from "@walletconnect/sign-client";
import System from "../../../models/system";
import { AUTH_TOKEN, AUTH_USER } from "../../../utils/constants";
import paths from "../../../utils/paths";

const projectId = import.meta.env.VITE_WC_PROJECT_ID;

let clientPromise = null;
const getSignClient = () =>
  (clientPromise ??= SignClient.init({
    projectId,
    metadata: {
      name: "Totem",
      description: "Crypto-native AI chat",
      url: window.location.origin,
      icons: [`${window.location.origin}/logo192.png`],
    },
  }));

// ── Pending-verify persistence ──────────────────────────────────────────────
// On Android, MetaMask's universal-link "hand-back" redirect causes a full
// page reload (~35 ms after the verify POST is sent). The JS context is
// destroyed, the in-flight fetch response is abandoned, and the user is left
// on the login page without a JWT.
//
// Fix: store { nonce, signature } in sessionStorage before calling verify.
// On the next page load, a useEffect recovers and retries the verify.
// The nonce is still valid (5-min server TTL; the reload happens in seconds).

const PENDING_KEY = "totem_wallet_pending_verify";
const PENDING_TTL_MS = 5 * 60 * 1000; // matches server nonce TTL

function savePendingVerify(nonce, signature) {
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ nonce, signature, ts: Date.now() })
    );
  } catch { /* sessionStorage unavailable — non-fatal */ }
}

function clearPendingVerify() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* noop */ }
}

function getPendingVerify() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const { nonce, signature, ts } = JSON.parse(raw);
    if (!nonce || !signature || Date.now() - ts > PENDING_TTL_MS) {
      clearPendingVerify();
      return null;
    }
    return { nonce, signature };
  } catch {
    clearPendingVerify();
    return null;
  }
}

/**
 * "Open in MetaMask" — mobile wallet login for PWA use, where no EIP-1193
 * provider (window.ethereum) is injected.
 *
 * Two-tap flow (no programmatic popups — gesture-safe on every mobile browser):
 *
 *   Tap 1  "Start pairing"
 *          → client.connect() creates a WalletConnect pairing via the relay
 *            and returns the `wc:` URI. The dApp-side state is ready and we
 *            render:
 *              • the QR (universal fallback — Trust, Rainbow, SafePal, Base)
 *              • a real <a href="https://metamask.app.link/wc?uri=…"
 *                         target="_blank"> button (Tap 2)
 *
 *   Tap 2  "Open in MetaMask" (the <a> link)
 *          → the browser resolves the universal link → MetaMask app opens
 *            with the pending connection → user approves → `approval()`
 *            resolves → we fire `personal_sign` over the session with the
 *            same nonce/message the EIP-1193 button uses →
 *            POST /api/auth/wallet/verify → server recovers the address from
 *            the signature → JWT issued → redirect to app.
 *
 * Why an <a> and not window.open()?
 *   A programmatic window.open() called after an `await` is outside the
 *   user-gesture window and is silently blocked on mobile (Safari/Chrome).
 *   A rendered <a target="_blank"> is a genuine user gesture on Tap 2 and
 *   is never blocked. This is the reliable, standard WalletConnect v2
 *   mobile pattern.
 *
 * EVM-only by design: Phantom (Solana) cannot sign EVM `personal_sign` —
 * that would need a separate Solana signing path (future work).
 */
export default function WalletConnectMobile() {
  const [uri, setUri] = useState(null);
  const [error, setError] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | starting | pairing | signing
  const [starting, setStarting] = useState(false);

  /**
   * On mount: check for a pending wallet verify that was interrupted by a
   * page reload (MetaMask Android universal-link redirect). If found and
   * still within the nonce TTL, retry the verify to complete the login.
   */
  useEffect(() => {
    const pending = getPendingVerify();
    if (!pending) return;
    console.log(
      "[WALLET-MOBILE DEBUG] Recovering pending verify from sessionStorage — nonce:",
      pending.nonce
    );
    setPhase("signing");
    System.walletVerify({ signature: pending.signature, nonce: pending.nonce })
      .then((result) => {
        if (result.valid && result.token && result.user) {
          console.log("[WALLET-MOBILE DEBUG] Recovery SUCCESS — user:", result.user.username);
          clearPendingVerify();
          window.localStorage.setItem(AUTH_USER, JSON.stringify(result.user));
          window.localStorage.setItem(AUTH_TOKEN, result.token);
          window.location = paths.home();
        } else {
          console.error("[WALLET-MOBILE DEBUG] Recovery FAILED:", JSON.stringify(result));
          clearPendingVerify();
          setError(result.message || "Wallet login could not be completed. Please try again.");
          setPhase("idle");
        }
      })
      .catch((e) => {
        console.error("[WALLET-MOBILE DEBUG] Recovery ERROR:", e.message);
        clearPendingVerify();
        setError(e.message || "Wallet login failed. Please try again.");
        setPhase("idle");
      });
  }, []);

  const handleConnError = (e) => {
    if (phase === "done") return;
    if (
      e?.data?.code === 5000 ||
      /user rejected|rejected/i.test(e?.message || "")
    ) {
      setError("Connection was rejected in the wallet.");
    } else {
      setError(e.message || "Wallet connection failed.");
    }
    setPhase("idle");
    setUri(null);
  };

  /** After the wallet approves the session: sign, verify, log in. */
  const handleApproval = async (client, session) => {
    console.log("[WALLET-MOBILE DEBUG] ===== handleApproval START =====");
    console.log("[WALLET-MOBILE DEBUG] phase:", phase, "session topic:", session?.topic?.slice(0, 20));
    if (phase === "done") return;
    setPhase("signing");

    // Step 1: Get nonce + message from server
    console.log("[WALLET-MOBILE DEBUG] Step 1: calling System.walletNonce()...");
    const { nonce, message, error: nonceErr } = await System.walletNonce();
    console.log("[WALLET-MOBILE DEBUG] Step 1 result — nonce:", nonce, "message length:", message?.length, "error:", nonceErr);
    if (!nonce || !message) {
      console.error("[WALLET-MOBILE DEBUG] ABORT: no nonce/message");
      throw new Error("Could not get signing message.");
    }

    // Step 2: Find EVM account
    const namespace =
      session.namespaces?.eip155 ||
      Object.values(session.namespaces || {}).find((n) =>
        (n.accounts || []).some((a) => a.startsWith("eip155:"))
      );
    const account = namespace?.accounts?.find((a) => a.startsWith("eip155:"));
    if (!account) {
      console.error("[WALLET-MOBILE DEBUG] ABORT: no EVM account — namespaces:", JSON.stringify(session.namespaces));
      throw new Error("No EVM account available in wallet.");
    }
    const [, chainNum, address] = account.split(":");
    console.log("[WALLET-MOBILE DEBUG] Step 2: account:", account, "chain:", chainNum, "address:", address);

    // Step 3: Sign via WalletConnect
    console.log("[WALLET-MOBILE DEBUG] Step 3: calling client.request personal_sign...");
    const t3 = performance.now();
    const signature = await client.request({
      topic: session.topic,
      request: { method: "personal_sign", params: [message, address] },
      chainId: `eip155:${chainNum}`,
    });
    console.log(
      "[WALLET-MOBILE DEBUG] Step 3 DONE in", Math.round(performance.now() - t3), "ms",
      "— signature:", signature ? signature.slice(0, 20) + "..." : null,
      "length:", signature?.length
    );
    if (!signature || signature === "0x") {
      console.error("[WALLET-MOBILE DEBUG] ABORT: signature rejected/empty");
      throw new Error("Signature was rejected.");
    }

    // Step 4: Verify on server
    // Persist the pending state BEFORE the verify call so it survives a
    // page reload (MetaMask Android universal-link redirect).
    savePendingVerify(nonce, signature);
    console.log("[WALLET-MOBILE DEBUG] Step 4: calling System.walletVerify()...");
    const t4 = performance.now();
    const result = await System.walletVerify({ signature, nonce });
    console.log(
      "[WALLET-MOBILE DEBUG] Step 4 DONE in", Math.round(performance.now() - t4), "ms",
      "— valid:", result.valid,
      "token:", result.token ? result.token.slice(0, 20) + "..." : null,
      "user:", result.user?.username,
      "message:", result.message
    );

    if (!result.valid || !result.token || !result.user) {
      console.error("[WALLET-MOBILE DEBUG] VERIFY REJECTED:", JSON.stringify(result));
      // Keep the pending state if the nonce might still be valid (network error).
      // Clear it if the server explicitly rejected (invalid nonce, bad sig).
      if (/invalid or expired nonce/i.test(result.message || "")) {
        clearPendingVerify();
      }
      throw new Error(result.message || "Wallet login failed.");
    }
    clearPendingVerify();

    console.log("[WALLET-MOBILE DEBUG] SUCCESS — storing auth, redirecting to home");
    window.localStorage.setItem(AUTH_USER, JSON.stringify(result.user));
    window.localStorage.setItem(AUTH_TOKEN, result.token);
    setPhase("done");
    window.location = paths.home();
  };

  /**
   * Tap 1 — create the WalletConnect pairing (idempotent) and store the
   * `wc:` URI. The approve → sign → login sequence runs in the background;
   * this returns as soon as the pairing exists so the UI can show the QR +
   * the "Open in MetaMask" anchor immediately.
   */
  const startPairing = async () => {
    console.log("[WALLET-MOBILE DEBUG] ===== startPairing ===== phase:", phase, "starting:", starting);
    if (phase === "pairing" || phase === "signing") {
      console.log("[WALLET-MOBILE DEBUG] startPairing: already in progress, returning existing URI");
      return uri;
    }
    if (starting) return uri;
    try {
      setError(null);
      setStarting(true);
      setPhase("starting");
      console.log("[WALLET-MOBILE DEBUG] startPairing: calling getSignClient()...");
      const client = await getSignClient();
      console.log("[WALLET-MOBILE DEBUG] startPairing: client acquired");

      console.log("[WALLET-MOBILE DEBUG] startPairing: calling client.connect()...");
      const tConnect = performance.now();
      const { uri: pairingUri, approval } = await client.connect({
        optionalNamespaces: {
          eip155: {
            methods: ["personal_sign"],
            chains: ["eip155:1", "eip155:8453", "eip155:137", "eip155:42161"],
            events: [],
          },
        },
      });
      console.log(
        "[WALLET-MOBILE DEBUG] startPairing: client.connect DONE in", Math.round(performance.now() - tConnect), "ms",
        "— URI:", pairingUri?.slice(0, 50) + "..."
      );

      setUri(pairingUri);
      setPhase("pairing");
      console.log("[WALLET-MOBILE DEBUG] startPairing: awaiting approval() in background...");

      // Approve → sign → login, in the background (does not block this fn).
      approval()
        .then((session) => {
          console.log("[WALLET-MOBILE DEBUG] approval RESOLVED — calling handleApproval");
          return handleApproval(client, session);
        })
        .catch((e) => {
          console.error("[WALLET-MOBILE DEBUG] approval REJECTED:", e.name, e.message, "\nstack:", e.stack);
          handleConnError(e);
        });

      return pairingUri;
    } catch (e) {
      console.error("[WALLET-MOBILE DEBUG] startPairing ERROR:", e.name, e.message, "\nstack:", e.stack);
      handleConnError(e);
      return null;
    } finally {
      setStarting(false);
    }
  };

  // Reset helper (e.g. after a rejected sign)
  const resetPairing = () => {
    setUri(null);
    setError(null);
    setPhase("idle");
  };

  if (!projectId) {
    // Not configured — helpful hint instead of a dead button.
    return (
      <div className="w-[300px] my-2">
        <div className="flex items-center w-full my-3">
          <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
          <span className="px-3 text-zinc-500 light:text-slate-400 text-xs">
            on mobile
          </span>
          <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
        </div>
        <p className="text-zinc-500 light:text-slate-400 text-xs text-center leading-relaxed">
          On your phone, open your wallet app's browser (MetaMask, Trust, or
          Base) and visit this site, then tap "Connect Wallet" in-app.
        </p>
      </div>
    );
  }

  // ── STATE A: idle — show the "Start pairing" button (Tap 1) ────────────────
  if (!uri) {
    return (
      <div className="w-[300px] my-2">
        <div className="flex items-center w-full my-3">
          <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
          <span className="px-3 text-zinc-500 light:text-slate-400 text-xs">
            on mobile
          </span>
          <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
        </div>
        <button
          type="button"
          onClick={startPairing}
          disabled={starting || phase === "signing"}
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[34px] w-full flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
            {starting
            ? "Starting…"
            : phase === "signing"
              ? "Waiting for signature…"
              : "Connect with Mobile Wallet"}
        </button>
        <p className="text-zinc-500 light:text-slate-400 text-xs text-center mt-2 leading-relaxed">
          Works with MetaMask, Trust, Rainbow, SafePal, Base and any
          WalletConnect wallet.
        </p>
        {error && (
          <p className="text-red-400 text-xs mt-2 text-center">{error}</p>
        )}
      </div>
    );
  }

  // ── STATE B: pairing — show QR + "Open in MetaMask" (Tap 2) ────────────────
  return (
    <div className="w-[300px] my-2">
      <div className="flex items-center w-full my-3">
        <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
        <span className="px-3 text-zinc-500 light:text-slate-400 text-xs">
          on mobile
        </span>
        <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
      </div>

      {/* Tap 2 — real anchor, gesture-safe on every mobile browser */}
      <a
        href={`https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[38px] w-full flex items-center justify-center transition-colors"
      >
        Open in MetaMask
      </a>

      {/* QR — universal fallback (Trust, Rainbow, SafePal, Base, etc.) */}
      <div className="mt-3 flex flex-col items-center gap-y-2">
        <div className="bg-white p-2 rounded-lg">
          <QRCodeSVG value={uri} size={148} />
        </div>
        <p className="text-zinc-500 light:text-slate-400 text-xs text-center leading-relaxed">
          or scan with any WalletConnect wallet
        </p>
      </div>

      {/* Status line */}
      <div className="mt-3 text-center">
        {phase === "signing" ? (
          <p className="text-sky-400 text-xs animate-pulse">
            Wallet approved — signing your session…
          </p>
        ) : (
          <p className="text-zinc-500 light:text-slate-400 text-xs animate-pulse">
            Waiting for your wallet to approve…
          </p>
        )}
      </div>

      {error && (
        <div className="mt-2">
          <p className="text-red-400 text-xs text-center">{error}</p>
          <button
            type="button"
            onClick={resetPairing}
            className="text-zinc-300 light:text-slate-600 hover:text-sky-300 light:hover:text-sky-600 hover:underline text-xs mt-1"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
