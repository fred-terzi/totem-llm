import React, { useCallback, useEffect, useRef, useState } from "react";
import System from "@/models/system";
import { useTranslation } from "react-i18next";

/**
 * Compact $TOTEM level badge shown at the top of the UI (next to the user menu).
 * The badge is always visible while the app is loaded. Its state is one of:
 *
 * - loading    → placeholder showing just the symbol (first fetch)
 * - holder     → wallet holds $TOTEM: shows a holding tier (see below)
 * - non-holder → user isn't signed in with a wallet, the wallet holds 0
 *                $TOTEM, or the server has no $TOTEM token configured → 'NH'
 * - error      → on-chain read failed (symbol shown muted)
 *
 * Holding tiers (exact balance stays in the tooltip):
 * - 0         → 'NH'  (not holding)
 * - >0, <500k → 'L1'
 * - >500k     → 'L2'
 * - >1M       → 'MAX'
 *
 * The balance is read from the server, which reads it on-chain (Base) for the
 * wallet address stored on the account at login time. The badge fetches once
 * on mount; clicking the pill retries the fetch (that is the only refresh
 * affordance — there is no dedicated refresh button).
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

  const label =
    state.status === "loading"
      ? symbol
      : isHolder
        ? holdingsTier(state.amount)
        : state.status === "non-holder"
          ? "NH"
          : symbol;

  return (
    <button
      type="button"
      data-testid="totem-balance-badge"
      onClick={isSpinning ? undefined : load}
      disabled={isSpinning}
      title={tooltip}
      aria-label={
        isHolder
          ? t("totem-balance.holder.aria", {
              tier: holdingsTier(state.amount),
              defaultValue: "{{tier}} ${{symbol}} holder — click to refresh",
            })
          : t("totem-balance.non-holder.aria", {
              defaultValue: "Not a ${{symbol}} holder",
            })
      }
      className="flex items-center h-[35px] px-3 rounded-full border border-white/10 bg-theme-bg-secondary/90 light:bg-white/80 text-white light:text-slate-800 text-xs font-medium shadow-sm shrink-0 cursor-pointer hover:border-white/20 light:hover:border-slate-300 transition-colors disabled:cursor-default"
    >
      <span
        className={
          isHolder
            ? "tabular-nums whitespace-nowrap"
            : "tabular-nums whitespace-nowrap text-white/60 light:text-slate-500"
        }
      >
        {label}
      </span>
    </button>
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
 * Maps a decimal $TOTEM balance to its display tier.
 * - 0 / non-positive / unparseable → 'L1' (a positive balance is required for
 *   L2/MAX; zero-balance wallets never reach here — they render as non-holder)
 * - >0, <500k  → 'L1'
 * - >500k      → 'L2'
 * - >1M        → 'MAX'
 * @param {string|number|bigint} amount - decimal balance string, e.g. "1234.56"
 * @returns {"L1"|"L2"|"MAX"}
 */
function holdingsTier(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "L1";
  if (n > 1_000_000) return "MAX";
  if (n >= 500_000) return "L2";
  return "L1";
}
