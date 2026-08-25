const fs = require("fs");
const path = require("path");

/**
 * Resolves the actual export directory. Handles both:
 * - Direct path to the folder containing conversations-*.json
 * - Path to a parent folder that contains exactly one subdirectory with the export
 * @param {string} dirPath - User-provided path
 * @returns {{dir: string, error: string|null}} Resolved directory or error message
 */
function resolveExportDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return { dir: null, error: `Directory not found: ${dirPath}` };
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    return { dir: null, error: `Path is not a directory: ${dirPath}` };
  }

  // Check if this directory directly contains conversation files
  const entries = fs.readdirSync(dirPath);
  const hasConversations = entries.some((f) => /^conversations-\d{3}\.json$/.test(f));

  if (hasConversations) {
    return { dir: dirPath, error: null };
  }

  // Otherwise check for a single subdirectory that contains the export
  const subdirs = entries
    .filter((f) => fs.statSync(path.join(dirPath, f)).isDirectory())
    .map((f) => path.join(dirPath, f));

  if (subdirs.length === 1) {
    const subEntries = fs.readdirSync(subdirs[0]);
    if (subEntries.some((f) => /^conversations-\d{3}\.json$/.test(f))) {
      return { dir: subdirs[0], error: null };
    }
  }

  // Multiple subdirs — try to find one with conversations
  for (const sub of subdirs) {
    const subEntries = fs.readdirSync(sub);
    if (subEntries.some((f) => /^conversations-\d{3}\.json$/.test(f))) {
      return { dir: sub, error: null };
    }
  }

  return {
    dir: null,
    error: `No conversation files found in ${dirPath}. Expected at least 'conversations-000.json'.`,
  };
}

/**
 * Validates that a directory (or zip-extracted folder) contains the expected
 * ChatGPT export structure. Returns an error message if invalid, or null on success.
 */
function validateExportDirectory(dirPath) {
  const { dir: resolvedDir, error } = resolveExportDir(dirPath);
  if (error) return error;

  // Verify the first conversation file is valid JSON
  try {
    const raw = fs.readFileSync(path.join(resolvedDir, "conversations-000.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return `conversations-000.json does not contain a JSON array.`;
    }
  } catch (e) {
    return `Failed to parse conversations-000.json: ${e.message}`;
  }

  return null; // Valid
}

/**
 * Returns metadata about the export for preview purposes.
 */
function getExportMetadata(dirPath) {
  const { dir: resolvedDir, error } = resolveExportDir(dirPath);
  if (error) throw new Error(error);

  const entries = fs.readdirSync(resolvedDir);
  const conversationFiles = entries
    .filter((f) => /^conversations-\d{3}\.json$/.test(f))
    .sort();

  let totalConversations = 0;
  let totalMessages = 0;
  let earliestDate = null;
  let latestDate = null;

  for (const file of conversationFiles) {
    const raw = fs.readFileSync(path.join(resolvedDir, file), "utf-8");
    const conversations = JSON.parse(raw);

    if (!Array.isArray(conversations)) continue;

    totalConversations += conversations.length;

    for (const conv of conversations) {
      if (conv.create_time && earliestDate === null)
        earliestDate = conv.create_time;
      if (conv.create_time > (earliestDate || 0)) latestDate = conv.create_time;

      // Count messages in the mapping tree
      const mappingSize = Object.keys(conv.mapping || {}).length - 1; // minus root
      totalMessages += Math.max(0, mappingSize);
    }
  }

  return {
    fileCount: conversationFiles.length,
    totalConversations,
    totalMessages,
    earliestDate: earliestDate ? new Date(earliestDate * 1000).toISOString() : null,
    latestDate: latestDate ? new Date(latestDate * 1000).toISOString() : null,
  };
}

module.exports = { validateExportDirectory, getExportMetadata, resolveExportDir };
