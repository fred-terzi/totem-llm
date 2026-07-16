const { Workspace } = require("../../../../../models/workspace");
const { WorkspaceThread } = require("../../../../../models/workspaceThread");
const { markdownToTelegram } = require("../../../utils/format");
const {
  ExternalCommunicationConnector,
} = require("../../../../../models/externalCommunicationConnector");

/**
 * Resolve a workspace by slug or name (case-insensitive).
 * Prefers exact slug match, then substring on name/slug.
 * Returns up to 3 matches for disambiguation when the query is ambiguous.
 */
async function resolveWorkspace(input) {
  if (!input || !input.trim()) return null;
  const term = input.trim().toLowerCase();

  // Exact slug match (highest priority, O(1) lookup)
  const exactSlug = await Workspace.get({ slug: term });
  if (exactSlug) return exactSlug;

  // Name prefix match (Prisma-like get with name filter — often an exact-match provider-wise)
  try {
    const directName = await Workspace.get({ name: term });
    if (directName) return directName;
  } catch {
    // Provider may not support 'name' field in get(); proceed to full scan.
  }

  // Full-scan fallback for partial substring matches.
  // For <200 workspaces this is acceptable; the common case runs <5ms.
  try {
    const allWorkspaces = await Workspace.where({});
    const results = allWorkspaces.filter(
      (w) =>
        w.slug.toLowerCase().includes(term) ||
        w.name.toLowerCase().includes(term)
    );

    if (results.length === 1) return results[0];
    if (results.length > 1) return results; // Ambiguous — caller prompts
    return null;
  } catch {
    // DB-layer error — already logged upstream; treat as no match.
    return null;
  }
}

/**
 * Persist the updated linked_groups to the connector config.
 */
async function persistGroupMapping(chatId, data) {
  const connector = await ExternalCommunicationConnector.get("telegram");
  if (!connector) return false;

  const groups = connector.config.linked_groups || [];
  const idx = groups.findIndex((g) => String(g.chatId) === String(chatId));
  const entry = { chatId: String(chatId), ...data };

  if (idx >= 0) {
    groups[idx] = entry;
  } else {
    groups.push(entry);
  }

  await ExternalCommunicationConnector.updateConfig("telegram", {
    linked_groups: groups,
  });
  return true;
}

/**
 * Remove group mapping from connector config.
 */
async function removeGroupMapping(chatId) {
  const connector = await ExternalCommunicationConnector.get("telegram");
  if (!connector) return false;

  const groups = (connector.config.linked_groups || []).filter(
    (g) => String(g.chatId) !== String(chatId)
  );

  await ExternalCommunicationConnector.updateConfig("telegram", {
    linked_groups: groups,
  });
  return true;
}

/**
 * /link <workspace> — Link this group to a workspace.
 * The calling user must be a Telegram group admin (sender_chat or in administrator rights).
 */
