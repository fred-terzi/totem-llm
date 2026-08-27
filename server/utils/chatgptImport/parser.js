/**
 * Parses ChatGPT export conversation files into structured message pairs.
 */

const fs = require("fs");
const path = require("path");

// Content types that should be skipped (internal reasoning, not user-visible)
const SKIP_CONTENT_TYPES = new Set(["thoughts", "reasoning_recap"]);

/**
 * Loads all conversations from the export directory.
 * @param {string} dirPath - Path to the extracted ChatGPT export folder
 * @returns {Object[]} Array of conversation objects (raw JSON)
 */
function loadConversations(dirPath) {
  const { resolveExportDir } = require("./validator");
  const { dir: resolvedDir, error } = resolveExportDir(dirPath);
  if (error) throw new Error(error);

  const entries = fs.readdirSync(resolvedDir);
  const conversationFiles = entries
    .filter((f) => /^conversations-\d{3}\.json$/.test(f))
    .sort();

  let allConversations = [];
  for (const file of conversationFiles) {
    const raw = fs.readFileSync(path.join(resolvedDir, file), "utf-8");
    const conversations = JSON.parse(raw);
    if (Array.isArray(conversations)) {
      allConversations.push(...conversations);
    }
  }

  // Deduplicate by conversation_id (shouldn't happen but just in case)
  const seen = new Set();
  return allConversations.filter((conv) => {
    if (!conv.conversation_id || !conv.id) return false;
    if (seen.has(conv.id)) return false;
    seen.add(conv.id);
    return true;
  });
}

/**
 * Walks the message tree from current_node back to root, returning the main path.
 * @param {Object} conversation - A ChatGPT conversation object
 * @returns {Array<{id: string, parent: string|null, message: Object|null}>} Ordered messages (oldest first)
 */
function getMainPath(conversation) {
  const mapping = conversation.mapping;
  if (!mapping || !conversation.current_node) return [];

  // Walk from current_node up to root
  const pathIds = [];
  let currentNodeId = conversation.current_node;

  // Safety: max depth to prevent infinite loops in malformed data
  const MAX_DEPTH = 10000;
  let steps = 0;

  while (currentNodeId && currentNodeId !== "client-created-root") {
    if (++steps > MAX_DEPTH) break;
    pathIds.push(currentNodeId);
    currentNodeId = mapping[currentNodeId]?.parent || null;
  }

  // Reverse to get chronological order (root → current_node)
  pathIds.reverse();

  // Convert IDs to message objects, skipping the synthetic root and non-text content types
  return pathIds
    .map((id) => {
      const node = mapping[id];
      if (!node || !node.message) return null;
      if (SKIP_CONTENT_TYPES.has(node.message.content?.content_type))
        return null;
      return node;
    })
    .filter(Boolean);
}

/**
 * Extracts plain text from a message's content parts.
 * Handles both string parts and object parts (image pointers, etc.).
 * @param {Object} message - A ChatGPT message object
 * @returns {{text: string, hasAttachments: boolean}} The extracted text and whether attachments were present
 */
function extractText(message) {
  const content = message.content;
  if (!content || !Array.isArray(content.parts))
    return { text: "", hasAttachments: false };

  let text = "";
  let hasAttachments = false;

  for (const part of content.parts) {
    if (typeof part === "string") {
      text += part;
    } else if (part && typeof part === "object") {
      // Image or audio asset pointer
      if (part.content_type === "image_asset_pointer" || part.asset_pointer) {
        hasAttachments = true;
        const filename = part.metadata?.filename || "attachment";
        text += `\n[Attached: ${filename}]`;
      } else if (typeof part.text === "string") {
        // Some parts have a .text property
        text += part.text;
      }
    }
  }

  return { text: text.trim(), hasAttachments };
}

/**
 * Parses a single conversation into an ordered list of user/assistant message pairs.
 * @param {Object} conversation - A ChatGPT conversation object
 * @returns {{conversationId: string, title: string, createTime: number, messages: Array<{role: string, text: string, timestamp: number}>}}
 */
function parseConversation(conversation) {
  const mainPath = getMainPath(conversation);

  const messages = [];
  for (const node of mainPath) {
    const msg = node.message;
    if (!msg || !msg.author) continue;

    const role = msg.author.role; // "user" | "assistant"
    if (role !== "user" && role !== "assistant") continue;

    const { text } = extractText(msg);
    if (!text) continue; // Skip empty messages

    messages.push({
      role,
      text,
      timestamp: msg.create_time ? new Date(msg.create_time * 1000) : null,
    });
  }

  return {
    conversationId: conversation.conversation_id || conversation.id,
    title: conversation.title || null,
    createTime: conversation.create_time
      ? new Date(conversation.create_time * 1000)
      : null,
    messages,
  };
}

/**
 * Parses all conversations from the export directory into structured data.
 * @param {string} dirPath - Path to the extracted ChatGPT export folder
 * @returns {{conversations: Array<{conversationId: string, title: string, createTime: Date, messages: Array}>}}
 */
function parseExport(dirPath) {
  const rawConversations = loadConversations(dirPath);

  return {
    conversations: rawConversations.map(parseConversation),
  };
}

module.exports = {
  loadConversations,
  getMainPath,
  extractText,
  parseConversation,
  parseExport,
};
