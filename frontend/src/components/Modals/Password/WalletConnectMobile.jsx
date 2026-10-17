import React, { useEffect, useRef, useState } from "react";
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
} from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { BrowserProvider } from "ethers";
import { mainnet, base } from "@reown/appkit/networks";
import System from "../../../models/system";
import { AUTH_TOKEN, AUTH_USER } from "../../../utils/constants";
import paths from "../../../utils/paths";

const projectId = import.meta.env.VITE_WC_PROJECT_ID;

// ── Platform detection ──────────────────────────────────────────────────────
// Android Chrome reclaims the tab (full page reload) whenever the wallet app
// takes the foreground. When the page comes back, AppKit restores the
// WalletConnect session from localStorage, but MetaMask keeps answering on
// the pre-reload session keys — the reloaded client can't decrypt the relay
// traffic ("failed to process an inbound message" / "Invalid Id") and the
// signature response is permanently lost. Cross-app WalletConnect is
// therefore NOT usable for sign-in on Android. Instead we hand the user to
// MetaMask's built-in browser (window.ethereum injected, no relay, no
// reload race) and let the in-page desktop flow run.
const IS_ANDROID = /android/i.test(navigator?.userAgent || "");
const HAS_INJECTED = typeof window !== "undefined" && !!window.ethereum;

/**
 * Reown AppKit (formerly WalletConnect AppKit) — handles the mobile wallet
 * CONNECTION UX (wallet picker, deep links, QR, session persistence). It does
 * NOT run our SIWE login: once connected we drive the nonce → personal_sign →
 * verify flow ourselves over the AppKit-provided EIP-1193 provider.
 */
let appKitInstance = null;
if (projectId && typeof window !== "undefined") {
  // Created once at module scope, outside React, per AppKit docs — calling
  // this inside a component body causes re-init on every render.
  appKitInstance = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [mainnet, base],
    projectId,
    metadata: {
      name: "Totem",
      description: "Crypto-native AI chat",
      url: window.location.origin,
      icons: [`${window.location.origin}/logo192.png`],
    },
    features: {
      email: false,
      socials: [],
    },
  });
}

// ── Reload-safe SIWE state ──────────────────────────────────────────────────
// The mobile flow requires the user to LEAVE the page (MetaMask app) to sign.
// On Android the universal-link "hand-back" (or a dropped relay callback) can
// reload the page *mid-flow*, destroying the in-flight sign → verify chain so
// the JWT is never saved and the user lands back on the login page.
//
// Fix: persist the nonce (+ the signature once we have it) in sessionStorage
// so a reloaded page can RESUME exactly where it left off:
//   • nonce only           → re-request the signature from the wallet, then verify
//   • nonce + signature    → re-POST verify (the server keeps a 30 s replay
//                            window on the consumed nonce specifically for this)
//
// This is only set while a login is genuinely in progress and cleared on
// success, so a clean page load never auto-pops a signature prompt.
const PENDING_KEY = "totem_wallet_siwe";
const PENDING_TTL_MS = 5 * 60 * 1000; // matches the server nonce TTL

function readPending() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (
      !p?.nonce ||
      !p?.message ||
      Date.now() - (p.startedAt || 0) > PENDING_TTL_MS
    ) {
      clearPending();
      return null;
    }
    return p;
  } catch {
    return null;
  }
}
function savePending(p) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* sessionStorage unavailable — non-fatal */
  }
}
function clearPending() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* noop */
  }
}

/**
 * The whole SIWE login, made idempotent + resumable.
 *
 * 1. nonce   — fetch one (fresh) or reuse the one persisted before a reload.
 * 2. sign    — skipped if a signature was already captured; otherwise request
 *              personal_sign from the wallet over the AppKit provider.
 * 3. verify  — safe to retry; the server keeps a 30 s replay window on the
 *              consumed nonce so a post-reload re-verify still succeeds.
 *
 * A module-level promise coalesces concurrent calls (the "Sign in with wallet"
 * button and the on-mount auto-resume) into a single in-flight run.
 */