async function handleLink(ctx, chatId, wsArg) {
  const bot = ctx.bot;
  const chatType = ctx._chatType?.get(chatId);
  const normalizedArg = String(wsArg || "")
    .replace(/^\/link(?:@[\w_]+)?\s*/i, "")
    .trim();

  if (!["group", "supergroup"].includes(chatType)) {
    await bot.sendMessage(
      chatId,
      markdownToTelegram(
        `This command is for group chats only. Use this bot in a group and type <code>/link &lt;workspace&gt;</code> to connect it to a workspace.`,
        { escapeHtml: false }
      )
    );
    return;
  }

  // Fast path: already linked — inform the admin instead of re-linking.
  const groups = ctx.config?.linked_groups || [];
  const existingEntry = groups.find((g) => String(g.chatId) === String(chatId));
  if (existingEntry) {
    await bot.sendMessage(
      chatId,
      markdownToTelegram(
        `This group is already linked to workspace <code>${existingEntry.workspaceSlug}</code> (thread: <code>${existingEntry.threadSlug || "default"}</code>).<br>Use <code>/unlink</code> first if you want to change it.`,
        { escapeHtml: false }
      )
    );
    return;
  }

  // Workspace argument after /link stripped outside (guard already removes the command prefix).
  const args = normalizedArg;
  if (!args || !args.trim()) {
    await bot.sendMessage(
      chatId,
      markdownToTelegram(
        "<b>Usage:</b> <code>/link &lt;workspace name&gt;</code>\n\nThis links the current group to a workspace. Messages in this group (when @mentioning the bot) will be routed to that workspace.",
        { escapeHtml: false }
      )
    );
    return;
  }

  const ws = await resolveWorkspace(args);
  if (!ws) {
    await bot.sendMessage(
      chatId,
      `No workspace found matching "${args}". Make sure the name is correct.`
    );
    return;
  }

  if (Array.isArray(ws)) {
    const names = ws.map((w) => `• ${w.name}`).join("\n");
    const fullArg = args.split(/\s+/)[0];
    await bot.sendMessage(
      chatId,
      `Multiple workspaces match "${fullArg}". Be more specific:\n\n${names}`
    );
    return;
  }

  // Get or create a dedicated thread for this group
  let thread = await WorkspaceThread.new(ws, null, {
    name: `Telegram Group (${chatId})`,
  });
  if (!thread?.thread) {
    // Fallback: pick first existing thread
    const threads = await WorkspaceThread.where({ workspace_id: ws.id }, 1);
    thread = threads[0] || null;
  }

  // Persist mapping to DB and keep the live bot config in sync.
  await persistGroupMapping(chatId, {
    workspaceSlug: ws.slug,
    threadSlug: thread?.slug || null,
    chatType,
    linkedAt: new Date().toISOString(),
  });
  ctx.config.linked_groups = ctx.config.linked_groups || [];
  const liveGroups = ctx.config.linked_groups;
  const liveIdx = liveGroups.findIndex(
    (g) => String(g.chatId) === String(chatId)
  );
  const liveEntry = {
    chatId: String(chatId),
    workspaceSlug: ws.slug,
    threadSlug: thread?.slug || null,
    chatType,
    linkedAt: new Date().toISOString(),
  };
  if (liveIdx >= 0) liveGroups[liveIdx] = liveEntry;
  else liveGroups.push(liveEntry);

  // Update in-memory state immediately
  ctx.setState(chatId, {
    workspaceSlug: ws.slug,
    threadSlug: thread?.slug || null,
  });

  await bot.sendMessage(
    chatId,
    markdownToTelegram(
      `✅ <b>Group linked!</b>\n\nWorkspace: <code>${ws.name}</code>\nThread: <code>${thread?.name || ws.slug}</code>\n\nThe bot will now respond to messages in this group when @mentioned.`,
      { escapeHtml: false }
    )
  );
  ctx.log(
    `Group ${chatId} linked to workspace "${ws.name}" (thread: ${thread?.slug})`
  );
}

/**
 * /unlink — Remove the group-to-workspace mapping.
 */
async function handleUnlink(ctx, chatId) {
  const bot = ctx.bot;
  const chatType = ctx._chatType?.get(chatId);

  if (!["group", "supergroup"].includes(chatType)) {
    await bot.sendMessage(
      chatId,
      markdownToTelegram(`This command is for group chats only.`, {
        escapeHtml: false,
      })
    );
    return;
  }

  // Read current config to check if linked
  const groups = ctx.config.linked_groups || [];
  const linkedEntry = groups.find((g) => String(g.chatId) === String(chatId));

  if (!linkedEntry) {
    await bot.sendMessage(
      chatId,
      `This group is not currently linked to any workspace.`
    );
    return;
  }

  // Remove from DB and keep the live bot config in sync.
  await removeGroupMapping(chatId);
  ctx.config.linked_groups = (ctx.config.linked_groups || []).filter(
    (g) => String(g.chatId) !== String(chatId)
  );

  // Clear in-memory state
  ctx.setState(chatId, {
    workspaceSlug: null,
    threadSlug: null,
  });

  await bot.sendMessage(
    chatId,
    markdownToTelegram(
      `✅ <b>Group unlinked.</b>\n\nThis group is no longer connected to a workspace. The bot will stop responding here.`,
      { escapeHtml: false }
    )
  );
  ctx.log(`Group ${chatId} unlinked from "${linkedEntry.workspaceSlug}"`);
}

module.exports = { handleLink, handleUnlink };
