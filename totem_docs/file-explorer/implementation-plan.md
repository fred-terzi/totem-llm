# File Explorer & Viewer — Implementation Plan

> **Status:** ✅ **Implemented** (all steps complete; Markdown viewer + topbar button added)

**Date:** 2026-06-20 (implemented through 2026-10-17)
**Depends on:** `requirement-spec.md` (F1–F4b, A1–A4, N1–N8, §6 error table)
**Strategy:** one PR — `feat: file explorer & viewer`
**Commits (chronological, `dev-totem`):**

```
0148547e  feat(file-explorer): add filesystem endpoint module (list + read)
996ee299  feat: add FileExplorerButton to user menu dropdown
52365048  fix(ui): raise desktop sidebar z-index above the top bar
b1c44053  fix(frontend): track FileExplorerButton component
221f30bf  fix(chat-settings-menu): shrink-wrap dropdowns to fit on mobile
d5fbc4c8  fix(file-explorer): remove centered logo from SettingsSidebar mobile top bar
70bc1f49  fix(file-explorer): halve mobile top padding to mt-8 / calc(100%-32px)
fafb7965  feat(file-explorer): add lightweight Markdown viewer with rendered/raw toggle
8f84d1d4  test(file-explorer): add endpoint test suite (19 cases)
00c4612a  docs(file-explorer): update plan, spec, index, release notes
```

---

## Step 0 — Recon ✅

Findings that shaped the plan (all confirmed against the codebase):

1. **No `GET /files` endpoint exists.** The server has only write-oriented endpoints (`/fs/*`, `/workspace/*`) and a single `GET /workspace/:id/file-preview` bound to a specific workspace. A new module is required.
2. **`getFilesystemFor(userId)`** in `server/utils/agents/aibitat/plugins/filesystem/lib.js` exposes `validatePath()`, `ls()`, `read()` — the security + I/O layer we must reuse. `getFilesystemFor(null)` resolves the shared single-user sandbox.
3. **Auth pattern:** every route pair in `server/endpoints/*.js` is registered as `app.get/post('/route', [validatedRequest, flexUserRoleValid([ROLES.all])], handler)` on the `apiRouter` (mounted at `/api` in `server/index.js`). Handlers read the user via `userFromSession(request, response)` from `server/utils/http.js` (user lands on `response.locals.user`).
4. **No shared MIME utility** exists in the codebase — a static map is required (A1).
5. **Frontend:** Vite + React Router v7 (`createBrowserRouter`), route registration in `frontend/src/main.jsx`. Tailwind v4 + theme tokens (`bg-theme-bg-secondary`, `text-theme-text-primary`, …) plus `light:` variants; `@phosphor-icons/react`; `react-loading-skeleton`; `react-device-detect` (`isMobile`). No virtualised-list or tree-select library present — keep it lightweight.
6. **`/settings/*` pages** render inside a shared settings shell: `frontend/src/components/SettingsSidebar` provides the left nav + mobile top bar; the page body sits in `bg-theme-bg-secondary` with a header row, exactly as in `GeneralSettings/index.jsx`.
7. **`paths.settings.files()`** added in `frontend/src/utils/paths.js` → `/settings/files`.

---

## Step 1 — Server endpoint module ✅

**File:** `server/endpoints/filesystem.js` (450 lines, CJS)

### 1a. Exports

```js
module.exports = { filesystemEndpoints, handleList, handleRead, mimeFor, isTextMime, MAX_TEXT_BYTES };
```

### 1b. MIME map (A1, N4)

Static extension → MIME map (`MIME_MAP`, ~55 entries: text, image, PDF, audio, video). Unknown extensions fall back to `application/octet-stream`.

```js
function mimeFor(filename) { /* path.extname → MIME_MAP[ext] || "application/octet-stream" */ }
```

### 1c. Text-like helper (N4)

```js
function isTextMime(mime) {
  return mime.startsWith("text/") || mime === "application/json" || mime === "image/svg+xml";
}
```

`MAX_TEXT_BYTES = 1 MiB` (F9, N5).

### 1d. Sandbox resolution — `resolveFsForRequest(request, response)`

> ⚠️ **Deviated from the original step text (improvement).** The original plan called `resolveFsForUser(user)`; the implementation resolves the sandbox in one step from the request:

```js
async function resolveFsForRequest(request, response) {
  const user = await userFromSession(request, response);
  if (!user) return getFilesystemFor(null);   // single-user mode → shared sandbox
  return getFilesystemFor(user.id);            // multi-user mode → per-user sandbox
}
```

### 1e. Error classification — `classifyValidationError(error)`

