import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import { useTranslation } from "react-i18next";

/**
 * Import Data — placeholder page.
 *
 * The backend import pipeline already exists (POST /api/import/chatgpt,
 * GET /api/import/chatgpt/preview). The UI to trigger it from here lands in a
 * follow-up step: users will save their exported ChatGPT history folder into
 * the designated storage directory and press an Import button.
 */
export default function ImportData() {
  const { t } = useTranslation();

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
            <p className="text-sm leading-[20px] text-theme-text-primary font-medium">
              {t("importData.howItWorksTitle", "How it works")}
            </p>
            <ol className="list-decimal list-inside text-xs leading-[18px] text-theme-text-secondary space-y-1">
              <li>{t("importData.stepExport", "Export your data from ChatGPT")}</li>
              <li>{t("importData.stepSave", "Save the export folder in your Totem LLM storage directory")}</li>
              <li>{t("importData.stepImport", "Press Import to bring it into a new workspace")}</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
