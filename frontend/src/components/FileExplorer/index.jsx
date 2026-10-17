import React, { useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import Breadcrumb from "./Breadcrumb";
import FileList from "./FileList";
import FileViewer from "./FileViewer";

/**
 * File Explorer — read-only browsing + preview of the current user's
 * sandbox (the same directory the filesystem agent uses).
 *
 * Layout:
 *   - Desktop (>768px): two-pane, list left (~40%), viewer right (~60%)
 *   - Mobile (≤768px): single pane, viewer slides in as an overlay
 *
 * All requests go through the existing `/api/filesystem/*` endpoints.
 */
export default function FileExplorer() {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState(null); // null = loading, [] = empty
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Selected file + its viewer data (only set on click)
  const [selectedFile, setSelectedFile] = useState(null); // name (for highlight)
  const [viewerData, setViewerData] = useState(null);
  const [viewerLoading, setViewerLoading] = useState(false);

  // Mobile overlay visibility (true when a file is selected on mobile)
  const [showViewerOverlay, setShowViewerOverlay] = useState(false);

  /* ------------------------- list fetching ------------------------- */

  const fetchList = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    setViewerData(null);
    try {
      const res = await fetch(
        `${API_BASE}/filesystem/list?path=${encodeURIComponent(path)}`,
        { headers: baseHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEntries([]);
        setError(data.message || data.error || "Unable to load this folder.");
        return;
      }
      setEntries(data.entries || []);
    } catch (e) {
      console.error("[FileExplorer] list failed:", e);
      setEntries([]);
      setError(e.message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchList(currentPath);
  }, [currentPath, fetchList]);

  /* ------------------------- file fetching ------------------------- */

  const fetchFile = useCallback(async (filePath) => {
    setViewerLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/filesystem/read?path=${encodeURIComponent(filePath)}`,
        { headers: baseHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || data.error || "Unable to read this file.");
        setViewerData(null);
        return;
      }
      setViewerData(data);
    } catch (e) {
      console.error("[FileExplorer] read failed:", e);
      setViewerData(null);
      setError(e.message || "Network error");
    } finally {
      setViewerLoading(false);
    }
  }, []);

  /* --------------------------- navigation -------------------------- */

  function navigateTo(dirName) {
    const newPath = currentPath ? `${currentPath}/${dirName}` : dirName;
    setShowViewerOverlay(false);
    setCurrentPath(newPath);
  }

  function goUp() {
    if (!currentPath) return;
    const parts = currentPath.split("/");
    parts.pop();
    setShowViewerOverlay(false);
    setCurrentPath(parts.join("/"));
  }

  function openFile(fileName) {
    const filePath = currentPath ? `${currentPath}/${fileName}` : fileName;
    setSelectedFile(fileName);
    setShowViewerOverlay(true);
    fetchFile(filePath);
  }

  function closeViewer() {
    setShowViewerOverlay(false);
    setSelectedFile(null);
    setViewerData(null);
  }

  /* ------------------------------ render --------------------------- */

  const desktopLayout = !isMobile;

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />

      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-hidden p-4 md:p-0 flex flex-col"
      >
        {/* ---------- Header ---------- */}
        <div className="w-full flex flex-col gap-y-2 px-4 md:pl-6 md:pr-[50px] md:pt-6 pt-12 pb-4 border-b border-white/10 light:border-slate-300">
          <div className="flex items-center justify-between gap-x-3">
            <div className="flex flex-col min-w-0">
              <p className="text-lg leading-6 font-bold text-theme-text-primary truncate">
                File Explorer
              </p>
              <p className="text-xs leading-[18px] font-base text-theme-text-secondary mt-1 truncate">
                Browse and preview files in your sandbox.
              </p>
            </div>
          </div>

          {/* Breadcrumb */}
          <div className="flex items-center gap-x-2">
            <button
              type="button"
              onClick={goUp}
              disabled={!currentPath}
              className="shrink-0 px-1.5 py-0.5 rounded text-sm text-theme-text-secondary hover:text-theme-text-primary hover:bg-white/10 light:hover:bg-black/10 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              aria-label="Up one level"
              title="Up one level"
            >
              ↑
            </button>
            <Breadcrumb
              path={currentPath}
              onNavigate={(p) => setCurrentPath(p)}
            />
          </div>
        </div>

        {/* ---------- Body ---------- */}
        <div className="flex-1 min-h-0 flex">
          {/* List pane */}
          <div
            className={`${
              desktopLayout
                ? "w-[40%] min-w-[280px] max-w-[480px] border-r border-white/10 light:border-slate-300"
                : "w-full"
            } flex flex-col min-h-0`}
          >
            <div className="flex-1 min-h-0 overflow-y-auto no-scroll py-2 px-2">
              {error && (
                <div className="mx-2 my-2 flex flex-col gap-y-1 rounded-md bg-red-500/10 border border-red-500/30 px-3 py-2">
                  <p className="text-xs font-medium text-red-400">
                    Couldn't load this folder
                  </p>
                  <p className="text-xs leading-[16px] text-theme-text-secondary break-all">
                    {error}
                  </p>
                </div>
              )}
              <FileList
                entries={entries || []}
                loading={loading}
                onDirClick={navigateTo}
                onFileClick={openFile}
                selectedFile={selectedFile}
              />
            </div>
          </div>

          {/* Viewer pane (desktop) */}
          {desktopLayout && (
            <div className="w-[60%] flex-1 min-h-0 flex flex-col px-5 py-4">
              {viewerLoading && (
                <div className="flex flex-col gap-y-3 py-4">
                  <div className="h-5 rounded bg-white/10 light:bg-black/10 w-1/3" />
                  <div className="h-64 rounded bg-white/5 light:bg-black/5" />
                </div>
              )}
              {!viewerLoading && (
                <FileViewer data={viewerData} onClose={closeViewer} />
              )}
            </div>
          )}
        </div>

        {/* ---------- Mobile viewer overlay ---------- */}
        {isMobile && (showViewerOverlay || viewerData || viewerLoading) && (
          <div className="fixed inset-0 z-50 flex flex-col bg-theme-bg-secondary">
            <div className="flex-1 min-h-0 flex flex-col px-3 py-3">
              {viewerLoading && (
                <div className="flex flex-col gap-y-3 py-4">
                  <div className="h-5 rounded bg-white/10 light:bg-black/10 w-1/3" />
                  <div className="h-64 rounded bg-white/5 light:bg-black/5" />
                </div>
              )}
              {!viewerLoading && (
                <FileViewer data={viewerData} onClose={closeViewer} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