> ⚠️ **Deviated from the original step text (improvement).** The original plan re-threw with HTTP status; the implementation returns a `{status, message}` object:

```js
function classifyValidationError(error) {
  const message = error?.message || String(error);
  if (/access denied/i.test(message)) return { status: 403, message: "Access denied" };
  if (/does not exist/i.test(message)) return { status: 404, message: "Path not found" };
  return { status: 500, message: "Internal error" };
}
```

### 1f. `handleList(request, response)`

- Null-byte check → **400** (spec §6).
- `validatePath(rawPath || ".")` → **400/403/404** via `classifyValidationError`.
- `fs.stat` → **404** on ENOENT; **404** (`"Directory not found"`) if the path is a file (not a directory) — matches spec §6 ("valid path but not a directory" → 404).
- `fs.readdir(absolutePath, { withFileTypes: true })`.
- Per-entry `fs.stat` **in parallel** (`Promise.all`), tolerating individual failures (broken symlinks) — the entry is still listed, just without `size`/`modified`.
- Each entry: `{ name, type, size, sizeFormatted, modified, mime }` — `sizeFormatted` via the existing `humanFileSize(size, true, 2)` helper from `server/utils/helpers.js`; `mime` via `mimeFor` (files only).
- Sort: **directories first, then files**, case-insensitive alphabetical.
- Response: `{ path: rawPath, entries }`.

### 1g. `handleRead(request, response)`

- `path` required → **400** if missing; null-byte check → **400**.
- `validatePath(rawPath)` → 400/403/404.
- `fs.stat` → **404** if missing; **400** if it is a directory.
- **Raw mode** (`?raw=true`): streams the file with `Content-Type`, `Content-Length`, `Content-Disposition: inline; filename="…"` (quoting-escaped), `Cache-Control: no-store`. Stream errors handled on both `headersSent` paths. This is what `<img>/<embed>/<audio>/<video>` and Download links hit.
- **JSON mode, text-like:** if `size > 1 MiB`, range-reads **only the first 1 MiB** (fd open → `read` → close; `truncated: true`); otherwise full `fs.readFile(…, "utf-8")`. Response: `{ path, mime, size, content, truncated }`.
- **JSON mode, binary:** `{ path, mime, size, content: null, truncated: false, downloadUrl }` where `downloadUrl = /api/filesystem/read?path=…&raw=true`.

> **Note:** the server `downloadUrl` is a fixed `/api/…` path; the frontend `rawUrl()` helper (below) builds its own URL from `API_BASE` so cross-origin dev setups keep working.

### 1h. Route registration — `filesystemEndpoints(app)`

```js
function filesystemEndpoints(app) {
  if (!app) return;
  app.get("/filesystem/list", [validatedRequest, flexUserRoleValid([ROLES.all])], handleList);
  app.get("/filesystem/read", [validatedRequest, flexUserRoleValid([ROLES.all])], handleRead);
}
```

Mounted on `apiRouter` in `server/index.js` (alongside `workspaceEndpoints`, `chatEndpoints`, …). Full URLs: `GET /api/filesystem/list`, `GET /api/filesystem/read`.

**Acceptance:** `yarn test` → **19/19 filesystem endpoint tests passed** (`server/__tests__/endpoints/filesystem.test.js`, suite added in Step 5a / commit `8f84d1d4`).

---

## Step 2 — Route registration in `server/index.js` ✅

- `require("./endpoints/filesystem")` next to the other endpoint modules.
- `filesystemEndpoints(apiRouter)` call inside the existing endpoint-registration block.
- Same middleware chain as every other endpoint — zero special-casing.
- `git status` shows no untracked/modified files beyond the two above.

**Acceptance:** `yarn dev:all` boots; both routes respond with `401` when unauthenticated (middleware fires before handler). ✅

---

## Step 3 — Frontend component ✅

**Route:** `/settings/files` → lazy-loaded `frontend/src/components/FileExplorer` wrapped in `PrivateRoute` (registered in `frontend/src/main.jsx`).

```jsx
{
  path: "/settings/files",
  element: async () => {
    const { default: FileExplorer } = await import("@/components/FileExplorer");
    return { element: <PrivateRoute Component={FileExplorer} /> };
  },
}
```

### Files (all implemented)

```
frontend/src/components/FileExplorer/
  index.jsx        (231 lines)  page shell: header, breadcrumb, two-pane/mobile layout
  Breadcrumb.jsx    (63 lines)  clickable path trail (HardDrives root, CaretRight separators)
  FileList.jsx     (138 lines)  directory listing rows + skeletons + empty state
  FileViewer.jsx   (338 lines)  file header + type-specific sub-renderers
frontend/src/components/FileExplorerButton/index.jsx   topbar entry point (see §7)
```

