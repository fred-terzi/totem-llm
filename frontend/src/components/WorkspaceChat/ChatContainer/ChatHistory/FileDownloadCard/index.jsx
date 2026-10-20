import { memo, useEffect, useState } from "react";
import { saveAs } from "file-saver";
import { DownloadSimple, CircleNotch } from "@phosphor-icons/react";
import { humanFileSize } from "@/utils/numbers";
import StorageFiles from "@/models/files";

/**
 * @param {{content: {filename: string, storageFilename?: string, fileSize?: number}}} props
 */
function FileDownloadCard({ props }) {
  const { filename, storageFilename, fileSize, sandboxFile } =
    props.content || {};
  const { badge, badgeBg, badgeText, fileType } = getFileDisplayInfo(filename);
  const [downloading, setDownloading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const isImage = isImageFile(filename);

  // For sandbox images, fetch the bytes once and render an inline preview.
  // The raw endpoint streams with Content-Disposition: inline so the blob is
  // the actual image; we only preview sandbox images the current session is
  // authorized to read (the endpoint enforces sandbox scoping server-side).
  useEffect(() => {
    let revoked = false;
    let objectUrl = null;
    async function loadPreview() {
      if (!isImage || !sandboxFile || !storageFilename) return;
      const blob = await StorageFiles.download(storageFilename, true);
      if (!blob || revoked) return;
      objectUrl = URL.createObjectURL(blob);
      setPreviewUrl(objectUrl);
    }
    loadPreview();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isImage, sandboxFile, storageFilename]);

  const handleDownload = async () => {
    if (downloading) return;
    if (!storageFilename) return;

    setDownloading(true);
    try {
      // Sandbox files (e.g. agent-generated images in the per-user agent
      // filesystem) are fetched through the session-authenticated
      // /filesystem/read raw endpoint; agent-generated-files keep the
      // legacy /agent-skills/generated-files route.
      const blob = await StorageFiles.download(storageFilename, !!sandboxFile);
      if (!blob) throw new Error("Failed to download file");
      saveAs(blob, filename || storageFilename);
    } catch {
      console.error("Failed to download file");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex justify-center w-full my-2">
      <div className="w-full max-w-[750px] mr-4">
        <div className="flex items-center justify-between bg-zinc-800 light:bg-slate-100 light:border light:border-slate-200/50 rounded-xl px-2 py-1">
          <div className="flex items-center gap-x-3 min-w-0">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={filename || "Generated image"}
                className="rounded-lg flex-shrink-0 h-[48px] w-[48px] object-cover border border-zinc-600/50 light:border-slate-300"
              />
            ) : (
              <div
                className={`${badgeBg} ${badgeText} rounded-lg flex items-center justify-center flex-shrink-0 h-[48px] w-[48px] text-xs font-bold`}
              >
                {badge}
              </div>
            )}
            <div className="flex flex-col min-w-0">
              <p className="text-white light:text-slate-900 text-sm font-medium truncate leading-snug">
                {filename || "Unknown file"}
              </p>
              <p className="text-zinc-400 light:text-slate-500 text-xs leading-snug">
                {humanFileSize(fileSize, true, 1)}
                {fileSize && fileType ? " · " : ""}
                {fileType}
              </p>
            </div>
          </div>
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="flex items-center gap-x-2 px-4 py-2 rounded-lg border border-zinc-600 light:border-theme-sidebar-border hover:bg-zinc-700 light:hover:bg-theme-bg-secondary transition-colors text-white light:text-theme-text-primary text-sm font-medium flex-shrink-0 ml-4 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {downloading ? (
              <CircleNotch size={16} weight="bold" className="animate-spin" />
            ) : (
              <DownloadSimple size={16} weight="bold" />
            )}
            <span>{downloading ? "Downloading..." : "Download"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Whether a filename is a browser-renderable image extension.
 * @param {string} filename
 * @returns {boolean}
 */
function isImageFile(filename) {
  const extension = filename?.split(".")?.pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(extension);
}

/**
 * Get display info for a file based on its extension
 * @param {string} filename
 * @returns {{badge: string, badgeBg: string, badgeText: string, fileType: string}}
 */
function getFileDisplayInfo(filename) {
  const extension = filename?.split(".")?.pop()?.toLowerCase() ?? "txt";
  switch (extension) {
    case "pptx":
    case "ppt":
      return {
        badge: "PPT",
        badgeBg: "bg-orange-100",
        badgeText: "text-orange-700",
        fileType: "PowerPoint",
      };
    case "pdf":
      return {
        badge: "PDF",
        badgeBg: "bg-red-100",
        badgeText: "text-red-700",
        fileType: "PDF Document",
      };
    case "doc":
    case "docx":
      return {
        badge: "DOC",
        badgeBg: "bg-blue-100",
        badgeText: "text-blue-700",
        fileType: "Word Document",
      };
    case "xls":
    case "xlsx":
      return {
        badge: "XLS",
        badgeBg: "bg-green-100",
        badgeText: "text-green-700",
        fileType: "Spreadsheet",
      };
    case "csv":
      return {
        badge: "CSV",
        badgeBg: "bg-green-100",
        badgeText: "text-green-700",
        fileType: "Spreadsheet",
      };
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
      return {
        badge: "IMG",
        badgeBg: "bg-purple-100",
        badgeText: "text-purple-700",
        fileType: "Image",
      };
    default:
      return {
        badge: extension.toUpperCase().slice(0, 4),
        badgeBg: "bg-slate-200",
        badgeText: "text-slate-700",
        fileType: "File",
      };
  }
}

export default memo(FileDownloadCard);
