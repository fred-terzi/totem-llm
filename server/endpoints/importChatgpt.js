const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { userFromSession, reqBody } = require("../utils/http");
const {
  importChatgptExport,
  getImportPreview,
} = require("../utils/chatgptImport");
const path = require("path");

function defaultImportDir() {
  return path.join(
    process.env.STORAGE_DIR || path.join(require("os").homedir(), "totem-llm"),
    "chatgpt-import"
  );
}

function importChatgptEndpoints(app) {
  if (!app) return;

  /**
   * GET /api/import/chatgpt/preview
   * Returns metadata about the export at the given directory path.
   */
  app.get(
    "/import/chatgpt/preview",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const dirPath = request.query.dirPath || defaultImportDir();

        const result = await getImportPreview(dirPath);
        if (!result.success) {
          return response
            .status(400)
            .json({ ...result, dir: defaultImportDir() });
        }

        response.status(200).json({ ...result, dir: defaultImportDir() });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  /**
   * POST /api/import/chatgpt
   * Imports a ChatGPT export from the given directory path.
   * Body: { dirPath: string, workspaceName?: string }
   */
  app.post(
    "/import/chatgpt",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);

        const dirPath = body.dirPath || defaultImportDir();

        const result = await importChatgptExport(dirPath, user?.id || null);

        if (!result.success) {
          return response.status(400).json(result);
        }

        response.status(200).json({ success: true, summary: result.summary });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { importChatgptEndpoints };
