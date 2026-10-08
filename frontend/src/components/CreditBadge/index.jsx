import React from "react";
import { Coins } from "@phosphor-icons/react";

/**
 * CreditBadge — displays the user's credit balance with a coin icon.
 *
 * - Coin icon: phosphor `Coins` icon.
 * - Default balance: 100,000 credits (used when the `credits` prop is not
 *   provided or is null/undefined).
 * - The balance is formatted with thousands separators (e.g. `100,000`).
 *
 * The badge is intentionally stateless and presentational — the parent is
 * responsible for supplying the live credit balance and (optionally) an
 * `onClick` handler (e.g. to open a "Buy credits" flow).
 *
 * @param {object}   props
 * @param {number|null|undefined} props.credits   Current credit balance. Falls back to `DEFAULT_CREDITS` when nullish.
 * @param {() => void}            [props.onClick] Optional click handler (e.g. open purchase dialog).
 * @param {string}                [props.title]   Optional custom tooltip.
 */
export default function CreditBadge({ credits, onClick, title, ...rest }) {
  const value =
    credits === null || credits === undefined ? DEFAULT_CREDITS : credits;
  const formatted = formatCredits(value);

  const tooltip = title ?? `${formatted} credits — click to buy more`;

  return (
    <button
      type="button"
      data-testid="credit-badge"
      onClick={onClick}
      title={tooltip}
      aria-label={`${formatted} credits`}
      className="flex items-center gap-1.5 h-[35px] px-3 rounded-full border border-white/10 bg-theme-bg-secondary/90 light:bg-white/80 text-white light:text-slate-800 text-xs font-medium shadow-sm shrink-0 cursor-pointer hover:border-white/20 light:hover:border-slate-300 transition-colors"
      {...rest}
    >
      <Coins
        className="text-amber-400 light:text-amber-500"
        size={16}
        weight="fill"
        aria-hidden="true"
      />
      <span className="tabular-nums whitespace-nowrap">{formatted}</span>
    </button>
  );
}

/** Default credit balance shown before a real value is available. */
export const DEFAULT_CREDITS = 100_000;

/**
 * Format a credit count with thousands separators.
 * @param {number} n
 * @returns {string}
 */
export function formatCredits(n) {
  if (!Number.isFinite(n)) return "0";
  // Credits are integer; truncate any float for display.
  return Math.trunc(n).toLocaleString("en-US");
}
