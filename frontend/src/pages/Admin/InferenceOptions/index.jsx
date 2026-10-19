import Sidebar from "@/components/SettingsSidebar";
import { useEffect, useState } from "react";
import { isMobile } from "react-device-detect";
import Admin from "@/models/admin";
import showToast from "@/utils/toast";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import { useTranslation } from "react-i18next";

/**
 * Admin UI for default-user inference options (spec F11 frontend).
 *
 * Presents the three curated options from the server registry with their
 * currently configured model slug (seeded into `system_settings` on first
 * read) and editable slug fields. Saving posts a partial map to
 * `POST /admin/inference-options`; changes apply to already-selected
 * workspaces on subsequent chats without a restart (N6).
 *
 * No rate editing here — billing rates are server-side constants
 * (`server/models/credits.js` MODEL_RATES) and are deliberately not
 * admin-editable (out of scope per the implementation plan).
 */
export default function AdminInferenceOptions() {
  const { t } = useTranslation();
  const [options, setOptions] = useState([]);
  const [slugs, setSlugs] = useState({});
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchOptions();
  }, []);

  const fetchOptions = async () => {
    setLoading(true);
    const { options } = await Admin.inferenceOptions();
    setOptions(options || []);
    setSlugs(
      Object.fromEntries(
        (options || []).map((option) => [option.key, option.model])
      )
    );
    setLoading(false);
  };

  const handleChange = (optionKey, value) => {
    setSlugs((prev) => ({ ...prev, [optionKey]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    const { success, error } = await Admin.setInferenceOptionSlugs(slugs);
    setIsSaving(false);
    if (!success) {
      showToast(
        error ||
          t("settings.inference-options.toast-save-failed", {
            defaultValue: "Failed to save inference options.",
          }),
        "error"
      );
      return;
    }
    showToast(
      t("settings.inference-options.toast-saved", {
        defaultValue:
          "Inference options updated. Changes apply to subsequent chats.",
      }),
      "success"
    );
    fetchOptions();
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white/10 border-b-2">
            <div className="items-center flex gap-x-4">
              <p className="text-lg leading-6 font-bold text-theme-text-primary">
                {t("settings.inference-options.title", {
                  defaultValue: "Inference Options",
                })}
              </p>
            </div>
            <p className="text-xs leading-[18px] font-base text-theme-text-secondary">
              {t("settings.inference-options.description", {
                defaultValue:
                  "Configure the model behind each default-user inference option. Changes apply to workspaces already using an option on their next chat, without a restart.",
              })}
            </p>
          </div>

          {loading ? (
            <div className="mt-8 flex flex-col gap-y-4">
              {[0, 1, 2].map((i) => (
                <Skeleton.default
                  key={i}
                  height={72}
                  width="100%"
                  highlightColor="var(--theme-bg-primary)"
                  baseColor="var(--theme-bg-secondary)"
                  className="rounded-lg"
                />
              ))}
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="mt-6 flex flex-col gap-y-6 max-w-3xl"
            >
              {options.map((option) => (
                <div
                  key={option.key}
                  className="flex flex-col gap-y-2 rounded-lg bg-theme-bg-primary p-4 border border-white/10"
                >
                  <div className="flex items-center justify-between gap-x-4">
                    <div className="flex items-center gap-x-2">
                      <p className="text-sm font-semibold text-theme-text-primary">
                        {option.label}
                      </p>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                          option.available
                            ? "bg-green-500/20 text-green-400"
                            : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {option.available
                          ? t("settings.inference-options.available", {
                              defaultValue: "available",
                            })
                          : t("settings.inference-options.unavailable", {
                              defaultValue: "unavailable",
                            })}
                      </span>
                    </div>
                    <span className="text-[10px] text-theme-text-secondary font-mono">
                      {option.key}
                    </span>
                  </div>
                  <p className="text-xs text-theme-text-secondary">
                    {option.description}
                  </p>
                  <div className="flex flex-col gap-y-1">
                    <label
                      htmlFor={`slug-${option.key}`}
                      className="text-xs font-medium text-theme-text-primary"
                    >
                      {t("settings.inference-options.model-slug", {
                        defaultValue: "Model slug",
                      })}
                      <span className="text-theme-text-secondary font-normal">
                        {" "}
                        ({option.provider})
                      </span>
                    </label>
                    <input
                      id={`slug-${option.key}`}
                      type="text"
                      value={slugs[option.key] ?? ""}
                      onChange={(e) => handleChange(option.key, e.target.value)}
                      placeholder={option.model}
                      spellCheck={false}
                      className="font-mono text-sm w-full border-none bg-theme-settings-input-bg placeholder:text-theme-settings-input-placeholder text-theme-text-primary rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block p-2.5"
                    />
                  </div>
                </div>
              ))}
              <button
                disabled={isSaving}
                className={`enabled:hover:bg-secondary enabled:hover:text-white rounded-lg bg-primary-button w-fit py-2 px-4 font-semibold text-xs disabled:opacity-20 disabled:cursor-not-allowed`}
                type="submit"
              >
                {isSaving
                  ? t("settings.inference-options.saving", {
                      defaultValue: "Saving...",
                    })
                  : t("settings.inference-options.save", {
                      defaultValue: "Save Changes",
                    })}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
