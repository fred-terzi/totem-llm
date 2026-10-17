const path = require("path");
const fs = require("fs/promises");
const { createReadStream } = require("fs");
const { humanFileSize } = require("../utils/helpers");
const { userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const {
  getFilesystemFor,
} = require("../utils/agents/aibitat/plugins/filesystem/lib.js");

/**
 * File Explorer & Viewer endpoints (read-only).
 *
 * GET /filesystem/list  — directory listing for the current user's sandbox
 * GET /filesystem/read  — file preview (text) or raw bytes (image/pdf/audio/video/binary)
 *
 * Both endpoints reuse the existing `getFilesystemFor()` + `validatePath()`
 * security layer from `server/utils/agents/aibitat/plugins/filesystem/lib.js`,
 * so there is no new attack surface (path traversal, symlink escape, null-byte
 * injection are all handled by the existing implementation).
 *
 * Auth: `validatedRequest` + `flexUserRoleValid([ROLES.all])` — any
 * authenticated user may browse and preview their own sandbox (N1, N6).
 */

/* ------------------------------------------------------------------ */
/*  MIME type map (N4: static map, no new dependencies)                */
/* ------------------------------------------------------------------ */

const MIME_MAP = {
  // Text
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".jsx": "text/jsx",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".toml": "text/toml",
  ".ini": "text/plain",
  ".xml": "text/xml",
  ".sql": "text/x-sql",
  ".env": "text/plain",
  ".log": "text/plain",
  ".dockerfile": "text/plain",
  // Image
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  // PDF
  ".pdf": "application/pdf",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
};

/**
 * Returns the MIME type for a filename, or `application/octet-stream` as
 * fallback for unknown extensions.
 * @param {string} filename - File name (basename or full path)
 * @returns {string} MIME type
 */
function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

/**
 * A MIME type is "text-like" when we can return its content inline as a UTF-8
 * string in the JSON response. Everything else is treated as binary and the
 * client is given a `downloadUrl` to fetch raw bytes.
 * @param {string} mime
 * @returns {boolean}
 */
function isTextMime(mime) {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "image/svg+xml"
  );
}

/** Cap for text content returned inline (F9, N5): 1 MiB. */
const MAX_TEXT_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Resolves the per-user `FilesystemManager` for the current request.
 * - Multi-user mode: the user from the session → their sandbox.
 * - Single-user mode: `null` → shared default sandbox.
 *
 * All future read/write endpoints reuse this single point of resolution (N6).
 * @param {object} request - Express request
 * @param {object} response - Express response
 * @returns {Promise<import("../utils/agents/aibitat/plugins/filesystem/lib.js").FilesystemManager>}
 */
async function resolveFsForRequest(request, response) {
  const user = await userFromSession(request, response);
  if (!user) return getFilesystemFor(null);
  return getFilesystemFor(user.id);
}

/**
 * Maps a thrown `validatePath()` error to the appropriate HTTP status code
 * per the spec (§6 error-response table).
 *
 * @param {Error} error
 * @returns {{status: number, message: string}}
 */
function classifyValidationError(error) {
  const message = error?.message || String(error);
  if (/access denied/i.test(message)) {
    return { status: 403, message: "Access denied" };
  }
  if (/does not exist/i.test(message)) {
    return { status: 404, message: "Path not found" };
  }
  return { status: 500, message: "Internal error" };
}

/* ------------------------------------------------------------------ */
/*  GET /filesystem/list                                                */
/* ------------------------------------------------------------------ */

/**
 * Directory listing for the current user's sandbox.
 *
 * Query:
 *   path (optional) — relative path within the sandbox; "" or omitted = root
 *
 * Response (200):
 *   {
 *     path: string,        // the path as requested (relative)
 *     entries: [
 *       { name, type: "file"|"dir", size: number|null, sizeFormatted: string|null,
 *         modified: string|null, mime: string|null }
 *     ]
 *   }
 *
 * Errors:
 *   400 — path contains null bytes
 *   403 — path escapes the sandbox (traversal / absolute / symlink)
 *   404 — directory does not exist
 */
async function handleList(request, response) {
  const rawPath =
    typeof request.query.path === "string" ? request.query.path : "";

  // Fast-fail: null bytes are not a valid path input (spec §6).
  if (rawPath.includes("\x00")) {
    return response
      .status(400)
      .json({ message: "Invalid path: null byte not allowed" });
  }

  let absolutePath;
  try {
    // Resolve against the user's sandbox root. A relative path is resolved
    // by `validatePath` against the allow-list; an absolute path outside the
    // allow-list is rejected.
    absolutePath = await (
      await resolveFsForRequest(request, response)
    ).validatePath(rawPath || ".");
  } catch (e) {
    const { status, message } = classifyValidationError(e);
    console.warn(
      `[filesystem:list] ${status} for path=${JSON.stringify(rawPath)}: ${e.message}`
    );
    return response.status(status).json({ message });
  }

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (e) {
    if (e.code === "ENOENT") {
      return response.status(404).json({ message: "Directory not found" });
    }
    console.error("[filesystem:list] stat error:", e);
    return response.status(500).json({ message: "Internal error" });
  }

  if (!stat.isDirectory()) {
    return response.status(404).json({ message: "Directory not found" });
  }

  let dirents;
  try {
    dirents = await fs.readdir(absolutePath, { withFileTypes: true });
  } catch (e) {
    console.error("[filesystem:list] readdir error:", e);
    return response.status(500).json({ message: "Internal error" });
  }

  // Gather entries, statting each to get size + mtime. We do this in
  // parallel so deep trees stay fast, and tolerate individual stat failures
  // (e.g. broken symlink) by omitting size/modified for that entry.
  const statPromises = dirents.map(async (entry) => {
    const name = entry.name;
    const type = entry.isDirectory() ? "dir" : "file";
    let size = null;
    let modified = null;
    try {
      const s = await fs.stat(path.join(absolutePath, name));
      if (s.isDirectory()) {
        modified = s.mtime.toISOString();
      } else {
        size = s.size;
        modified = s.mtime.toISOString();
      }
    } catch {
      // Permission errors or broken symlinks — still list the entry,
      // just without size/modified.
    }
    return {
      name,
      type,
      size,
      sizeFormatted:
        type === "file" && size != null ? humanFileSize(size, true, 2) : null,
      modified,
      mime: type === "file" ? mimeFor(name) : null,
    };
  });

  const entries = (await Promise.all(statPromises)).filter(Boolean);

  // Sort: directories first, then files, both alphabetically (case-insensitive).
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return response.json({
    path: rawPath,
    entries,
  });
}

