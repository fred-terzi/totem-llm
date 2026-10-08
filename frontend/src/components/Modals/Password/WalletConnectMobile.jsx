import React, { useState } from "react";
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
    if (phase === "done") return;
    setPhase("signing");
    // Same server flow as the EIP-1193 button — only the transport differs.
    const { nonce, message } = await System.walletNonce();
    if (!nonce || !message) throw new Error("Could not get signing message.");

    // First EVM account in the approved session. Account format (CAIP-10):
    // "eip155:<chainId>:<0xAddress>". We derive both chain + address from it,
    // so the request is valid on whatever chain the wallet settled on.
    const namespace =
      session.namespaces?.eip155 ||
      Object.values(session.namespaces || {}).find((n) =>
        (n.accounts || []).some((a) => a.startsWith("eip155:"))
      );
    const account = namespace?.accounts?.find((a) => a.startsWith("eip155:"));
    if (!account) throw new Error("No EVM account available in wallet.");
    const [, chainNum, address] = account.split(":");

    const signature = await client.request({
      topic: session.topic,
      request: { method: "personal_sign", params: [message, address] },
      chainId: `eip155:${chainNum}`,
    });
    if (!signature || signature === "0x")
      throw new Error("Signature was rejected.");

    const result = await System.walletVerify({ signature, nonce });
    if (!result.valid || !result.token || !result.user)
      throw new Error(result.message || "Wallet login failed.");

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
    if (phase === "pairing" || phase === "signing") return uri;
    if (starting) return uri;
    try {
      setError(null);
      setStarting(true);
      setPhase("starting");
      const client = await getSignClient();

      // Chain-agnostic by design (matches the existing wallet-login decision):
      // `personal_sign` has no chain parameter, so the signature is valid
      // regardless of which EVM chain the wallet is on. We declare the common
      // EVM chains so the proposal is compatible with Base / Ethereum /
      // Polygon / Arbitrum wallets (Base is the primary mobile target), but
      // the actual request uses whichever chain the session settled on.
      const { uri: pairingUri, approval } = await client.connect({
        optionalNamespaces: {
          eip155: {
            methods: ["personal_sign"],
            chains: ["eip155:1", "eip155:8453", "eip155:137", "eip155:42161"],
            events: [],
          },
        },
      });

      setUri(pairingUri);
      setPhase("pairing");

      // Approve → sign → login, in the background (does not block this fn).
      approval()
        .then((session) => handleApproval(client, session))
        .catch(handleConnError);

      return pairingUri;
    } catch (e) {
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
