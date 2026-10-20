import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  FileText,
  FilePdf,
  File as FileIcon,
  MusicNote,
  Video,
  Warning,
  X,
} from "@phosphor-icons/react";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import DOMPurify from "@/utils/chat/purify";

/**
 * Build the raw-bytes URL for a file, honoring the configured `API_BASE`
 * (the server's `downloadUrl` assumes `/api`, which breaks if the client is
 * pointed at a different origin in dev).
 *
 * NOTE: this URL alone cannot be used directly in <img>/<embed>/<video>/<a>
 * elements — `/filesystem/read` is session-authenticated (multi-user mode
 * enforces the JWT `Authorization` header) and native browser element
 * requests cannot attach headers. Binary previews must fetch the bytes with
 * `baseHeaders()` via `useRawBlobUrl` and render from the object URL.
 *
 * @param {string} filePath - relative sandbox path
 * @returns {string} absolute-ish URL (only usable with an auth header attached)
 */
function rawUrl(filePath) {
  const base = API_BASE.endsWith("/") ? API_BASE.slice(0, -1) : API_BASE;
  return `${base}/filesystem/read?path=${encodeURIComponent(
    filePath
  )}&raw=true`;
}

/**
 * Authenticated raw-bytes loader for binary previews.
 *
 * Fetches `/filesystem/read?raw=true` with the session's baseHeaders and
 * yields an object URL for the blob. Needed because multi-user mode enforces
 * the JWT Authorization header on this endpoint, and <img>/<embed>/<video>
 * elements cannot send headers — a plain `src={rawUrl(...)}` 401s.
 *
 * @param {string|null} filePath - relative sandbox path (null = don't fetch)
 * @param {boolean} enabled - only fetch when true
 * @returns {string|null} object URL for the fetched bytes, or null while loading
 */
function useRawBlobUrl(filePath, enabled) {
  const [objectUrl, setObjectUrl] = useState(null);

  useEffect(() => {
    if (!filePath || !enabled) {
      setObjectUrl(null);
      return;
    }
    let revoked = false;
    let createdUrl = null;
    async function load() {
      try {
        const res = await fetch(rawUrl(filePath), { headers: baseHeaders() });
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
        const blob = await res.blob();
        if (revoked) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      } catch (e) {
        console.error("[FileViewer] raw fetch failed:", e);
      }
    }
    load();
    return () => {
      revoked = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      setObjectUrl(null);
    };
  }, [filePath, enabled]);

  return objectUrl;
}

function basename(p) {
  if (!p) return "file";
  const parts = p.split("/");
  return parts[parts.length - 1] || "file";
}

function isTextLike(mime) {
  return (
    (mime || "").startsWith("text/") ||
    mime === "application/json" ||
    mime === "image/svg+xml"
  );
}

function isMarkdown(mime) {
  return (
    mime === "text/markdown" ||
    mime === "text/x-markdown" ||
    mime === "text/vnd.github.markdown"
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-renderers (kept in the same file per plan §3.4)                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Markdown viewer (rendered + raw toggle)                            */
/* ------------------------------------------------------------------ */

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  highlight: function (str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch {}
    }
    return ""; // markdown-it will escape and wrap in <code>
  },
});

