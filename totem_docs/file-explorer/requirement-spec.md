# File Explorer & Viewer — Requirement Spec

**Status:** ✅ Implemented
**Scope:** Read-only file browser + viewer for the `totemllm-fs` sandbox directory
**Depends on:** Per-user filesystem isolation (implemented, v0.2.x)

---

## 1. Problem

Users cannot see what files exist in their `totemllm-fs` sandbox. The agent can create, read, and write files there through its 10 filesystem tools, but there is no UI to browse, inspect, or preview those files. Users must ask the agent to `list-directory` or `read-text-file` and read the agent's text response — clunky, non-interactive, and impossible for binary content (images, PDFs, audio, video).

## 2. Goal

A lightweight, read-only file explorer and viewer accessible from the Totem LLM UI that:

- Lists directory contents with name, type, size, and last-modified date
- Lets the user navigate into subdirectories with breadcrumb navigation
- Renders file content inline based on type (text, image, PDF, audio, video)
- Works transparently in both single-user and multi-user mode with the same UI code
- Reuses the existing per-user sandbox isolation (`getFilesystemFor(userId)` + `validatePath()`) — zero new security surface

## 3. Requirements

### Functional

| # | Requirement |
|---|-------------|
| F1 | User can list the contents of any directory within their sandbox. Default view is the sandbox root. |
| F2 | User can navigate into a subdirectory by clicking it. Breadcrumb shows the full path; clicking any segment navigates back. |
| F3 | User can click a file to view its content in an inline viewer panel. |
| F4 | Text files (`.txt`, `.js`, `.ts`, `.json`, `.yaml`, `.yml`, `.csv`, `.html`, `.css`, `.py`, `.sh`, `.toml`, `.ini`, `.xml`, and any `text/*` MIME except Markdown) render as plain text in a scrollable, monospace `<pre>` block with line numbers. |
| F4b | Markdown files (`.md`, `.markdown`, `.mdown`) render in a lightweight Markdown viewer with syntax-highlighted code blocks (via `highlight.js`). Users can toggle between **Rendered** (HTML) and **Raw** (source) views. Inline HTML in the source is disabled (`html: false`) and sanitized via `DOMPurify` before injection. No new dependencies added (`markdown-it`, `highlight.js`, `dompurify` are already in `package.json`). |
| F5 | Image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`) render inline as a centered image. |
| F6 | PDF files render in a native `<embed>` / `<iframe>` viewer. |
| F7 | Audio and video files render in native `<audio>` / `<video>` players. |
| F8 | Binary / unknown files show a "Binary file (size: X KB)" notice with a download link. |
| F9 | Files larger than 1 MB of text content are truncated with a visible "File truncated — showing first 1 MB" notice. |
| F10 | Empty directories show a "This folder is empty" message. |
| F11 | All navigation and file reads are scoped to the user's sandbox via `getFilesystemFor(userId)`. Cross-user access, path traversal, and symlink escapes are denied with HTTP 403. |

### Non-functional

| # | Requirement |
|---|-------------|
| N1 | No new security surface. All path validation goes through the existing `validatePath()` in `lib.js`. No new file operations, no new process, no new network path. |
| N2 | The endpoints are read-only. No `POST`, `PUT`, `DELETE`, or `PATCH` routes are added in this iteration. |
| N3 | The UI component is self-contained — no external state library, no new build dependencies beyond what is already in `package.json`. |
| N4 | The frontend code is identical in single-user and multi-user mode. Mode scoping is 100% server-side via `getFilesystemFor(userId)`. |
| N5 | Text reads are capped at 1 MB to prevent memory pressure. Binary reads stream raw bytes with correct `Content-Type`. |
| N6 | The API is designed to be additive: future `PUT /write` (edit) and `POST /upload` routes will slot into the same endpoint file with the same auth + path validation pattern. No restructuring required. |
| N7 | Mobile-responsive: the explorer panel must be usable at 360 px viewport width without horizontal scrolling. |

### Out of scope (explicitly deferred)

- File editing (add `PUT /write` later)
- File upload (add `POST /upload` later)
- File rename, move, delete
- File search / filter
- Directory creation
- File sharing between users
- Drag-and-drop reordering
- File size quotas
- Versioning / history

## 4. Threat Model (what this change does and does not prevent)

- ✅ Prevents: path traversal (`../../etc/passwd`) — blocked by `validatePath()`.
- ✅ Prevents: symlink escapes (symlink inside user A's dir → user B's dir) — blocked by realpath re-check in `validatePath()`.
- ✅ Prevents: cross-user access (user A listing user B's files) — blocked by per-user `FilesystemManager` allow-list.
- ✅ Prevents: unauthenticated access — `validatedRequest` + `flexUserRoleValid` middleware.
- ✅ Prevents: null-byte injection in path params — `validatePath()` checks for `\x00`.
- ❌ Does not prevent: a user downloading their own files (expected behavior).
- ❌ Does not prevent: a user's files being visible in browser cache after the raw endpoint (mitigated by `Cache-Control: no-store` header).
- ❌ Does not prevent: very large files being streamed via the raw endpoint (bounded by server bandwidth; no DoS vector unique to this feature).

## 5. Acceptance Criteria

1. In single-user mode, `GET /api/filesystem/list` with no `path` param returns the entries of `$STORAGE_DIR/totemllm-fs/` and HTTP 200.
2. In multi-user mode, `GET /api/filesystem/list` for user 42 returns entries from `$STORAGE_DIR/totemllm-fs/users/42/` only. User 7 cannot list user 42's directory (HTTP 403).
3. `GET /api/filesystem/list?path=../../etc` returns HTTP 403 with an "Access denied" message.
4. `GET /api/filesystem/read?path=notes.md` returns the file content as JSON `{ path, mime, size, content, truncated: false }` for a text file.
5. `GET /api/filesystem/read?path=photo.png` returns JSON `{ path, mime, size, content: null, truncated: false, downloadUrl }`.
6. `GET /api/filesystem/read?path=photo.png&raw=true` returns the raw bytes with `Content-Type: image/png` and `Content-Disposition: inline`.
7. `GET /api/filesystem/read?path=../../../etc/passwd` returns HTTP 403.
8. `GET /api/filesystem/read?path=nonexistent.txt` returns HTTP 404.
9. An unauthenticated request to any `/api/filesystem/*` route returns HTTP 401.
10. A 2 MB text file returns `content` truncated to ~1 MB with `truncated: true`.
11. The frontend renders the directory listing, breadcrumb navigation, and file viewer correctly for all file types in F4–F8.
12. No existing tests regress. `yarn test` passes.

## 6. API Design

### `GET /api/filesystem/list`

**Query params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | No | Relative path within sandbox. Default `""` (root). |

**Auth:** `validatedRequest` + `flexUserRoleValid([ROLES.all])`

**200 Response:**
```json
{
  "path": "docs/specs",
  "entries": [
    { "name": "AGENTS.md", "type": "file", "size": 14200, "mtime": "2026-10-17T08:00:00Z" },
    { "name": "specs/",    "type": "dir",  "size": null,  "mtime": "2026-10-15T12:00:00Z" }
  ]
}
```

**Error responses:**
| Status | Body | Trigger |
|--------|------|---------|
| 400 | `{ "error": "Invalid path" }` | `path` contains null bytes or is not a string |
| 401 | `{ "error": "Unauthorized" }` | No valid session |
| 403 | `{ "error": "Access denied - path outside allowed directories." }` | Path traversal / cross-user / symlink escape |
| 404 | `{ "error": "Directory not found" }` | Valid path but not a directory |
| 500 | `{ "error": "Internal server error" }` | Unexpected I/O failure |

### `GET /api/filesystem/read`

**Query params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | Yes | Relative path to the file within sandbox. |
| `raw` | string | No | If `"true"`, stream raw bytes with correct `Content-Type`. |

**Auth:** `validatedRequest` + `flexUserRoleValid([ROLES.all])`

**200 Response (JSON, `raw` not set):**
```json
{
  "path": "docs/AGENTS.md",
  "mime": "text/markdown",
  "size": 14200,
  "content": "# AGENTS.md\n...",
  "truncated": false
}
```

For binary files (image, PDF, audio, video, unknown):
```json
{
  "path": "images/logo.png",
  "mime": "image/png",
  "size": 52000,
  "content": null,
  "truncated": false,
  "downloadUrl": "/api/filesystem/read?path=images%2Flogo.png&raw=true"
}
```

**200 Response (raw, `raw=true`):**
- Body: raw file bytes
- Headers: `Content-Type: <mime>`, `Content-Length: <size>`, `Content-Disposition: inline; filename="<name>"`, `Cache-Control: no-store`

**Error responses:** Same table as `list`.

### MIME type mapping

The endpoint uses a static extension → MIME map (no `mime-types` package dependency). Extensions not in the map default to `application/octet-stream`. The map covers all types in F4–F8:

| Category | Extensions |
|----------|-----------|
| Text | `.txt`, `.md`, `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.json`, `.yaml`, `.yml`, `.csv`, `.html`, `.css`, `.py`, `.sh`, `.rb`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`, `.toml`, `.ini`, `.xml`, `.sql`, `.env`, `.log`, `.dockerfile` |
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp` |
| PDF | `.pdf` |
| Audio | `.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`, `.aac` |
| Video | `.mp4`, `.webm`, `.ogv`, `.mov` |

## 7. Extensibility (forward-compatible by design)

| Future feature | What to add | What to change in this iteration's code |
|---------------|-------------|----------------------------------------|
| File editing | `PUT /api/filesystem/write?path=...` endpoint (same auth, same `validatePath`, same `getFilesystemFor`) | Nothing — `read` JSON response is already editor-ready (`content` field) |
| File upload | `POST /api/filesystem/upload?path=...` with `multipart/form-data` | Nothing — `list` will show the new file automatically |
| Rename / Move | `PATCH /api/filesystem/rename` | Nothing |
| Delete | `DELETE /api/filesystem/delete?path=...` | Nothing |

The endpoint file (`server/endpoints/filesystem.js`) is the single home for all filesystem UI operations. New routes are additive lines in the same function, using the same `resolveFsForUser(user)` helper.
