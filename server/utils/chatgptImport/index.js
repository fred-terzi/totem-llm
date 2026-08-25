/**
 * ChatGPT Import Orchestrator
 * Coordinates: validate → parse → transform → commit
 */

const { Workspace } = require("../../models/workspace");
const { WorkspaceThread } = require("../../models/workspaceThread");
const prisma = require("../prisma");
const { safeJSONStringify } = require("../helpers/chat/responses");
const { validateExportDirectory, getExportMetadata } = require("./validator");
const { parseExport } = require("./parser");

const WORKSPACE_NAME = "ChatGPT Import";

/**
 * Runs the full ChatGPT import pipeline.
 * @param {string} dirPath - Path to the extracted ChatGPT export directory
 * @param {number|null} userId - The importing user's ID (null for single-user mode)
 * @returns {{success: boolean, summary?: Object, error?: string}}
 */
async function importChatgptExport(dirPath, userId = null) {
  // STEP 1: Validate
  const validationError = validateExportDirectory(dirPath);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Get metadata for the summary report
  const metadata = getExportMetadata(dirPath);

  // STEP 2: Parse
  let parsed;
  try {
    parsed = parseExport(dirPath);
  } catch (e) {
    return { success: false, error: `Failed to parse export: ${e.message}` };
  }

  if (parsed.conversations.length === 0) {
    return {
      success: true,
      summary: { workspacesCreated: 0, threadsImported: 0, chatsImported: 0, skipped: 0 },
    };
  }

  // STEP 3: Find or create the target workspace
  let workspace = await Workspace.get({ importedFrom: "chatgpt" });
  if (!workspace) {
    const result = await Workspace.new(WORKSPACE_NAME, userId, {
      chatMode: "automatic",
      openAiPrompt: null,
    });

    if (result.message) {
      return { success: false, error: `Failed to create workspace: ${result.message}` };
    }
    workspace = result.workspace;

    // Mark it as imported from ChatGPT
    await prisma.workspaces.update({
      where: { id: workspace.id },
      data: { importedFrom: "chatgpt" },
    });
  }

  // STEP 4: Import conversations (threads + chats) in a transaction per thread
  let threadsImported = 0;
  let chatsImported = 0;
  let skipped = 0;
  const errors = [];

  for (const conv of parsed.conversations) {
    // Skip if already imported (idempotency via externalId)
    const existingThread = await WorkspaceThread.get({
      externalId: conv.conversationId,
      workspace_id: workspace.id,
    });

    if (existingThread) {
      skipped++;
      continue;
    }

    // Build thread data
    let threadName = conv.title;
    if (!threadName || !threadName.trim()) {
      const firstUserMsg = conv.messages.find((m) => m.role === "user");
      threadName = firstUserMsg ? firstUserMsg.text.slice(0, 22).trim() : "Imported Thread";
    }

    // Use conversation ID as slug for determinism and uniqueness
    const threadSlug = `chatgpt-${conv.conversationId}`;

    try {
      const createdThread = await prisma.workspace_threads.create({
        data: {
          name: threadName.slice(0, 255),
          slug: threadSlug,
          externalId: conv.conversationId,
          workspace_id: workspace.id,
          user_id: userId,
          createdAt: conv.createTime || new Date(),
          lastUpdatedAt: new Date(),
        },
      });

      threadsImported++;

      // Build chat pairs and insert them
      const chats = buildChatPairs(conv.messages);

      if (chats.length > 0) {
        for (const chat of chats) {
          await prisma.workspace_chats.create({
            data: {
              workspaceId: workspace.id,
              prompt: chat.prompt,
              response: safeJSONStringify({ text: chat.response }),
              user_id: userId,
              thread_id: createdThread.id,
              include: true,
              api_session_id: null,
              createdAt: chat.createdAt || new Date(),
              lastUpdatedAt: new Date(),
            },
          });
        }
        chatsImported += chats.length;
      }
    } catch (e) {
      errors.push({ conversationId: conv.conversationId, error: e.message });
    }
  }

  return {
    success: true,
    summary: {
      workspacesCreated: workspace ? 1 : 0,
      threadsImported,
      chatsImported,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
}

/**
 * Pairs user/assistant messages into chat records.
 * Each record has: { prompt, response, createdAt }
 * @param {Array<{role: string, text: string, timestamp: Date}>} messages - Ordered messages
 * @returns {Array<{prompt: string, response: string, createdAt: Date}>}
 */
function buildChatPairs(messages) {
  const pairs = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "user") {
      // Find the next assistant response
      let assistantText = "";
      if (i + 1 < messages.length && messages[i + 1].role === "assistant") {
        assistantText = messages[i + 1].text;
        i += 2;
      } else {
        i += 1; // No response yet
      }

      pairs.push({
        prompt: msg.text,
        response: assistantText,
        createdAt: msg.timestamp || new Date(),
      });
    } else if (msg.role === "assistant") {
      // Orphan assistant message — store with empty prompt
      pairs.push({
        prompt: "",
        response: msg.text,
        createdAt: msg.timestamp || new Date(),
      });
      i += 1;
    } else {
      i += 1;
    }
  }

  return pairs;
}

/**
 * Gets a preview of what would be imported (without actually importing).
 * @param {string} dirPath - Path to the extracted ChatGPT export directory
 * @returns {{success: boolean, metadata?: Object, error?: string}}
 */
async function getImportPreview(dirPath) {
  const validationError = validateExportDirectory(dirPath);
  if (validationError) {
    return { success: false, error: validationError };
  }

  const metadata = getExportMetadata(dirPath);
  return { success: true, metadata };
}

module.exports = { importChatgptExport, getImportPreview, buildChatPairs };