/* ------------------------------------------------------------------ */
/*  GET /filesystem/read                                                */
/* ------------------------------------------------------------------ */

/**
 * File preview for the current user's sandbox.
 *
 * Query:
 *   path (required) — file path (relative or absolute within the sandbox)
 *   raw  (optional) — "true" → stream raw bytes with the correct Content-Type
 *
 * JSON response (default):
 *   Text:     { path, mime, size, content, truncated: boolean }
 *   Binary:   { path, mime, size, content: null, truncated: false,
 *               downloadUrl }
 *
 * Errors:
 *   400 — missing path / null bytes / path is a directory
 *   403 — path escapes the sandbox
 *   404 — file does not exist
 */
async function handleRead(request, response) {
  const rawPath =
    typeof request.query.path === "string" ? request.query.path : null;

  if (!rawPath) {
    return response
      .status(400)
      .json({ message: "Missing required query parameter: path" });
  }
  if (rawPath.includes("\x00")) {
    return response
      .status(400)
      .json({ message: "Invalid path: null byte not allowed" });
  }

  let absolutePath;
  try {
    absolutePath = await (
      await resolveFsForRequest(request, response)
    ).validatePath(rawPath);
  } catch (e) {
    const { status, message } = classifyValidationError(e);
    console.warn(
      `[filesystem:read] ${status} for path=${JSON.stringify(rawPath)}: ${e.message}`
    );
    return response.status(status).json({ message });
  }

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (e) {
    if (e.code === "ENOENT") {
      return response.status(404).json({ message: "File not found" });
    }
    console.error("[filesystem:read] stat error:", e);
    return response.status(500).json({ message: "Internal error" });
  }

  if (stat.isDirectory()) {
    return response
      .status(400)
      .json({ message: "Path is a directory, not a file" });
  }

  const mime = mimeFor(absolutePath);
  const filename = path.basename(absolutePath);
  const wantsRaw = request.query.raw === "true";

  if (wantsRaw) {
    // Stream raw bytes. Use Content-Disposition: inline so browsers will
    // render images / PDFs / audio / video natively when the user navigates
    // directly to this URL (e.g. via an <img> or <video> tag).
    response.setHeader("Content-Type", mime);
    response.setHeader("Content-Length", String(stat.size));
    response.setHeader(
      "Content-Disposition",
      `inline; filename="${filename.replace(/"/g, '\\"')}"`
    );
    response.setHeader("Cache-Control", "no-store");

    const stream = createReadStream(absolutePath);
    stream.on("error", (err) => {
      console.error("[filesystem:read] stream error:", err);
      if (!response.headersSent) {
        response.status(500).json({ message: "Internal error" });
      } else {
        try {
          response.end();
        } catch {}
      }
    });
    stream.pipe(response);
    return;
  }

  // JSON mode.
  if (isTextMime(mime)) {
    let content;
    let truncated = false;
    if (stat.size > MAX_TEXT_BYTES) {
      // Range-read only the first MAX_TEXT_BYTES to avoid loading the whole
      // file into memory for large text files (N5).
      const buf = Buffer.alloc(MAX_TEXT_BYTES);
      const fh = await fs.open(absolutePath, "r");
      try {
        const { bytesRead } = await fh.read(buf, 0, MAX_TEXT_BYTES, 0);
        content = buf.subarray(0, bytesRead).toString("utf-8");
      } finally {
        await fh.close();
      }
      truncated = true;
    } else {
      content = await fs.readFile(absolutePath, "utf-8");
    }
    return response.json({
      path: rawPath,
      mime,
      size: stat.size,
      content,
      truncated,
    });
  }

  // Binary content (image, PDF, audio, video, unknown): return metadata plus
  // a URL the client can use to fetch raw bytes (F8).
  const downloadUrl = `/api/filesystem/read?path=${encodeURIComponent(
    rawPath
  )}&raw=true`;
  return response.json({
    path: rawPath,
    mime,
    size: stat.size,
    content: null,
    truncated: false,
    downloadUrl,
  });
}

/* ------------------------------------------------------------------ */
/*  Route registration (Step 2)                                         */
/* ------------------------------------------------------------------ */

/**
 * Registers the file-explorer routes on the given router (typically the
 * `apiRouter` mounted at `/api` in `server/index.js`).
 *
 * @param {import("express").Router} app - Express app or router
 */
function filesystemEndpoints(app) {
  if (!app) return;

  app.get(
    "/filesystem/list",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    handleList
  );

  app.get(
    "/filesystem/read",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    handleRead
  );
}

module.exports = {
  filesystemEndpoints,
  handleList,
  handleRead,
  mimeFor,
  isTextMime,
  MAX_TEXT_BYTES,
};
