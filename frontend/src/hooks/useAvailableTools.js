import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import System from "@/models/system";
import {
  getDefaultSkills,
  getConfigurableSkills,
  getAppIntegrationSkills,
} from "@/pages/Admin/Agents/skills";

/**
 * Resolves a display-friendly list of agent tools available in this workspace
 * for the empty-thread view. Intended for users (default role) who cannot open
 * the admin-gated Agent Skills menu — this is display-only.
 *
 * The server endpoint (`GET /agent-skills/available`) reuses the exact code
 * path the agent uses (`agentSkillsFromSystemSettings`) plus active imported
 * skills, agent flows, and enabled MCP tools, so the list reflects what will
 * actually load in an agent session.
 *
 * @returns {{ tools: {id: string, name: string}[], loading: boolean }}
 */
export default function useAvailableTools() {
  const { t } = useTranslation();
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      const { skills, importedSkills, flows, mcpServers, isMultiUser } =
        await System.availableAgentTools();
      if (cancelled) return;

      // Map skill identifiers back to their human-readable titles using the
      // same skill definitions the Tools menu renders. Identifiers that no
      // longer have a frontend definition (or the request-user-input
      // scaffolding skill) are skipped rather than shown as raw slugs.
      const titleLookup = {
        ...getDefaultSkills(t),
        ...getConfigurableSkills(t),
        ...(!isMultiUser ? getAppIntegrationSkills(t) : {}),
      };

      const resolved = [];
      for (const skill of skills) {
        const def = titleLookup[skill];
        if (!def) continue;
        resolved.push({ id: skill, name: def.title });
      }

      for (const imported of importedSkills) {
        resolved.push({
          id: `imported-${imported.hubId}`,
          name: imported.name || imported.hubId,
        });
      }

      for (const flow of flows) {
        resolved.push({ id: `flow-${flow.uuid}`, name: flow.name });
      }

      for (const server of mcpServers) {
        for (const toolName of server.tools) {
          resolved.push({
            id: `mcp-${server.name}-${toolName}`,
            name: `${server.name}: ${toolName}`,
          });
        }
      }

      setTools(resolved);
      setLoading(false);
    }

    resolve();
    return () => {
      cancelled = true;
    };
  }, [t]);

  return { tools, loading };
}
