import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isMobile } from "react-device-detect";
import useUser from "@/hooks/useUser";
import { useModal } from "@/hooks/useModal";
import LLMSelectorModal from "../PromptInput/LLMSelector/index";
import InferenceOptionPicker from "../PromptInput/LLMSelector/InferenceOptionPicker";
import SetupProvider from "../PromptInput/LLMSelector/SetupProvider";
import {
  SAVE_LLM_SELECTOR_EVENT,
  PROVIDER_SETUP_EVENT,
} from "../PromptInput/LLMSelector/action";
import { ABORT_STREAM_EVENT } from "@/utils/chat";
import { getAgentSessionActive } from "@/utils/chat/agent";
import Workspace from "@/models/workspace";
import System from "@/models/system";
import ModelRouterAPI from "@/models/modelRouter";
import { SIDEBAR_TOGGLE_EVENT } from "@/components/Sidebar/SidebarToggle";

async function resolveModelName(workspace, systemSettings, t) {
  const effectiveProvider =
    workspace.chatProvider ?? systemSettings?.LLMProvider;

  if (effectiveProvider !== "anythingllm-router")
    return workspace.chatModel ?? systemSettings?.LLMModel ?? "";

  const routerId = workspace.router_id || systemSettings?.ModelRouterId;
  if (!routerId) return t("model-router.metrics.model-router-default");

  const { router } = await ModelRouterAPI.get(routerId);
  if (!router?.name) return t("model-router.metrics.model-router-default");

  return router.name;
}

async function fetchModelName(slug, setModelName, t) {
  if (!slug) return;
  const [workspace, systemSettings] = await Promise.all([
    Workspace.bySlug(slug),
    System.keys(),
  ]);
  setModelName(await resolveModelName(workspace, systemSettings, t));
}

export default function WorkspaceModelPicker({ workspaceSlug = null }) {
  const { t } = useTranslation();
  const { slug: urlSlug } = useParams();
  const slug = urlSlug ?? workspaceSlug;
  const { user } = useUser();
  // Default-role users get the curated three-option picker (F1/F10); every
  // other role gets the existing full provider/model selector (AC 9).
  const isInferenceOptionUser = !!user && user.role === "default";
  const [showSelector, setShowSelector] = useState(false);
  const [modelName, setModelName] = useState("");
  const {
    isOpen: isSetupProviderOpen,
    openModal: openSetupProviderModal,
    closeModal: closeSetupProviderModal,
  } = useModal();
  const [config, setConfig] = useState({ settings: {}, provider: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedInferenceOption, setSelectedInferenceOption] = useState(null);
  const [inferenceOptionsList, setInferenceOptionsList] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.localStorage.getItem("anythingllm_sidebar_toggle") !== "closed"
  );

  useEffect(() => {
    const handleToggle = (e) => setSidebarOpen(e.detail.open);
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
  }, []);

  // Fetch current model name for display
  useEffect(() => {
    fetchModelName(slug, setModelName, t);
  }, [slug]);

  // Default-role users pick from the curated inference options instead of
  // the provider/model list — load the persisted selection so the chip
  // label shows the chosen option (spec F1/F10). Options come from the
  // server registry (F14); this local mirror only maps key → label for the
  // chip and is refreshed whenever the picker refetches.
  useEffect(() => {
    if (!slug || !isInferenceOptionUser) return;
    let cancelled = false;
    Workspace.inferenceOptions(slug).then((result) => {
      if (cancelled || !result?.success) return;
      setSelectedInferenceOption(result.selected ?? null);
      setInferenceOptionsList(result.options ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, isInferenceOptionUser, refreshKey]);

  // Close selector and refresh model name when model is saved
  useEffect(() => {
    function handleSave() {
      setShowSelector(false);
      fetchModelName(slug, setModelName, t);
    }
    window.addEventListener(SAVE_LLM_SELECTOR_EVENT, handleSave);
    return () =>
      window.removeEventListener(SAVE_LLM_SELECTOR_EVENT, handleSave);
  }, [slug]);

  // Handle provider setup request
  useEffect(() => {
    function handleProviderSetup(e) {
      const { provider, settings } = e.detail;
      setConfig({ settings, provider });
      setTimeout(() => openSetupProviderModal(), 300);
    }
    window.addEventListener(PROVIDER_SETUP_EVENT, handleProviderSetup);
    return () =>
      window.removeEventListener(PROVIDER_SETUP_EVENT, handleProviderSetup);
  }, []);

  // This feature is hidden from unauthenticated states and from managers —
  // default users get the option picker, admins the full selector.
  if (!!user && user.role !== "admin" && user.role !== "default") return null;
  if (!slug || isMobile) return null;

  return (
    <>
      {showSelector && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setShowSelector(false)}
        />
      )}
      <div
        className={`hidden md:block absolute top-2 z-30 transition-all duration-500 ${
          sidebarOpen ? "left-3" : "left-11"
        }`}
      >
        <button
          type="button"
          onClick={() => setShowSelector(!showSelector)}
          className={`group border-none cursor-pointer px-2.5 py-1 flex items-center rounded-full transition-all ${
            showSelector
              ? "bg-zinc-700 light:bg-slate-200"
              : "hover:bg-zinc-700 light:hover:bg-slate-200"
          }`}
        >
          <span
            className={`text-xs ${
              showSelector
                ? "text-white light:text-slate-800"
                : "text-zinc-500 light:text-slate-500 group-hover:text-white light:group-hover:text-slate-800"
            }`}
          >
            {isInferenceOptionUser
              ? inferenceOptionsList.find(
                  (o) => o.key === selectedInferenceOption
                )?.label || t("chat_window.select_model")
              : modelName || t("chat_window.select_model")}
          </span>
        </button>

        {showSelector && (
          <div
            className={`absolute left-0 top-full mt-1 border rounded-xl shadow-lg overflow-hidden ${
              isInferenceOptionUser
                ? "w-[420px] bg-zinc-800 light:bg-white border-zinc-700 light:border-slate-300"
                : "w-[620px] bg-zinc-800 light:bg-white border-zinc-700 light:border-slate-300"
            }`}
          >
            {isInferenceOptionUser ? (
              <InferenceOptionPicker
                key={refreshKey}
                workspaceSlug={slug}
                onSaved={() => {
                  // Bump the refresh key so the chip-label effect refetches
                  // the persisted selection, then close the panel.
                  setRefreshKey((k) => k + 1);
                  setShowSelector(false);
                  // F16: an agent session pins (provider, model) at socket
                  // connect time. If one is active, tear it down (ABORT
                  // closes the socket; the close handler resets socketId) so
                  // the next message opens a fresh agent session that
                  // re-resolves the just-saved selection. History is not
                  // lost — a fresh session loads the last 20 turns. Standard
                  // chat (SSE) resolves its provider per request, so no
                  // teardown is needed when no agent session is active.
                  if (getAgentSessionActive()) {
                    window.dispatchEvent(new CustomEvent(ABORT_STREAM_EVENT));
                  }
                }}
              />
            ) : (
              <LLMSelectorModal
                key={refreshKey}
                workspaceSlug={slug}
                initialProvider={config.provider?.value}
              />
            )}
          </div>
        )}
      </div>

      <SetupProvider
        isOpen={isSetupProviderOpen}
        closeModal={closeSetupProviderModal}
        postSubmit={() => {
          closeSetupProviderModal();
          setRefreshKey((k) => k + 1);
        }}
        settings={config.settings}
        llmProvider={config.provider}
      />
    </>
  );
}
