import React from "react";
import { Coins } from "@phosphor-icons/react";
import { useCredits } from "@/context/CreditContext";

/**
 * CreditBadge — displays the user's credit balance with a coin icon.
 *
 * "Credits" is the customer-facing unit: 1 credit = $0.001 = 1 000 µ$
 * (single source of truth: `server/utils/credits/units.js`). The badge shows
 * the server-converted credit integer and never exposes the underlying
 * microdollar value — the server owns all µ$→credits conversion at the
 * `GET /credits` boundary; this component performs no unit math.
 *
 * Value resolution (in order):
 *   1. An explicit `credits` prop, when provided — useful for previews/tests or
 *      when a parent already holds the value.
 *   2. Otherwise the live balance from <CreditProvider /> (fetched from the
 *      server and kept in sync after each chat turn).
 *
 * States:
 *   - Loading (no live value yet): renders a neutral "…" with `aria-busy` so we
 *     never show a hardcoded/misleading number before the real balance loads.
 *   - Loaded: renders the formatted balance (e.g. `100,000`).
 *   - Error (could not load and never did): renders a neutral "—" rather than a
 *     false "0".
 *
 * The badge is presentational; it does not own data-fetching.
 *
 * @param {object}  props
 * @param {number|null|undefined} [props.credits] Optional override balance. When omitted, the live context value is used.
 * @param {() => void}            [props.onClick] Optional click handler (e.g. open purchase dialog).
 * @param {string}                [props.title]   Optional custom tooltip.
 */
export default function CreditBadge({ credits, onClick, title, ...rest }) {
  const { credits: contextCredits, loading, error } = useCredits();

  // An explicit prop always wins (e.g. previews, tests, or a parent that owns
  // the value). When absent, fall back to the live context.
  const hasProp = credits !== null && credits !== undefined;
  const usingLive = !hasProp;

  let displayState; // "loading" | "loaded" | "unknown"
  if (hasProp) {
    displayState = "loaded";
  } else if (loading) {
    displayState = "loading";
  } else if (error && contextCredits === null) {
    displayState = "unknown";
  } else {
    displayState = "loaded";
  }

  const rawValue = hasProp ? credits : contextCredits;
  const formatted =
    displayState === "loaded" && rawValue !== null
      ? formatCredits(rawValue)
      : displayState === "loading"
        ? "…"
        : "—";

  const tooltip =
    title ??
    (displayState === "loading"
      ? "Loading your credits…"
      : displayState === "unknown"
        ? "Credits unavailable — try again"
        : `${formatted} credits — click to buy more`);

  return (
    <button
      type="button"
      data-testid="credit-badge"
      aria-busy={usingLive && displayState === "loading"}
      onClick={onClick}
      title={tooltip}
      aria-label={
        displayState === "loaded" ? `${formatted} credits` : "Loading credits"
      }
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

/**
 * Default credit balance, retained for backward compatibility with consumers
 * that reference this constant. The live badge no longer uses it as an
 * auto-fallback, since showing a hardcoded number before the real balance loads
 * would be misleading.
 */
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
