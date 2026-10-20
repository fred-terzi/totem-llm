import { useTranslation } from "react-i18next";
import useAvailableTools from "@/hooks/useAvailableTools";

/**
 * Display-only list of the agent tools available in this workspace, rendered
 * underneath the welcome message on a fresh (empty) thread. Purely
 * informational — users with the default role cannot open the Agent Skills
 * menu, so this shows them what their agent can do. Renders nothing while
 * loading or when no tools are enabled.
 */
export default function AvailableTools() {
  const { t } = useTranslation();
  const { tools, loading } = useAvailableTools();

  if (loading || tools.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5 mb-4 px-2 w-full max-w-[750px]">
      <span className="text-[11px] text-zinc-400 light:text-slate-500">
        {t("main-page.availableTools.label")}
      </span>
      {tools.map((tool) => (
        <span
          key={tool.id}
          className="px-2 py-0.5 rounded-full bg-zinc-800 light:bg-slate-100 border border-zinc-700 light:border-slate-300 text-[11px] text-zinc-300 light:text-slate-600 whitespace-nowrap"
        >
          {tool.name}
        </span>
      ))}
    </div>
  );
}