let inflightSIWE = null;
function runSIWE({ walletProvider, providerType, onDone, onError }) {
  if (inflightSIWE) return inflightSIWE;

  inflightSIWE = (async () => {
    try {
      let p = readPending();

      // Step 1: nonce (reuse the pre-reload one when resuming).
      if (!p) {
        const { nonce, message } = await System.walletNonce();
        if (!nonce || !message)
          throw new Error("Could not get signing message.");
        p = { nonce, message, startedAt: Date.now() };
        savePending(p);
        console.log(
          `[wallet:fe] nonce received (${String(nonce).slice(0, 8)}…), message ${message.length} chars`
        );
      } else {
        console.log(
          `[wallet:fe] resuming in-progress login — nonce ${String(p.nonce).slice(0, 8)}…, signature=${p.signature ? "yes" : "no"}`
        );
      }

      // Step 2: signature (only if we don't already have one).
      if (!p.signature) {
        // A freshly established WalletConnect session needs a beat to sync
        // with the relay; a sign request fired instantly can be dropped and
        // only surface on a later attempt. (Skip on a resume — the session is
        // already live, which is why the user can sign on the second tap.)
        if (providerType === "WALLET_CONNECT") {
          await new Promise((r) => setTimeout(r, 1200));
        }
        const ethersProvider = new BrowserProvider(walletProvider);
        const signer = await ethersProvider.getSigner();
        console.log(`[wallet:fe] dispatching signMessage via ${providerType}`);
        const signature = await signer.signMessage(p.message);
        if (!signature || signature === "0x")
          throw new Error("Signature was rejected.");
        p.signature = signature;
        savePending(p);
        console.log(
          `[wallet:fe] SIGNATURE RECEIVED (${signature.length} chars) — verifying`
        );
      }

      // Step 3: verify → JWT.
      const result = await System.walletVerify({
        signature: p.signature,
        nonce: p.nonce,
      });
      console.log(
        `[wallet:fe] verify response: valid=${result?.valid} hasToken=${!!result?.token} message=${result?.message || "none"}`
      );
      if (!result.valid || !result.token || !result.user) {
        const msg = result.message || "Wallet login failed.";
        if (/invalid or expired nonce/i.test(msg)) clearPending();
        throw new Error(msg);
      }

      clearPending();
      window.localStorage.setItem(AUTH_USER, JSON.stringify(result.user));
      window.localStorage.setItem(AUTH_TOKEN, result.token);
      onDone?.();
      window.location = paths.home();
    } catch (e) {
      if (e?.code === "ACTION_REJECTED") {
        console.log("[wallet:fe] user rejected the signature in the wallet");
        clearPending();
      } else {
        console.error(
          `[wallet:fe] SIWE flow error: ${e?.code || ""} ${e?.message || e}`
        );
      }
      onError?.(e?.message || "Wallet login failed.");
      throw e;
    } finally {
      inflightSIWE = null;
    }
  })();

  return inflightSIWE;
}

export default function WalletConnectMobile() {
  // Android: don't offer cross-app WalletConnect as the primary path — it
  // loses the signature on the hand-back reload every time (see the platform
  // note at the top of this file). Hand off to MetaMask's browser instead.
  if (IS_ANDROID && !HAS_INJECTED) {
    return <AndroidMetaMaskHandoff />;
  }

  if (!projectId || !appKitInstance) {
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

  return <AppKitWalletLogin />;
}

/**
 * Mobile OS rules prevent a web page from programmatically bringing the
 * wallet app to the foreground — so after we fire the personal_sign request,
 * the approval prompt sits inside the wallet app while the user is still
 * looking at the browser. The wallet's own deep link (from the WalletConnect
 * session peer metadata, e.g. "metamask://") lets the user switch back with
 * one tap, inside a genuine user gesture, to approve the pending signature.
 */
function getWalletDeepLink(provider) {
  const session = provider?.session || provider?.provider?.session;
  const redirect = session?.peer?.metadata?.redirect;
  return redirect?.native || redirect?.universal || null;
}

/**
 * Android hand-off: send the user into MetaMask's built-in dapp browser via
 * the universal link. There, window.ethereum is injected and the in-page
 * "Connect Wallet in Browser" button (MultiUserAuth) runs the normal
 * nonce → personal_sign → verify flow — no WalletConnect, no relay, no
 * cross-app reload race. One app switch, one approval.
 */
function AndroidMetaMaskHandoff() {
  const [showOther, setShowOther] = useState(false);
  const [hint, setHint] = useState(null);

  const openInMetaMask = () => {
    const target =
      window.location.pathname + window.location.search + window.location.hash;
    window.location.href = `https://metamask.app.link/dapp/${window.location.host}${target}`;
    // If MetaMask isn't installed the universal link sends the user to the
    // Play Store; if we're still here a moment later, tell them why.
    setTimeout(() => {
      setHint(
        "MetaMask didn't open — is it installed? You can also open this site in any wallet app's built-in browser (Trust, Base, etc.)."
      );
    }, 2500);
  };

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
        onClick={openInMetaMask}
        className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[38px] w-full flex items-center justify-center transition-colors"
      >
        Continue in MetaMask
      </button>
      <p className="text-zinc-500 light:text-slate-400 text-xs text-center mt-2 leading-relaxed">
        Opens this page in MetaMask's built-in browser to sign you in.
      </p>
      {hint && <p className="text-red-400 text-xs mt-2 text-center">{hint}</p>}

      {showOther ? (
        <AppKitWalletLogin />
      ) : (
        <button
          type="button"
          onClick={() => setShowOther(true)}
          className="text-zinc-500 light:text-slate-400 hover:text-sky-300 light:hover:text-sky-600 hover:underline text-xs mx-auto flex mt-2"
        >
          Use a different wallet app (WalletConnect)
        </button>
      )}
    </div>
  );
}

