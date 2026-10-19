const { v4: uuidv4 } = require("uuid");
const { reqBody, userFromSession, multiUserMode } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { streamChatWithWorkspace } = require("../utils/chats/stream");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { EventLogs } = require("../models/eventLogs");
const {
  validWorkspaceAndThreadSlug,
  validWorkspaceSlug,
} = require("../utils/middleware/validWorkspace");
const { writeResponseChunk } = require("../utils/helpers/chat/responses");
const { WorkspaceThread } = require("../models/workspaceThread");
const { User } = require("../models/user");
const { Credits } = require("../models/credits");
const { OPTION_KEYS } = require("../utils/inferenceOptions");
const { mapFreeModelRateLimitMessage } = require("../utils/freeModelRateLimit");

/**
 * F7 credit-gate skip: a default-role user chatting on a workspace whose
 * selected inference option is `totem-free` runs on a zero-rate model, so the
 * pre-flight `Credits.hasCredits` check is skipped (AC 5). All other cases —
 * no selection, Options 2/3, privileged roles — stay gated (AC 6). Fail-closed:
 * any doubt (missing user/workspace, unknown option) → gate applies.
 */
function skipCreditGate({ user = null, workspace = null } = {}) {
  return (
    !!user &&
    user.role === ROLES.default &&
    workspace?.user_inference_option === OPTION_KEYS.FREE
  );
}

function chatEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/stream-chat",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { message, attachments = [] } = reqBody(request);
        const workspace = response.locals.workspace;

        if (typeof message !== "string" || message.trim().length === 0) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: "Message is empty.",
          });
          return;
        }

        // Credit gate: user must have > 0 credits to send a message.
        // Admins are exempt. Default-role users on the workspace's `totem-free`
        // option are exempt (F7 — zero-rate model, AC 5). This check runs
        // before flushHeaders so we can return a proper 402 HTTP status.
        if (
          multiUserMode(response) &&
          user.role !== ROLES.admin &&
          !skipCreditGate({ user, workspace })
        ) {
          const hasCredits = await Credits.hasCredits(user.id, 1, user.role);
          if (!hasCredits) {
            response.status(402).json({
              id: uuidv4(),
              type: "abort",
              message: "No credits remaining. Buy credits to keep chatting.",
              action: "buy_credits",
            });
            return;
          }
        }

        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();

        if (multiUserMode(response) && !(await User.canSendChat(user))) {
          writeResponseChunk(response, {
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `You have met your maximum 24 hour chat quota of ${user.dailyMessageLimit} chats. Try again later.`,
          });
          return;
        }

        await streamChatWithWorkspace(
          response,
          workspace,
          message,
          workspace?.chatMode,
          user,
          null,
          attachments
        );

        await EventLogs.logEvent(
          "sent_chat",
          {
            workspaceName: workspace?.name,
            chatModel: workspace?.chatModel || "System Default",
          },
          user?.id
        );
        response.end();
      } catch (e) {
        console.error(e);
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          // F8: a mapped free-model rate limit surfaces the exact F8 wording;
          // every other error keeps the standard shape (N5).
          error: mapFreeModelRateLimitMessage(e.message) ?? e.message,
        });
        response.end();
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/stream-chat",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { message, attachments = [] } = reqBody(request);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;

        if (typeof message !== "string" || message.trim().length === 0) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: "Message is empty.",
          });
          return;
        }

        // Credit gate: user must have > 0 credits to send a message.
        // Admins are exempt. Default-role users on the workspace's `totem-free`
        // option are exempt (F7 — zero-rate model, AC 5).
        if (
          multiUserMode(response) &&
          user.role !== ROLES.admin &&
          !skipCreditGate({ user, workspace })
        ) {
          const hasCredits = await Credits.hasCredits(user.id, 1, user.role);
          if (!hasCredits) {
            response.status(402).json({
              id: uuidv4(),
              type: "abort",
              message: "No credits remaining. Buy credits to keep chatting.",
              action: "buy_credits",
            });
            return;
          }
        }

        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();

        if (multiUserMode(response) && !(await User.canSendChat(user))) {
          writeResponseChunk(response, {
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `You have met your maximum 24 hour chat quota of ${user.dailyMessageLimit} chats. Try again later.`,
          });
          return;
        }

        await streamChatWithWorkspace(
          response,
          workspace,
          message,
          workspace?.chatMode,
          user,
          thread,
          attachments
        );

        // If thread was renamed emit event to frontend via special `action` response.
        await WorkspaceThread.autoRenameThread({
          thread,
          workspace,
          user,
          prompt: message,
          onRename: (thread) => {
            writeResponseChunk(response, {
              action: "rename_thread",
              thread: {
                slug: thread.slug,
                name: thread.name,
              },
            });
          },
        });

        await EventLogs.logEvent(
          "sent_chat",
          {
            workspaceName: workspace.name,
            thread: thread.name,
            chatModel: workspace?.chatModel || "System Default",
          },
          user?.id
        );
        response.end();
      } catch (e) {
        console.error(e);
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          // F8: a mapped free-model rate limit surfaces the exact F8 wording;
          // every other error keeps the standard shape (N5).
          error: mapFreeModelRateLimitMessage(e.message) ?? e.message,
        });
        response.end();
      }
    }
  );
}

module.exports = { chatEndpoints };
