const { AgentSkillWhitelist } = require("../models/agentSkillWhitelist");
const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");

function agentSkillWhitelistEndpoints(app) {
  if (!app) return;

  app.get(
    "/agent-skills/filesystem-agent/is-available",
    [validatedRequest],
    async (_request, response) => {
      try {
        const filesystemTool = require("../utils/agents/aibitat/plugins/filesystem/lib");
        return response
          .status(200)
          .json({ available: filesystemTool.isToolAvailable() });
      } catch (e) {
        console.error(e);
        return response
          .status(500)
          .json({ available: false, error: e.message });
      }
    }
  );

  app.get(
    "/agent-skills/create-files-agent/is-available",
    [validatedRequest],
    async (_request, response) => {
      try {
        const createFilesTool = require("../utils/agents/aibitat/plugins/create-files/lib");
        return response
          .status(200)
          .json({ available: createFilesTool.isToolAvailable() });
      } catch (e) {
        console.error(e);
        return response
          .status(500)
          .json({ available: false, error: e.message });
      }
    }
  );

  app.get(
    "/agent-skills/terminal-access/is-available",
    [validatedRequest],
    async (_request, response) => {
      try {
        const {
          terminalManager,
        } = require("../utils/agents/aibitat/plugins/terminal-access");
        return response
          .status(200)
          .json({ available: terminalManager.isToolAvailable() });
      } catch (e) {
        console.error(e);
        return response
          .status(500)
          .json({ available: false, error: e.message });
      }
    }
  );

  // Read-only list of the agent tools that are currently active on this
  // instance. Available to ANY authenticated user (not just admins) so the
  // empty-thread view can display which tools exist — default users cannot
  // read the admin-only skill preference endpoints. Reuses the same code path
  // the agent itself uses (agentSkillsFromSystemSettings) so the list is the
  // ground truth of what will actually load in a session.
  app.get(
    "/agent-skills/available",
    [validatedRequest],
    async (_request, response) => {
      try {
        const {
          agentSkillsFromSystemSettings,
        } = require("../utils/agents/defaults");
        const ImportedPlugin = require("../utils/agents/imported");
        const { AgentFlows } = require("../utils/agentFlows");
        const MCPCompatibilityLayer = require("../utils/MCP");
        const { SystemSettings } = require("../models/systemSettings");

        // Raw function identifiers from the same code path the agent uses
        // (e.g. "rag-memory", "filesystem-agent#read-text-file"). Collapse
        // `parent#child` sub-skill identifiers into their parent skill so the
        // display shows one entry per skill, and drop imported/flow/mcp
        // markers ("@@...") which are resolved separately below.
        const functionNames = await agentSkillsFromSystemSettings();
        const skills = [
          ...new Set(functionNames.map((fn) => fn.split("#")[0])),
        ].filter((name) => !name.startsWith("@@"));

        // Active imported (hub) skills.
        const importedSkills = ImportedPlugin.listImportedPlugins()
          .filter((plugin) => plugin.active)
          .map((plugin) => ({ hubId: plugin.hubId, name: plugin.name }));

        // Active agent flows.
        const flows = AgentFlows.listFlows()
          .filter((flow) => flow.active)
          .map(({ uuid, name }) => ({ uuid, name }));

        // Enabled MCP tools per running server (suppressed tools excluded).
        const mcpServers = [];
        try {
          const servers = await new MCPCompatibilityLayer().servers();
          for (const server of servers) {
            if (!server.running || !server.tools?.length) continue;
            const suppressedTools =
              server.config?.anythingllm?.suppressedTools || [];
            const tools = server.tools
              .map((tool) => tool.name)
              .filter((toolName) => !suppressedTools.includes(toolName));
            if (tools.length > 0) mcpServers.push({ name: server.name, tools });
          }
        } catch (e) {
          console.error(
            "agent-skills/available: failed to list MCP servers:",
            e.message
          );
        }

        const isMultiUser = await SystemSettings.isMultiUserMode();

        return response.status(200).json({
          skills,
          importedSkills,
          flows,
          mcpServers,
          isMultiUser,
        });
      } catch (e) {
        console.error(e);
        return response.status(500).json({
          error: e.message,
          skills: [],
          importedSkills: [],
          flows: [],
          mcpServers: [],
        });
      }
    }
  );

  app.post(
    "/agent-skills/whitelist/add",
    [validatedRequest, flexUserRoleValid(ROLES.all)],
    async (request, response) => {
      try {
        const { skillName } = reqBody(request);
        if (!skillName) {
          response
            .status(400)
            .json({ success: false, error: "Missing skillName" });
          return;
        }

        const user = await userFromSession(request, response);
        if (!user && response.locals?.multiUserMode) {
          return response
            .status(401)
            .json({ success: false, error: "Unauthorized" });
        }

        const userId = user?.id || null;
        const { success, error } = await AgentSkillWhitelist.add(
          skillName,
          userId
        );
        return response.status(success ? 200 : 400).json({ success, error });
      } catch (e) {
        console.error(e);
        return response.status(500).json({ success: false, error: e.message });
      }
    }
  );
}

module.exports = { agentSkillWhitelistEndpoints };