function MarkdownViewer({ content, truncated }) {
  const [mode, setMode] = useState("rendered"); // "rendered" | "raw"

  const html = useMemo(
    () =>
      mode === "rendered" && content
        ? DOMPurify.sanitize(md.render(content))
        : null,
    [mode, content]
  );

  return (
    <div className="flex flex-col gap-y-2">
      {truncated && (
        <div className="flex items-center gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2">
          <Warning className="h-4 w-4 shrink-0 text-amber-400" />
          <span className="text-xs leading-[18px] text-amber-300">
            File truncated — showing first 1 MB
          </span>
        </div>
      )}

      {/* Toggle pill */}
      <div className="flex items-center gap-x-1 self-start rounded-full bg-black/20 light:bg-slate-100 border border-white/10 light:border-slate-300 p-0.5">
        {[
          { key: "rendered", label: "Rendered" },
          { key: "raw", label: "Raw" },
        ].map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => setMode(opt.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              mode === opt.key
                ? "bg-theme-accent/20 text-theme-accent"
                : "text-theme-text-secondary hover:text-theme-text-primary"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Body */}
      {mode === "rendered" ? (
        <div
          className="max-h-[60vh] overflow-auto rounded-md bg-black/20 light:bg-slate-100 border border-white/10 light:border-slate-300 px-4 py-3 text-sm leading-6 text-theme-text-primary prose prose-invert light:prose max-w-none"
          dangerouslySetInnerHTML={{ __html: html || "" }}
        />
      ) : (
        <pre
          className="max-h-[60vh] overflow-auto rounded-md bg-black/20 light:bg-slate-100 border border-white/10 light:border-slate-300 px-3 py-2 text-xs leading-[18px] font-mono whitespace-pre-wrap break-words text-theme-text-primary"
          aria-label="Raw Markdown source"
        >
          {content}
        </pre>
      )}
    </div>
  );
}

function TextViewer({ content, truncated }) {
  return (
    <div className="flex flex-col gap-y-2">
      {truncated && (
        <div className="flex items-center gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2">
          <Warning className="h-4 w-4 shrink-0 text-amber-400" />
          <span className="text-xs leading-[18px] text-amber-300">
            File truncated — showing first 1 MB
          </span>
        </div>
      )}
      <pre
        className="max-h-[60vh] overflow-auto rounded-md bg-black/20 light:bg-slate-100 border border-white/10 light:border-slate-300 px-3 py-2 text-xs leading-[18px] font-mono whitespace-pre-wrap break-words text-theme-text-primary"
        aria-label="File contents"
      >
        {content}
      </pre>
    </div>
  );
}

function ImageViewer({ path, name }) {
  const blobUrl = useRawBlobUrl(path, !!path);
  if (!blobUrl) {
    return (
      <div className="flex items-center justify-center bg-black/10 light:bg-slate-100 rounded-md p-4 max-h-[60vh] overflow-auto">
        <span className="text-xs text-theme-text-secondary">
          Loading image...
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center bg-black/10 light:bg-slate-100 rounded-md p-4 max-h-[60vh] overflow-auto">
      <img
        src={blobUrl}
        alt={name}
        className="max-w-full max-h-[60vh] object-contain"
      />
    </div>
  );
}

function PdfViewer({ path, name }) {
  const blobUrl = useRawBlobUrl(path, !!path);
  return (
    <div className="flex flex-col gap-y-2">
      <div className="rounded-md bg-black/10 light:bg-slate-100 overflow-hidden">
        {blobUrl ? (
          <embed
            src={blobUrl}
            type="application/pdf"
            className="w-full h-[60vh]"
            style={{ border: "none" }}
          />
        ) : (
          <div className="flex items-center justify-center h-[60vh]">
            <span className="text-xs text-theme-text-secondary">
              Loading PDF...
            </span>
          </div>
        )}
      </div>
      {blobUrl && (
        <a
          href={blobUrl}
          download={name}
          className="inline-flex items-center gap-2 self-start text-xs text-theme-text-secondary hover:text-theme-text-primary"
        >
          <FilePdf className="h-4 w-4" />
          Open PDF in a new tab
        </a>
      )}
    </div>
  );
}

function AudioPlayer({ path }) {
  const blobUrl = useRawBlobUrl(path, !!path);
  return (
    <div className="flex flex-col gap-y-2 p-3">
      <div className="flex items-center gap-x-2 text-theme-text-primary">
        <MusicNote className="h-5 w-5 text-sky-400" />
        <span className="text-sm">Audio preview</span>
      </div>
      {blobUrl ? (
        <audio controls src={blobUrl} className="w-full" />
      ) : (
        <span className="text-xs text-theme-text-secondary">
          Loading audio...
        </span>
      )}
    </div>
  );
}

function VideoPlayer({ path }) {
  const blobUrl = useRawBlobUrl(path, !!path);
  return (
    <div className="flex flex-col gap-y-2 p-3">
      <div className="flex items-center gap-x-2 text-theme-text-primary">
        <Video className="h-5 w-5 text-fuchsia-400" />
        <span className="text-sm">Video preview</span>
      </div>
      {blobUrl ? (
        <video
          controls
          src={blobUrl}
          className="w-full max-h-[60vh] rounded-md bg-black"
        />
      ) : (
        <span className="text-xs text-theme-text-secondary">
          Loading video...
        </span>
      )}
    </div>
  );
}

function BinaryNotice({ size, sizeFormatted, url, name }) {
  const [downloading, setDownloading] = useState(false);
  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      // Authenticated fetch — a plain href 401s in multi-user mode because
      // native navigations cannot attach the Authorization header.
      const res = await fetch(url, { headers: baseHeaders() });
      if (!res.ok) throw new Error(`Failed to download file (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = name || "file";
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      console.error("[FileViewer] download failed:", e);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className="flex flex-col gap-y-3 p-4 rounded-md bg-black/10 light:bg-slate-100 border border-white/10 light:border-slate-300">
      <div className="flex items-center gap-2">
        <FileIcon className="h-5 w-5 text-zinc-400" />
        <span className="text-sm font-medium text-theme-text-primary">
          Binary file
        </span>
      </div>
      <p className="text-xs leading-[18px] text-theme-text-secondary">
        {name}
        {sizeFormatted
          ? ` — ${sizeFormatted}`
          : size != null
            ? ` — ${size} bytes`
            : ""}
        {" · "}This file type can't be previewed inline.
      </p>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="inline-flex items-center gap-2 self-start h-9 px-4 rounded-lg bg-zinc-50 text-zinc-950 light:bg-slate-900 light:text-white text-sm font-medium hover:bg-zinc-200 light:hover:bg-slate-800 transition-colors disabled:opacity-50"
      >
        <ArrowDown className="h-4 w-4" />
        {downloading ? "Downloading..." : "Download"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Public component                                                    */
/* ------------------------------------------------------------------ */

/**
 * FileViewer — renders the content of a selected file.
 *
 * Props:
 *   data    – the JSON response from GET /filesystem/read
 *             { path, mime, size, sizeFormatted?, content, truncated, downloadUrl }
 *   onClose – optional; if provided, renders a close button (for mobile
 *             single-pane mode where the viewer slides in over the list).
 */
export default function FileViewer({ data, onClose }) {
  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center gap-y-2 py-16 text-center">
        <FileText
          className="h-8 w-8 text-theme-text-secondary opacity-50"
          weight="light"
        />
        <p className="text-sm text-theme-text-secondary">
          Select a file to preview it here.
        </p>
      </div>
    );
  }

  const name = basename(data.path);
  const url = rawUrl(data.path);

  let body;
  if (isMarkdown(data.mime)) {
    body = (
      <MarkdownViewer
        content={data.content || ""}
        truncated={!!data.truncated}
      />
    );
  } else if (isTextLike(data.mime)) {
    body = (
      <TextViewer content={data.content || ""} truncated={!!data.truncated} />
    );
  } else if ((data.mime || "").startsWith("image/")) {
    body = <ImageViewer path={data.path} name={name} />;
  } else if (data.mime === "application/pdf") {
    body = <PdfViewer path={data.path} name={name} />;
  } else if ((data.mime || "").startsWith("audio/")) {
    body = <AudioPlayer path={data.path} />;
  } else if ((data.mime || "").startsWith("video/")) {
    body = <VideoPlayer path={data.path} />;
  } else {
    body = (
      <BinaryNotice
        size={data.size}
        sizeFormatted={data.sizeFormatted}
        url={url}
        name={name}
      />
    );
  }

  return (
    <div className="flex flex-col gap-y-3 h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-x-3 border-b border-white/10 light:border-slate-300 pb-2">
        <div className="flex flex-col min-w-0">
          <p className="text-sm font-semibold text-theme-text-primary truncate">
            {name}
          </p>
          <p className="text-xs text-theme-text-secondary truncate">
            {data.mime}
            {data.sizeFormatted ? ` · ${data.sizeFormatted}` : ""}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-2 rounded-md hover:bg-white/10 light:hover:bg-black/10 text-theme-text-secondary"
            aria-label="Close preview"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto">{body}</div>
    </div>
  );
}