/**
 * Separate component so AppKit hooks always run under an initialized
 * AppKit instance (hooks throw if createAppKit hasn't been called).
 */
function AppKitWalletLogin() {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider, walletProviderType } = useAppKitProvider("eip155");
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState(null);
  const resumedRef = useRef(false); // only auto-resume once per page load

  const walletDeepLink = getWalletDeepLink(walletProvider);

  // Diagnostic aid: confirm the peer redirect is being read off the session.
  useEffect(() => {
    if (walletProviderType === "WALLET_CONNECT") {
      console.log(
        `[wallet:fe] connected via WALLET_CONNECT — deep link: ${walletDeepLink || "(none exposed by session)"}`
      );
    }
  }, [walletProviderType, walletDeepLink]);

  const handleError = (msg) => {
    console.error(`[wallet:fe] handleError: ${msg}`);
    setSigning(false);
    setError(msg);
  };

  // Manual "Sign in with wallet": always a FRESH attempt (new nonce). The
  // runSIWE promise manages its own signing/verify state + React updates via
  // onDone/onError; we await it only to surface an unexpected throw.
  const startFresh = async () => {
    if (!walletProvider) {
      setError("Wallet not connected yet.");
      return;
    }
    setError(null);
    setSigning(true);
    clearPending();
    try {
      await runSIWE({
        walletProvider,
        providerType: walletProviderType,
        onDone: () => setSigning(false),
        onError: handleError,
      });
    } catch {
      /* already reported via onError */
    }
  };

  // AUTO-RESUME after the MetaMask Android hand-back reload: if a login was
  // in progress (pending nonce in sessionStorage) and AppKit has reconnected
  // the wallet, finish it — re-request the signature if we don't have one yet,
  // otherwise just re-verify. Without this the user is stranded on the login
  // page after signing, which is the bug we're fixing.
  useEffect(() => {
    if (!isConnected || !address || !walletProvider) return;
    if (resumedRef.current) return;
    if (!readPending()?.nonce) return; // clean load → nothing to resume
    resumedRef.current = true;
    console.log(
      "[wallet:fe] found in-progress login after load — auto-resuming"
    );
    setSigning(true);
    runSIWE({
      walletProvider,
      providerType: walletProviderType,
      onDone: () => setSigning(false),
      onError: handleError,
    }).catch(() => {
      /* already reported via onError */
    });
  }, [isConnected, address, walletProvider, walletProviderType]);

  // Sanity check on connect tap: prove the phone can reach the backend at
  // all, independent of the wallet/relay flow (server logs "[wallet:ping]").
  const handleConnect = () => {
    setError(null);
    console.log("[wallet:fe] Connect tapped — opening AppKit wallet picker");
    System.walletPing().then((res) => {
      if (res?.ok) {
        console.log(
          `[wallet:fe] ping OK — server confirmed receipt (server ts=${res.ts})`
        );
      } else {
        console.error(
          `[wallet:fe] ping FAILED — phone browser cannot reach backend: ${res?.error || "no response"}`
        );
      }
    });
    // AppKit shows its wallet picker. On mobile it deep-links into the chosen
    // wallet (with its own cold-start/redirect handling); on desktop it shows
    // injected wallets + QR.
    open({ view: "Connect", namespace: "eip155" });
  };

  return (
    <div className="w-[300px] my-2">
      <div className="flex items-center w-full my-3">
        <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
        <span className="px-3 text-zinc-500 light:text-slate-400 text-xs">
          on mobile
        </span>
        <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
      </div>

      {isConnected && address ? (
        signing ? (
          <div className="flex flex-col gap-2">
            <div className="text-sky-400 text-xs text-center animate-pulse">
              Signature request sent — approve it in your wallet app.
            </div>
            {walletProviderType === "WALLET_CONNECT" &&
              (walletDeepLink ? (
                <button
                  type="button"
                  onClick={() => {
                    window.location.href = walletDeepLink;
                  }}
                  className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[38px] w-full flex items-center justify-center transition-colors"
                >
                  Open wallet app to approve
                </button>
              ) : (
                <p className="text-zinc-500 light:text-slate-400 text-xs text-center leading-relaxed">
                  Switch to your wallet app now — the signature request is
                  waiting there.
                </p>
              ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={startFresh}
            className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[38px] w-full flex items-center justify-center transition-colors"
          >
            Sign in with wallet
          </button>
        )
      ) : (
        <button
          type="button"
          onClick={handleConnect}
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[38px] w-full flex items-center justify-center transition-colors"
        >
          Connect Mobile Wallet
        </button>
      )}

      {error && (
        <p className="text-red-400 text-xs mt-2 text-center">{error}</p>
      )}
    </div>
  );
}
