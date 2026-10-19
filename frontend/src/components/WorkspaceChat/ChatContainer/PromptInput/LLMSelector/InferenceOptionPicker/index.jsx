import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PreLoader from "@/components/Preloader";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";

/**
 * Default-user inference option picker (spec F1/F10/F14 consumer).
 *
 * Rendered in place of the full provider/model `LLMSelectorModal` when the
 * signed-in user has the `default` role in multi-user mode. Presents exactly
 * the three curated options from the server's registry (F1) with their
 * reference model slugs, filters out unavailable options (F14/AC 13), marks
 * the workspace's persisted selection, and writes via the member-gated
 * option-key-only endpoint (F13). Selecting an option applies immediately —
 * there is no separate save step (the F13 endpoint is a single-key write).
 *
 * Privileged roles never see this component — `WorkspaceModelPicker` and
 * `LLMSelectorAction` gate on role before rendering (AC 9).
 */
export default function InferenceOptionPicker({
  workspaceSlug = null,
  onSaved = null,
}) {
  const { slug: urlSlug } = useParams();
  const slug = urlSlug ?? workspaceSlug;
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [savingKey, setSavingKey] = useState(null);
  const [loadError, setLoadError] = useState(null);

  async function loadOptions() {
    if (!slug) return;
    const result = await Workspace.inferenceOptions(slug);
    if (!result?.success) {
      setLoadError(t("chat_window.inference_picker.load_error"));
      setOptions([]);
      setSelected(null);
      return;
    }
    setLoadError(null);
    setOptions(result.options ?? []);
    setSelected(result.selected ?? null);
  }

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    loadOptions().finally(() => setLoading(false));
  }, [slug]);

  async function handleSelect(optionKey) {
    if (savingKey) return;
    const previous = selected;
    // Optimistic update, then refetch so `selected` (plus refreshed slugs and
    // availability) reflects the persisted server state.
    setSelected(optionKey);
    setSavingKey(optionKey);
    const result = await Workspace.setInferenceOption(slug, optionKey);
    if (!result?.success) {
      setSelected(previous);
      showToast(
        result?.error || t("chat_window.inference_picker.save_error"),
        "error",
        { clear: true }
      );
    } else {
      await loadOptions();
      if (typeof onSaved === "function") onSaved(optionKey);
    }
    setSavingKey(null);
  }

  if (loading) {
    return (
      <div className="w-full h-[300px] flex flex-col items-center justify-center gap-2">
        <PreLoader size={12} />
        <p className="text-zinc-400 light:text-slate-500 text-sm">
          {t("chat_window.inference_picker.loading")}
        </p>
      </div>
    );
  }

  // F14/AC 13: unavailable options are filtered out — no dead-end selection.
  const availableOptions = options.filter((option) => option?.available);

  return (
    <div className="w-full h-full flex flex-col gap-3 p-[18px]">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-white light:text-slate-800">
          {t("chat_window.inference_picker.title")}
        </p>
        <p className="text-xs font-medium text-zinc-400 light:text-slate-500">
          {t("chat_window.inference_picker.description")}
        </p>
      </div>

      <div className="flex flex-col gap-1.5 overflow-y-auto min-h-0 flex-1">
        {availableOptions.map((option) => (
          <OptionRow
            key={option.key}
            option={option}
            selected={selected === option.key}
            saving={savingKey === option.key}
            disabled={!!savingKey}
            onSelect={handleSelect}
            t={t}
          />
        ))}
        {availableOptions.length === 0 && !loadError && (
          <p className="text-xs text-zinc-400 light:text-slate-500">
            {t("chat_window.inference_picker.none_available")}
          </p>
        )}
      </div>

      {!!loadError && (
        <p className="text-xs text-red-400 light:text-red-500">{loadError}</p>
      )}
      <p className="text-[11px] text-zinc-500 light:text-slate-400">
        {t("chat_window.inference_picker.shared_note")}
      </p>
    </div>
  );
}

function OptionRow({ option, selected, saving, disabled, onSelect, t }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(option.key)}
      className={`border cursor-pointer text-left rounded-lg px-3 py-2.5 transition-colors ${
        selected
          ? "border-[var(--theme-button-primary)] bg-zinc-700/60 light:bg-slate-100"
          : "border-zinc-700 light:border-slate-300 hover:bg-zinc-700/40 light:hover:bg-slate-50"
      } ${disabled && !saving ? "opacity-60" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-white light:text-slate-900">
          {option.label}
        </span>
        {saving ? (
          <span className="text-xs text-zinc-400 light:text-slate-500">
            {t("chat_window.inference_picker.saving")}
          </span>
        ) : selected ? (
          <span className="text-xs text-green-400">
            {t("chat_window.inference_picker.selected")}
          </span>
        ) : null}
      </div>
      {/* Reference model slug (F1) — informational, never user-editable here. */}
      <p className="text-[11px] font-mono text-zinc-400 light:text-slate-500 mt-0.5">
        {option.model}
      </p>
      <p className="text-xs text-zinc-400 light:text-slate-500 mt-1">
        {option.description}
      </p>
    </button>
  );
}
