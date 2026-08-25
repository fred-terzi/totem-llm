import { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import { useTranslation } from "react-i18next";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const buttonClass =
  "border-none h-9 px-5 rounded-lg bg-zinc-50 text-zinc-950 light:bg-slate-900 light:text-white text-sm font-medium hover:bg-zinc-200 light:hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:pointer-events-none";

/**
 * Import Data — ChatGPT history import.
 *
 * The user drops their extracted ChatGPT export into the storage dir's
 * `chatgpt-import/` folder (auto-created at startup), then clicks Preview /
 * Import here. The backend resolves that directory by default, so no path is
 * sent from the client.
 */
export default function ImportData() {
  const { t } = useTranslation();
  const [dir, setDir] = useState(null);
  const [preview, setPreview] = useState(null); // metadata object or null
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState(null); // import result summary
  const [error, setError] = useState(null);

  async function checkPreview() {
    setChecking(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(`${API_BASE}/import/chatgpt/preview`, {
        method: "GET",
        headers: baseHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setPreview(null);
        setError(data.error || t("importData.notFoundTitle"));
      } else {
        setDir(data.dir || null);
        setPreview(data.metadata || null);
      }
    } catch (e) {
      console.error(e);
      setPreview(null);
      setError(e.message);
    } finally {
      setChecking(false);
    }
  }

  async function runImport() {
    setImporting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/import/chatgpt`, {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setSummary(null);
        setError(data.error || t("importData.notFoundTitle"));
      } else {
        setSummary(data.summary || null);
      }
    } catch (e) {
      console.error(e);
      setSummary(null);
      setError(e.message);
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    checkPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dateRange =
    preview?.earliestDate && preview?.latestDate
      ? `${new Date(preview.earliestDate).toLocaleDateString()} – ${new Date(
          preview.latestDate
        ).toLocaleDateString()}`
      : null;

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white/10 border-b-2">
            <p className="text-lg leading-6 font-bold text-theme-text-primary">
              {t("importData.title", "Import Data")}
            </p>
            <p className="text-xs leading-[18px] font-base text-theme-text-secondary mt-2">
              {t(
                "importData.description",
                "Bring your ChatGPT history into Totem LLM. Save an exported copy of your conversations, then import it below."
              )}
            </p>
          </div>

          <div className="flex flex-col gap-y-3 mt-6 max-w-xl">
            {/* How it works */}
            <p className="text-sm leading-[20px] text-theme-text-primary font-medium">
              {t("importData.howItWorksTitle", "How it works")}
            </p>
            <ol className="list-decimal list-inside text-xs leading-[18px] text-theme-text-secondary space-y-1">
              <li>{t("importData.stepExport")}</li>
              <li>{t("importData.stepSave")}</li>
              <li>{t("importData.stepImport")}</li>
            </ol>

            {/* Import directory */}
            <div className="mt-4 flex flex-col gap-y-2">
              <p className="text-sm leading-[20px] text-theme-text-primary font-medium">
                {t("importData.importDirTitle", "Where to put your export")}
              </p>
              <p className="text-xs leading-[18px] text-theme-text-secondary">
                {t(
                  "importData.importDirHint",
                  "Drop or extract your ChatGPT export into this folder, then click Preview:"
                )}
              </p>
              <code className="rounded-md bg-black/20 light:bg-slate-100 border border-white/10 light:border-slate-300 px-3 py-2 text-xs leading-[18px] break-all">
                {dir || "…"}
              </code>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-x-3 mt-2">
              <button type="button" onClick={checkPreview} disabled={checking || importing} className={buttonClass}>
                {checking ? t("importData.checking", "Checking for an export…") : preview ? t("importData.recheckButton", "Re-check") : t("importData.previewButton", "Preview")}
              </button>
              <button type="button" onClick={runImport} disabled={!preview || checking || importing} className={buttonClass}>
                {importing ? t("importData.importing", "Importing…") : t("importData.importButton", "Import")}
              </button>
            </div>

            {/* Error state */}
            {error && (
              <div className="mt-4 flex flex-col gap-y-1 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                <p className="text-sm font-semibold text-red-400">{t("importData.notFoundTitle", "No export found yet")}</p>
                <p className="text-xs leading-[18px] text-theme-text-secondary break-all">{error}</p>
              </div>
            )}

            {/* Preview state */}
            {preview && !summary && (
              <div className="mt-4 flex flex-col gap-y-2 rounded-lg border border-white/10 light:border-slate-300 p-4">
                <p className="text-sm font-semibold text-theme-text-primary">{t("importData.readyTitle", "Export detected")}</p>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs leading-[18px] text-theme-text-secondary">
                  <span>
                    {t("importData.conversationsLabel", "Conversations")}:{" "}
                    <strong>{preview.totalConversations}</strong>
                  </span>
                  <span>
                    {t("importData.messagesLabel", "Messages")}: <strong>{preview.totalMessages}</strong>
                  </span>
                  {dateRange && (
                    <span>
                      {t("importData.dateRangeLabel", "Date range")}: <strong>{dateRange}</strong>
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Success state */}
            {summary && (
              <div className="mt-4 flex flex-col gap-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
                <p className="text-sm font-semibold text-emerald-400">{t("importData.successTitle", "Import complete")}</p>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs leading-[18px] text-theme-text-secondary">
                  <span>
                    {summary.threadsImported} {t("importData.summaryThreads", "threads imported")}
                  </span>
                  <span>
                    {summary.chatsImported} {t("importData.summaryChats", "chats created")}
                  </span>
                  <span>
                    {summary.skipped} {t("importData.summarySkipped", "already skipped")}
                  </span>
                </div>
                {Array.isArray(summary.errors) && summary.errors.length > 0 && (
                  <p className="text-xs text-amber-400">
                    {t("importData.errorsLabel", "{{count}} conversation(s) failed to import", { count: summary.errors.length })}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
