import React, { useCallback, useEffect, useRef, useState } from "react";
import { Coins, ArrowClockwise, Warning } from "@phosphor-icons/react";
import System from "@/models/system";
import { useTranslation } from "react-i18next";

/**
 * Compact $TOTEM badge shown at the top of the UI (next to the user menu).
 * The badge is always visible while the app is loaded. Its state is one of:
 *
 * - loading       → placeholder with a spinning refresh icon (first fetch)
 * - holder        → wallet holds $TOTEM: shows `amount SYMBOL`
 * - non-holder    → user isn't signed in with a wallet, the wallet holds 0
 *                   $TOTEM, or the server has no $TOTEM token configured
 * - error         → on-chain read failed (shows retry affordance)
 *
 * The balance is read from the server, which reads it on-chain (Base) for
 * the wallet address stored on the account at login time. The badge fetches
 * once on mount and offers a manual refresh.
 */
export default function TotemBalanceBadge() {
  const { t } = useTranslation();
  const [state, setState] = useState({ status: "loading" });
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const result = await System.totemBalance();
    if (!mounted.current) return;

    if (!result?.configured)
      return setState({ status: "non-holder", reason: "unconfigured" });
    if (result.noWallet)
      return setState({ status: "non-holder", reason: "no-wallet" });
    if (result.available) {
      // A wallet that holds zero $TOTEM is a non-holder.
      if (isZeroAmount(result.amount))
        return setState({ status: "non-holder", reason: "zero-balance" });
      return setState({ status: "holder", ...result });
    }
    setState({ status: "error", ...result });
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const isSpinning = state.status === "loading";
  const symbol = state.symbol || "TOTEM";
  const isHolder = state.status === "holder";

  const tooltip = isHolder
    ? `${state.amount} ${symbol} (0x${state.tokenAddress?.slice(2, 10)}…${state.tokenAddress?.slice(-4)})`
    : state.status === "non-holder"
      ? t("totem-balance.non-holder.tooltip", {
          symbol,
          defaultValue: "Not a ${{symbol}} holder",
        })
      : t("totem-balance.error", {
          symbol,
          defaultValue: "${{symbol}} balance unavailable — click to retry",
        });

  return (
    <div
      data-testid="totem-balance-badge"
      className="absolute top-3 right-[72px] md:top-9 md:right-[88px] z-40 flex items-center gap-x-1.5 h-[35px] px-3 rounded-full border border-white/10 bg-theme-bg-secondary/90 light:bg-white/80 text-white light:text-slate-800 text-xs font-medium shadow-sm"
    >
      <Coins
        size={14}
        weight="fill"
        className={
          isHolder
            ? "text-amber-400 light:text-amber-500"
            : "text-amber-400/40 light:text-amber-500/40"
        }
      />
      {state.status === "loading" ? (
        <span className="text-white/60 light:text-slate-500 whitespace-nowrap">
          {symbol}
        </span>
      ) : isHolder ? (
        <span className="tabular-nums whitespace-nowrap" title={tooltip}>
          {formatAmount(state.amount)} {symbol}
        </span>
      ) : state.status === "non-holder" ? (
        <span
          className="tabular-nums text-white/60 light:text-slate-500 whitespace-nowrap"
          title={tooltip}
        >
          0
        </span>
      ) : (
        <span
          className="text-white/60 light:text-slate-500 whitespace-nowrap"
          title={tooltip}
        >
          {symbol} —
        </span>
      )}
      <button
        type="button"
        onClick={load}
        disabled={isSpinning}
        aria-label={t("totem-balance.refresh", {
          defaultValue: "Refresh $TOTEM balance",
        })}
        className="flex items-center justify-center rounded-full hover:bg-white/10 light:hover:bg-black/10 transition-colors p-0.5 disabled:opacity-50"
      >
        <ArrowClockwise
          size={12}
          className={isSpinning ? "animate-spin" : ""}
        />
      </button>
      {state.status === "error" && (
        <Warning size={12} weight="fill" className="text-amber-400" />
      )}
    </div>
  );
}

/**
 * True when a decimal balance string represents zero (e.g. "0", "0.000").
 * A balance of 0.0001 is NOT zero — it is a holder.
 * @param {string|number|bigint} amount
 */
function isZeroAmount(amount) {
  if (amount === null || amount === undefined) return true;
  const str = String(amount).trim();
  if (!str) return true;
  // Any non-zero digit means a positive balance.
  return !/[1-9]/.test(str);
}

/**
 * Compact display formatting — keeps the badge narrow while the tooltip
 * carries the full precision value.
 * @param {string} amount - decimal string, e.g. "1.23456789"
 */
function formatAmount(amount) {
  const [whole, fraction = ""] = String(amount).split(".");
  if (!fraction) return whole;
  const short = fraction.slice(0, 4).replace(/0+$/, "") || "0";
  return `${whole}.${short}`;
}
