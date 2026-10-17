import React from "react";
import { CaretRight, HardDrives } from "@phosphor-icons/react";

/**
 * Breadcrumb navigation for the file explorer.
 *
 * Renders a clickable trail of segments.  All segments except the last are
 * navigable links (to the parent path).  The last segment is the current
 * directory and rendered as plain bold text.
 *
 * Props:
 *   path      – relative path string, e.g. "docs/specs"  ("" = root)
 *   onNavigate – (targetPath: string) => void
 */
export default function Breadcrumb({ path = "", onNavigate }) {
  const segments = path ? path.split("/").filter(Boolean) : [];

  // Build the path prefix up to (and including) each segment.
  const trail = segments.map((seg, i) => segments.slice(0, i + 1).join("/"));

  return (
    <nav
      aria-label="File path"
      className="flex items-center flex-wrap gap-y-1 text-sm leading-[20px] min-h-[28px]"
    >
      {/* Root — always clickable */}
      <button
        type="button"
        onClick={() => onNavigate("")}
        className={`inline-flex items-center gap-1 px-1 py-0.5 rounded transition-colors ${
          segments.length === 0
            ? "text-theme-text-primary font-semibold cursor-default"
            : "text-theme-text-secondary hover:text-theme-text-primary hover:bg-white/10 light:hover:bg-black/10"
        }`}
        tabIndex={segments.length === 0 ? -1 : 0}
      >
        <HardDrives className="h-3.5 w-3.5 shrink-0" />
        <span>{segments.length === 0 ? "Root" : "root"}</span>
      </button>

      {segments.map((seg, i) => (
        <React.Fragment key={trail[i]}>
          <CaretRight className="h-3.5 w-3.5 shrink-0 text-theme-text-secondary mx-0.5" />
          {i === segments.length - 1 ? (
            /* Last segment — current location, non-clickable */
            <span className="px-1 py-0.5 font-semibold text-theme-text-primary truncate max-w-[180px]">
              {seg}
            </span>
          ) : (
            /* Intermediate segment — clickable */
            <button
              type="button"
              onClick={() => onNavigate(trail[i])}
              className="px-1 py-0.5 rounded transition-colors text-theme-text-secondary hover:text-theme-text-primary hover:bg-white/10 light:hover:bg-black/10 truncate max-w-[120px]"
            >
              {seg}
            </button>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
