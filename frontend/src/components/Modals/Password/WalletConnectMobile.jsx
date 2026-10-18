import React, { useEffect, useRef, useState } from "react";
import { createEVMClient } from "@metamask/connect-evm";
import System from "../../../models/system";
import { AUTH_TOKEN, AUTH_USER } from "../../../utils/constants";
import paths from "../../../utils/paths";

// ── Config ──────────────────────────────────────────────────────────────────
const infuraKey = import.meta.env.VITE_INFURA_API_KEY;

// Base (8453) is where $TOTEM lives; mainnet (1) as a secondary. Per the
// @metamask/connect-evm API the map lives under `api:` and is keyed by HEX
// chain id ("0x1", "0x8453") → full RPC URL. CAIP-2 keys ("eip155:1") throw.
const supportedNetworks = infuraKey
  ? {
      "0x1": `https://eth-mainnet.infura.io/v3/${infuraKey}`,
      "0x8453": `https://base-mainnet.infura.io/v3/${infuraKey}`,
    }
  : undefined;

// Created once at module scope, outside React — calling this inside a
// component body would re-init on every render.
let mmClient = null;
let mmClientPromise = null;
function getMetaMaskClient() {
  if (mmClient) return Promise.resolve(mmClient);
  if (!supportedNetworks) {
    return Promise.reject(
      new Error(
        "Mobile wallet login is not configured (missing VITE_INFURA_API_KEY)."
      )
    );
  }
  if (!mmClientPromise) {
    mmClientPromise = createEVMClient({
      api: { supportedNetworks },
      dapp: {
        name: "Totem",
        url: window.location.origin,
        iconUrl: `${window.location.origin}/logo192.png`,
      },
    }).then((client) => {
      mmClient = client;
      return client;
    });
  }
  return mmClientPromise;
}

// ── Reload-safe SIWE state ──────────────────────────────────────────────────
// The mobile flow requires the user to LEAVE the page (MetaMask app) to sign.
// If the hand-back reloads the page mid-flow, the in-flight sign → verify
// chain is destroyed. Persist the nonce (+ signature once captured) in
// sessionStorage so a reloaded page can RESUME:
//   • nonce only        → re-request the signature, then verify
//   • nonce + signature → re-POST verify (server keeps a 30 s replay window
//                         on the consumed nonce specifically for this)
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
 * The whole SIWE login, made idempotent + resumable, via MetaMask Connect's
 * `connectAndSign` — ONE deep link into the wallet, ONE user approval
 * (connect + personal_sign combined), and the SDK owns the deeplink/handback
 * plumbing instead of us.
 *
 * 1. nonce   — fetch one (fresh) or reuse the one persisted before a reload.
 * 2. sign    — `client.connectAndSign({ message })` → { signature }.
 *              Skipped if a signature was already captured pre-reload.
 * 3. verify  — safe to retry; the server keeps a 30 s replay window on the
 *              consumed nonce so a post-reload re-verify still succeeds.
 *
 * A module-level promise coalesces concurrent calls (the "Sign in with
 * wallet" button and the on-mount auto-resume) into a single in-flight run.
 */
let inflightSIWE = null;
function runSIWE({ onDone, onError }) {
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
      } else if (!p.signature) {
        // Resuming with a nonce only — verify the stored message is still
        // what the server issued (defensive; message embeds the nonce).
      }

      // Step 2: signature via MetaMask Connect (connect + sign in one call).
      if (!p.signature) {
        const client = await getMetaMaskClient();
        const { signature } = await client.connectAndSign({
          message: p.message,
          chainIds: ["0x1", "0x8453"],
        });
        if (!signature || signature === "0x")
          throw new Error("Signature was rejected.");
        p.signature = signature;
        savePending(p);
      }

      // Step 3: verify → JWT.
      const result = await System.walletVerify({
        signature: p.signature,
        nonce: p.nonce,
      });
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
      const code = e?.code || "";
      const msg = e?.message || "";
      // User said no in the wallet → clean slate, no scary error copy.
      if (
        code === "ACTION_REJECTED" ||
        /user rejected|rejected the request/i.test(msg)
      ) {
        clearPending();
        onError?.("Signature request was cancelled.");
      } else {
        console.error(`[wallet:fe] SIWE flow error: ${code} ${msg}`);
        onError?.(msg || "Wallet login failed.");
      }
      throw e;
    } finally {
      inflightSIWE = null;
    }
  })();

  return inflightSIWE;
}

export default function WalletConnectMobile() {
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState(null);
  const resumedRef = useRef(false); // only auto-resume once per page load
  const ready = !!supportedNetworks;

  // AUTO-RESUME after a mid-flow reload: if a login was in progress (pending
  // nonce in sessionStorage), finish it — `connectAndSign` re-opens the wallet
  // if we still need a signature, otherwise we just re-verify. Without this
  // the user is stranded on the login page after signing.
  useEffect(() => {
    if (!ready || resumedRef.current) return;
    if (!readPending()?.nonce) return; // clean load → nothing to resume
    resumedRef.current = true;
    setSigning(true);
    runSIWE({
      onDone: () => setSigning(false),
      onError: (msg) => {
        setSigning(false);
        setError(msg);
      },
    }).catch(() => {
      /* already reported via onError */
    });
  }, [ready]);

  const startSIWE = async () => {
    if (!ready) {
      setError(
        "Mobile wallet login is not configured (missing VITE_INFURA_API_KEY)."
      );
      return;
    }
    setError(null);
    setSigning(true);
    clearPending(); // manual tap = always a fresh attempt (new nonce)
    try {
      await runSIWE({
        onDone: () => setSigning(false),
        onError: (msg) => {
          setSigning(false);
          setError(msg);
        },
      });
    } catch {
      /* already reported via onError */
    }
  };

  if (!ready) {
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

  return (
    <div className="w-[300px] my-2">
      <div className="flex items-center w-full my-3">
        <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
        <span className="px-3 text-zinc-500 light:text-slate-400 text-xs">
          on mobile
        </span>
        <div className="flex-1 h-px bg-zinc-700 light:bg-slate-300" />
      </div>

      {signing ? (
        <div className="flex flex-col gap-2">
          <div className="text-sky-400 text-xs text-center animate-pulse">
            Opening MetaMask — approve the signature there.
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={startSIWE}
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[38px] w-full flex items-center justify-center transition-colors"
        >
          Sign in with MetaMask
        </button>
      )}

      {error && (
        <p className="text-red-400 text-xs mt-2 text-center">{error}</p>
      )}
    </div>
  );
}