No separate CSS file — Tailwind utility classes inline (per plan §3.4 deviation).

### Data flow

- `fetchList(path)` → `GET ${API_BASE}/filesystem/list?path=…` with `baseHeaders()` (auth cookie).
- `fetchFile(path)` → `GET ${API_BASE}/filesystem/read?path=…` (JSON mode).
- `rawUrl(path)` → `${API_BASE}/filesystem/read?path=…&raw=true` — used by `<img>/<embed>/<audio>/<video>` and the Download `<a download>` link.

### Components

- **`index.jsx`** — `currentPath` state; `entries` (`null` = loading); `selectedFile` + `viewerData`; `showViewerOverlay` for mobile. Desktop: two-pane flex (list `w-[40%] min-w-[280px] max-w-[480px]`, viewer `w-[60%]`); mobile: single pane, viewer as `fixed inset-0 z-50` overlay. Empty state: folder icon + "This folder is empty". Error state: red banner. Loading: `react-loading-skeleton` rows.
- **`Breadcrumb.jsx`** — root segment always clickable (except when already at root); intermediate segments clickable; last segment bold, non-clickable.
- **`FileList.jsx`** — Phosphor icons per MIME type (Folder/Image/PDF/Music/Video/FileCode/FileText/File), `sizeFormatted` (sm+), date (`modified`, md+), selected-row ring, hover states.
- **`FileViewer.jsx`** — header (name, MIME, size, close ✕ when `onClose` provided); body dispatch:
  - `isMarkdown(mime)` → **`MarkdownViewer`** (see Step 4)
  - `isTextLike(mime)` → `TextViewer` (monospace `<pre>`, `whitespace-pre-wrap break-words`, `max-h-[60vh] overflow-auto`)
  - `image/*` → `<img>` object-contain
  - `application/pdf` → `<embed>` + "Open in new tab" link
  - `audio/*` / `video/*` → native controls
  - otherwise → `BinaryNotice` (file size + Download button with `href={rawUrl} download={name}`)
  - Truncation banner (amber, `Warning` icon) on both text and Markdown when `truncated`.

### Acceptance

- [x] Route `/settings/files` renders the explorer (single- and multi-user, via topbar button and/or settings nav).
- [x] Navigation up/down updates the list without a full page reload.
- [x] Text, Markdown, image, PDF, audio, video, binary all preview/download correctly.
- [x] >1 MB `.txt` shows the truncation notice.
- [x] 360 px viewport: single pane, overlay viewer, no horizontal scroll (verified during manual QA — two follow-up padding fixes: `d5fbc4c8`, `70bc1f49`).

---

## Step 4 — Markdown viewer ✅ (added 2026-10-17)

**File:** `frontend/src/components/FileExplorer/FileViewer.jsx` (`MarkdownViewer` + module-level `md` instance)

**Requirements:** F4 (Markdown removed from "plain text" path), **F4b** (rendered Markdown viewer).

### Implementation

- **Detection:** `isMarkdown(mime)` matches `text/markdown`, `text/x-markdown`, `text/vnd.github.markdown`. Checked **before** `isTextLike`, so `.md` files get the rich viewer while `.txt`/`.js`/etc. still get `TextViewer`.
- **Renderer:** `markdown-it` configured with:
  - `html: false` — inline HTML in source is escaped/stripped (no raw `<script>`, `<iframe>`, event handlers).
  - `breaks: true`, `linkify: true`.
  - `highlight` callback → **`highlight.js`** (`hljs.highlight(str, { language: lang })`), `github-dark.css` imported.
- **Sanitisation:** rendered output passes through the existing `DOMPurify` wrapper (`@/utils/chat/purify`) before `dangerouslySetInnerHTML` (belt-and-braces on top of `html: false`).
- **Toggle:** pill — **Rendered / Raw** — flips between rendered HTML (prose-styled container, `max-h-[60vh] overflow-auto`) and the raw source in a `<pre>`. `useMemo` caches the rendered HTML per `(mode, content)`.
- **No new dependencies** — `markdown-it`, `highlight.js`, `dompurify` were already in `frontend/package.json` and installed.
- **Truncation banner** preserved in both modes.

**Commit:** `fafb7965`

### Acceptance

- [x] `.md` files render headings, lists, tables, fenced code with syntax highlighting.
- [x] Inline HTML in a `.md` file is not executed/injected.
- [x] Rendered ↔ Raw toggle works; raw view is the original source.
- [x] `.txt`, `.js` files are unaffected (still plain `<pre>`).

---

## Step 5 — Tests

