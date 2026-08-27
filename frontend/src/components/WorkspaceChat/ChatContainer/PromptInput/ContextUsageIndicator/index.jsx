import React from "react";
import { Tooltip } from "react-tooltip";
import Workspace from "@/models/workspace";

/**
 * Compact indicator showing how much of the model's context window is in use.
 * `used` is the most recent turn's reported prompt token count; `max` is the
 * workspace's resolved context window size (provider-reported or default).
 *
 * Renders nothing when there is no usable data so it never clutters the input
 * for workspaces with unknown window sizes.
 *
 * @param {{used: number|null, max: number|null, model?: string}} props
 */
export default function ContextUsageIndicator({
  used = null,
  max = null,
  model = null,
}) {
  const hasData = Number.isFinite(used) && used > 0;
  if (!hasData || !Number.isFinite(max) || max <= 0) return null;

  const ratio = Math.min(used / max, 1);
  // Reuse the same threshold convention as the attachment token limit so the
  // color language is consistent across the app.
  const state =
    ratio >= Workspace.maxContextWindowLimit
      ? "warning"
      : ratio > 0.5
        ? "mid"
        : "ok";

  const barColor = {
    ok: "bg-green-500",
    mid: "bg-yellow-500",
    warning: "bg-orange-500",
  }[state];
  const textClass = {
    ok: "text-zinc-400 light:text-slate-500",
    mid: "text-yellow-600 light:text-yellow-700",
    warning: "text-orange-600 light:text-orange-700",
  }[state];

  return (
    <div
      className="flex items-center gap-x-1.5"
      data-tooltip-id="context-usage-indicator"
      data-tooltip-content={`${used.toLocaleString()} / ${max.toLocaleString()} tokens${model ? ` · ${model}` : ""}`}
      aria-label={`Context window: ${used.toLocaleString()} of ${max.toLocaleString()} tokens used`}
    >
      <div className="w-12 h-1.5 rounded-full bg-zinc-700 light:bg-slate-300 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${Math.max(ratio * 100, 4)}%` }}
        />
      </div>
      <span
        className={`text-[10px] font-mono leading-none whitespace-nowrap ${textClass}`}
      >
        {formatTokenCount(used)}/{formatTokenCount(max)}
      </span>
      <Tooltip id="context-usage-indicator" place="top" delayShow={300} />
    </div>
  );
}

/**
 * Compact token count formatting: 1234 → "1.2k", 98765 → "98.8k".
 */
function formatTokenCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
