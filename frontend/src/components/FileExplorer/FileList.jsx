import React from "react";
import {
  Folder,
  File,
  FileText,
  FileCode,
  Image as ImageIcon,
  FilePdf,
  MusicNote,
  Video,
} from "@phosphor-icons/react";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";

/**
 * Pick a Phosphor icon for a file based on its MIME type.
 * Folders always get the Folder icon.
 */
function iconFor(entry) {
  if (entry.type === "dir") {
    return <Folder className="h-4 w-4 shrink-0 text-amber-400" weight="fill" />;
  }
  const mime = entry.mime || "";
  if (mime.startsWith("image/"))
    return <ImageIcon className="h-4 w-4 shrink-0 text-emerald-400" />;
  if (mime === "application/pdf")
    return <FilePdf className="h-4 w-4 shrink-0 text-red-400" />;
  if (mime.startsWith("audio/"))
    return <MusicNote className="h-4 w-4 shrink-0 text-sky-400" />;
  if (mime.startsWith("video/"))
    return <Video className="h-4 w-4 shrink-0 text-fuchsia-400" />;
  if (
    mime.startsWith("text/x-") ||
    mime === "text/javascript" ||
    mime === "text/typescript" ||
    mime === "text/tsx" ||
    mime === "text/jsx" ||
    mime === "application/json"
  )
    return <FileCode className="h-4 w-4 shrink-0 text-blue-400" />;
  if (mime === "text/markdown" || mime === "text/plain")
    return <FileText className="h-4 w-4 shrink-0 text-zinc-400" />;
  return <File className="h-4 w-4 shrink-0 text-zinc-400" />;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Directory listing.
 *
 * Props:
 *   entries       – array from the list endpoint (server pre-sorted)
 *   loading       – true while the listing is being fetched
 *   onDirClick    – (name: string) => void
 *   onFileClick   – (name: string) => void
 *   selectedFile  – name of the currently selected file (or null)
 */
export default function FileList({
  entries = [],
  loading = false,
  onDirClick,
  onFileClick,
  selectedFile = null,
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-y-2 py-2" aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2">
            <Skeleton.default height={16} width={16} circle />
            <Skeleton.default height={14} width="60%" />
            <Skeleton.default height={14} width={40} className="ml-auto" />
          </div>
        ))}
      </div>
    );
  }

  if (!loading && entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-y-2 py-10 text-center">
        <Folder
          className="h-10 w-10 text-theme-text-secondary opacity-50"
          weight="light"
        />
        <p className="text-sm text-theme-text-secondary">
          This folder is empty
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col">
      {entries.map((entry) => {
        const isSelected = entry.type === "file" && entry.name === selectedFile;
        const rowClass = `group flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
          isSelected
            ? "bg-primary-button/20 ring-1 ring-primary-button/40"
            : "hover:bg-white/10 light:hover:bg-black/5"
        }`;
        return (
          <li key={entry.name}>
            <button
              type="button"
              onClick={() =>
                entry.type === "dir"
                  ? onDirClick(entry.name)
                  : onFileClick(entry.name)
              }
              className={`${rowClass} w-full text-left`}
            >
              <span className="flex-shrink-0">{iconFor(entry)}</span>
              <span className="flex-1 min-w-0 truncate text-sm leading-[20px] text-theme-text-primary">
                {entry.name}
              </span>
              <span className="hidden sm:inline flex-shrink-0 text-xs text-theme-text-secondary w-[68px] text-right tabular-nums">
                {entry.type === "dir" ? "—" : entry.sizeFormatted || "—"}
              </span>
              <span className="hidden md:inline flex-shrink-0 text-xs text-theme-text-secondary w-[92px] text-right">
                {formatDate(entry.modified)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