### 5a. Server unit tests ✅ (added 2026-10-17)

`server/__tests__/endpoints/filesystem.test.js` — **19 passing tests** covering:

- **List:** dirs-first alphabetical ordering (F1), size/sizeFormatted/modified for files + null for dirs, empty directory (F2), subdirectory (F3), path traversal 403 (T6), null byte 400 (T5), non-existent directory 404 (T11), per-user sandbox scoping (T7).
- **Read:** text content + mime + size (T1), Markdown mime `text/markdown` (F4b), >1 MiB truncation with `truncated: true` + no tail content (T2), missing file 404 (T3), directory 400 (T4), missing `path` param 400, null byte 400, binary `downloadUrl` (not inline content, T8), `?raw=true` streaming with correct `Content-Type`/`Content-Length`/`Content-Disposition`/`Cache-Control` headers (T9), symlink-escape 403 (T10), cross-user isolation (404 — path is inside the requesting user's sandbox but the file simply isn't there).

**Harness:** same pattern as `requestToken.test.js` / `invite.test.js` — routes captured from a fake Express app, handler invoked directly with mock `request`/`response` objects. Real per-user sandbox directories under `os.tmpdir()` (via `STORAGE_DIR`), so `FilesystemManager.validatePath()` — the security-critical code under test — runs unmocked end-to-end. `userFromSession` is mocked to return `response.locals.user` (the same fast-path the real middleware uses post-login). `?raw=true` uses a real `Writable` so `stream.pipe(response)` works; the test awaits the `"finish"` event before inspecting buffered chunks.

**Commit:** `8f84d1d4`

### 5b. Frontend — manual QA ✅

Completed (see requirement-spec N7 and Step 6).

### 5c. Lint / type-check

- [x] `yarn lint` — clean (no new lint errors across server + frontend changes).

---

## Step 6 — Manual QA ✅

Completed per the requirement-spec checklist (N7): rendering, truncation, 403 cross-user, 360 px viewport, empty folder, all viewer types, mobile overlay, topbar back-navigation.

Follow-up fixes landed during QA:
- `52365048` desktop sidebar z-index above top bar
- `221f30bf` settings dropdowns shrink-wrap on mobile
- `d5fbc4c8` SettingsSidebar mobile top bar cleanup
- `70bc1f49` mobile top padding halved (`mt-8` / `calc(100% - 32px)`)

---

## Step 7 — Topbar button (all roles) ✅

Implements `topbar-button-plan.md`.

**Files:**
- `frontend/src/components/FileExplorerButton/index.jsx` (new, ~55 lines)
- `frontend/src/components/UserMenu/index.jsx` (+2 lines: import + render)
- `frontend/src/utils/paths.js` (`paths.settings.files()` → `/settings/files`)

**Behaviour:**
- **Off** `/settings/files` → `Files` icon → `Link to paths.settings.files()`.
- **On** `/settings/files` → `ArrowUUpLeft` icon → `navigate(-1)` when history exists, else `navigate(paths.home())` (bookmark deep-link case).
- Visible to **all authenticated roles** (rendered inside `UserMenu`, which all roles see); stays visible at 360 px (9×9 icon button, no text label).
- Tooltips via `data-tooltip-id="footer-item"` / `data-tooltip-content`.

**Commits:** `996ee299`, `b1c44053`.

---

## Step 8 — Docs & release ✅

- [x] `requirement-spec.md` — status ✅ Implemented; F4 updated, F4b (Markdown) added.
- [x] `implementation-plan.md` — this document, all steps updated to ✅ with real file paths, line counts, commit hashes, and deviations.
- [x] `totem_docs/README.md` — index entry added (line 32: `File Explorer & Viewer | file-explorer/ | ✅ Implemented`).
- [x] `RELEASE.md` — `feat(file-explorer)` bullet added under **Unreleased**, including Markdown renderer + topbar button sub-bullets.

**Commit:** `00c4612a`

---

## PR strategy

Single PR to `main-totem` from `dev-totem`:

```
feat: file explorer & viewer (read-only sandbox browser + Markdown renderer)

- server/endpoints/filesystem.js: GET /api/filesystem/list + /read (raw/text/binary)
- frontend /settings/files: two-pane explorer, type-aware viewers, mobile overlay
- Markdown viewer (markdown-it + highlight.js + DOMPurify, rendered/raw toggle)
- topbar Files button for all roles (UserMenu)
- reuses existing getFilesystemFor/validatePath authz — zero new attack surface
```

- [x] `yarn lint` — clean
- [x] Manual pass (`yarn dev:all`) — rendering, navigation, truncation, all viewer types, mobile overlay, topbar back-nav
