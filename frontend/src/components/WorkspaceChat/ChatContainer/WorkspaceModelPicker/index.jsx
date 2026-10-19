import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

// Mirrors Tailwind's `md` breakpoint. Layout for this component must follow
// the viewport, not the user agent: react-device-detect's `isMobile` is a UA
// sniff and reports false in DevTools responsive mode, desktop windows narrowed
// below the breakpoint, and desktop-UA WebViews — which previously left the
// picker invisible on exactly those surfaces (the desktop chip is hidden
// below md). Viewport width is the same signal the surrounding UI uses.
function useIsDesktopViewport() {
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia("(min-width: 768px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isDesktop;
}
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
  const isDesktopViewport = useIsDesktopViewport();
  // UA-derived `isMobile` stays as an override so a phone in landscape (>=768px
  // viewport) keeps the floating top-bar button instead of the sidebar-anchored
  // desktop chip. Everything else is decided by the viewport breakpoint.
  const useMobileLayout = isMobile || !isDesktopViewport;

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
  // default users get the option picker, admins the full selector. On mobile
  // the chip is rendered as a fixed button over the mobile header's right
  // side (the desktop absolute-positioned chip is hidden below the md
  // breakpoint), so default users can pick their inference option on phones.
  if (!!user && user.role !== "admin" && user.role !== "default") return null;
  if (!slug) return null;

  // Panel widths: the option picker is 420px on desktop and the full
  // provider/model selector 620px. In the mobile layout both clamp to the
  // viewport minus side gutters so the popover never overflows the screen.
  const pickerPanelWidth = useMobileLayout
    ? isInferenceOptionUser
      ? "w-[min(420px,calc(100vw-24px))]"
      : "w-[min(620px,calc(100vw-24px))]"
    : isInferenceOptionUser
      ? "w-[420px]"
      : "w-[620px]";

  const picker = (
    <>
      {showSelector && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setShowSelector(false)}
        />
      )}
      <div
        className={
          useMobileLayout
            ? "fixed top-16 right-4 z-30"
            : `hidden md:block absolute top-2 z-30 transition-all duration-500 ${
                sidebarOpen ? "left-3" : "left-11"
              }`
        }
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
            className={`absolute ${
              useMobileLayout ? "right-0" : "left-0"
            } top-full mt-1 border rounded-xl shadow-lg overflow-hidden ${pickerPanelWidth} bg-zinc-800 light:bg-white border-zinc-700 light:border-slate-300`}
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

  // Mobile renders through a portal to document.body: the chip is
  // position:fixed, but the chat container tree gives it a local stacking
  // context (z-[2] wrapper with transforms/filters during transitions), so
  // its z-30 was scoped below the UserMenu bar (z-40) — the badges sat on
  // top and the header's stacking buried the button. Portalling into the
  // root body puts the chip in the global stacking context where its own
  // z-30 wins. Desktop keeps the in-tree render so the chip still anchors
  // to the chat container and slides with the sidebar toggle.
  if (useMobileLayout) return createPortal(picker, document.body);
  return picker;
}
