# File Explorer & Viewer — Implementation Plan

Companion to `requirement-spec.md` in this directory.
All paths relative to repo root `totem-llm/`.

---

## Step 0 — Reconnaissance (investigation, no code)

Goal: confirm the exact auth middleware pattern, endpoint registration pattern, and frontend page structure before writing any code.

**Checklist:**

| # | What to verify | Where | Notes |
|---|----------------|-------|-------|
| 0.1 | How `validatedRequest` + `flexUserRoleValid` are imported and applied in existing endpoint files | `server/endpoints/*.js` (e.g. `workspaces.js`, `credits.js`) | Confirm the exact import path and call signature. Note whether `ROLES.all` is the correct array or if it's `ROLES.read`. |
| 0.2 | How endpoint functions are registered in `server/index.js` | `server/index.js` route registration block | Determine the exact `app.get("/api/filesystem/list", validatedRequest, handler)` pattern. Confirm `validatedRequest` runs *before* the handler. |
| 0.3 | How `userFromSession(req)` returns the user object and how to extract `user.id` | `server/endpoints/utils.js` or wherever it's defined | Needed for `getFilesystemFor(user.id)` call. |
| 0.4 | Frontend page/router structure | `frontend/src/pages/` and `frontend/src/App.jsx` (or `routes.jsx`) | Identify where to mount the new `FileExplorer` page and the navigation entry point. |
| 0.5 | How the frontend makes API calls (fetch wrapper, base URL, auth header) | `frontend/src/` — look for `fetch`, `axios`, or a custom `api()` helper | Determine if there's an existing `api.get(path)` helper or if we use raw `fetch`. |
| 0.6 | Existing CSS approach (Tailwind? CSS modules? plain CSS?) | `frontend/src/` — check `package.json` deps + any `*.css` / `tailwind.config` files | N3 says "no new build dependencies" — confirm which styling system to use. |
| 0.7 | Confirm `getFilesystemFor` export shape in `lib.js` | `server/utils/agents/aibitat/plugins/filesystem/lib.js` | Already verified: `module.exports.getFilesystemFor(userId)` returns a `FilesystemManager` instance. |
| 0.8 | Check if there's an existing `server/endpoints/api/` subdirectory pattern for new endpoints | `server/endpoints/api/` directory listing | Determine if `filesystem.js` should go in `server/endpoints/` or `server/endpoints/api/`. |

**Output:** A short note (inline in this doc, below) recording the exact patterns to follow.

---

## Step 1 — Server: Create `server/endpoints/filesystem.js` ✅ DONE

**New file:** `server/endpoints/filesystem.js` (CJS, matching all other `server/endpoints/*.js`)

### 1.1 — MIME type map (module-level constant)

```js
const MIME_MAP = {
  // Text
  ".txt": "text/plain", ".md": "text/markdown",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".ts": "text/typescript", ".tsx": "text/tsx", ".jsx": "text/jsx",
  ".json": "application/json",
  ".yaml": "text/yaml", ".yml": "text/yaml",
  ".csv": "text/csv",
  ".html": "text/html", ".css": "text/css",
  ".py": "text/x-python", ".sh": "text/x-shellscript",
  ".rb": "text/x-ruby", ".go": "text/x-go", ".rs": "text/x-rust",
  ".java": "text/x-java", ".c": "text/x-c", ".cpp": "text/x-c++",
  ".h": "text/x-c", ".hpp": "text/x-c++",
  ".toml": "text/toml", ".ini": "text/plain",
  ".xml": "text/xml", ".sql": "text/x-sql",
  ".env": "text/plain", ".log": "text/plain",
  ".dockerfile": "text/plain",
  // Image
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".bmp": "image/bmp",
  // PDF
  ".pdf": "application/pdf",
  // Audio
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
  // Video
  ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime",
};

function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}
```

No new npm dependency. Static map covers all extensions in F4–F8.

### 1.2 — Helper: `resolveFsForUser(req)`

```js
const { getFilesystemFor } = require("../utils/agents/aibitat/plugins/filesystem/lib.js");

function resolveFsForUser(user) {
  return getFilesystemFor(user?.id ?? null);
}
```

Single point of user→FilesystemManager resolution. All future endpoints (`PUT /write`, `POST /upload`) reuse this helper (N6).

### 1.3 — Helper: `validatePathOrThrow(fs, requestedPath)`

Thin wrapper that calls `fs.validatePath(requestedPath)` and maps known error messages to HTTP status codes:

| Error message contains | HTTP status |
|------------------------|-------------|
| `Access denied` | 403 |
| `does not exist` | 404 |
| anything else | 500 |

This keeps the error-response table from the spec (§6) consistent across both endpoints.

### 1.4 — `GET /api/filesystem/list` handler

```
function handleList(req, res) {
  1. user = userFromSession(req)          ← from Step 0.3
  2. fs   = resolveFsForUser(user)
  3. rawPath = req.query.path || ""       ← default root (F1)
  4. absolutePath = await fs.validatePath(rawPath || ".")
     // resolve against the sandbox root
  5. stat = await fs.stat(absolutePath)   ← use raw fs.stat, not fs.getFileStats (we need isDirectory)
     - if (!stat.isDirectory()) → 404 "Directory not found"
  6. entries = await readdir(absolutePath, { withFileTypes: true })
  7. Map each entry → { name, type: "file"|"dir", size, mtime }
     - For files: stat each (batched) to get size + mtime
     - For dirs:  size = null, mtime from stat
     - Sort: dirs first, then files, both alphabetically
  8. res.json({ path: rawPath, entries })
}
```

**Edge cases:**
- `path` query param contains null bytes → 400 (checked by `validatePath` → `#normalizeAndValidatePath` returns `null` → throw 400)
- `path` is absolute (`/etc/passwd`) → `validatePath` denies → 403
- `path` is `../../etc` → `validatePath` denies → 403
- Directory doesn't exist → 404
- Empty directory → `{ path, entries: [] }` (F10: frontend shows "empty" message)

### 1.5 — `GET /api/filesystem/read` handler

```
function handleRead(req, res) {
  1. user  = userFromSession(req)
  2. fs    = resolveFsForUser(user)
  3. path  = req.query.path               ← required
     - if (!path) → 400
  4. absolutePath = await fs.validatePath(path)   ← throws 403/404 on error
  5. stat = await fs.stat(absolutePath)
     - if (stat.isDirectory()) → 400 "Path is a directory, not a file"
  6. mime = mimeFor(path.basename(absolutePath))

  7. IF req.query.raw === "true":
       // Stream raw bytes
       res.setHeader("Content-Type", mime)
       res.setHeader("Content-Length", stat.size)
       res.setHeader("Content-Disposition", `inline; filename="${path.basename(absolutePath)}"`)
       res.setHeader("Cache-Control", "no-store")
       createReadStream(absolutePath).pipe(res)
     RETURN

  8. ELSE (JSON mode):
     IF mime starts with "text/" OR mime === "application/json"
        OR mime === "image/svg+xml":
       // Text content — cap at 1 MB (F9, N5)
       const MAX_TEXT_BYTES = 1024 * 1024
       if (stat.size > MAX_TEXT_BYTES) {
         content = await readFile(absolutePath, 0, MAX_TEXT_BYTES, "utf-8")  ← range read
         truncated = true
       } else {
         content = await readFile(absolutePath, "utf-8")
         truncated = false
       }
       res.json({ path, mime, size: stat.size, content, truncated })

     ELSE:
       // Binary (image, PDF, audio, video, unknown) — return null + downloadUrl (F8)
       const downloadUrl = `/api/filesystem/read?path=${encodeURIComponent(path)}&raw=true`
       res.json({ path, mime, size: stat.size, content: null, truncated: false, downloadUrl })
}
```

**Key decisions:**
- Text detection is MIME-based (not extension whitelist) — `text/*` + `application/json` + `image/svg+xml` are all text. This covers all extensions in F4 automatically.
- Range read for truncation: `fs.open` + `fstat` + `read(buffer, 0, MAX, 0)` to avoid loading the full 2 MB+ into memory (N5).
- `downloadUrl` is URL-encoded so paths with spaces or special chars work.
- `Cache-Control: no-store` on raw responses only (threat model §4).

### 1.6 — Export

```js
module.exports = { handleList, handleRead };
```

No middleware attached here — auth is applied at route registration in Step 2.

---

## Step 2 — Server: Register routes in `server/index.js`

**File:** `server/index.js` (or wherever other `/api/*` routes are registered — confirm in Step 0.2)

Add two lines (additive, no restructuring):

```js
const { handleList, handleRead } = require("./endpoints/filesystem.js");

app.get("/api/filesystem/list",  validatedRequest, flexUserRoleValid([ROLES.all]), handleList);
app.get("/api/filesystem/read",  validatedRequest, flexUserRoleValid([ROLES.all]), handleRead);
```

**Notes:**
- `validatedRequest` ensures a valid session exists (401 if not).
- `flexUserRoleValid([ROLES.all])` allows any authenticated user (N1: read-only, no elevated roles needed).
- Both are `GET` only (N2: no `POST`/`PUT`/`DELETE`/`PATCH` in this iteration).
- No CORS changes needed — same-origin `/api/*` proxy already handles this.

**Smoke test (manual):**
```bash
# Unauthenticated → 401
curl -s http://localhost:8686/api/filesystem/list | jq .

# With auth cookie → 200 (single-user mode)
curl -s -b "session=..." http://localhost:8686/api/filesystem/list | jq .
```

---

## Step 3 — Frontend: Create the FileExplorer component

**New files:**
```
frontend/src/components/FileExplorer/
├── index.jsx          ← main component (export default)
├── Breadcrumb.jsx     ← breadcrumb navigation
├── FileList.jsx       ← directory listing table
├── FileViewer.jsx     ← inline content renderer (text/image/PDF/audio/video/binary)
└── FileExplorer.css   ← styles (or Tailwind classes inline — decide in Step 0.6)
```

### 3.1 — `index.jsx` — Main component

**State:**
```js
const [currentPath, setCurrentPath]     = useState("");       // relative path, "" = root
const [entries, setEntries]             = useState(null);      // null = loading, [] = empty
const [selectedFile, setSelectedFile]   = useState(null);      // { name, path } or null
const [viewerData, setViewerData]       = useState(null);      // API response for selected file
const [error, setError]                 = useState(null);
const [loading, setLoading]             = useState(false);
```

**Core logic:**
```
useEffect(() => {
  if (currentPath === null) return;   // initial sentinel before first fetch
  fetchList(currentPath);
}, [currentPath]);

async function fetchList(path) {
  setLoading(true); setError(null); setSelectedFile(null); setViewerData(null);
  const res = await fetch(`/api/filesystem/list?path=${encodeURIComponent(path)}`);
  if (res.status === 403) { setError("Access denied"); setEntries([]); return; }
  if (res.status === 404) { setError("Directory not found"); setEntries([]); return; }
  const data = await res.json();
  setEntries(data.entries);
  setLoading(false);
}

function navigateTo(dirName) {
  const newPath = currentPath ? `${currentPath}/${dirName}` : dirName;
  setCurrentPath(newPath);
}

function goUp() {
  // Remove last segment from currentPath
  const parts = currentPath.split("/");
  parts.pop();
  setCurrentPath(parts.join("/"));
}

function openFile(fileName) {
  const filePath = currentPath ? `${currentPath}/${fileName}` : fileName;
  setSelectedFile({ name: fileName, path: filePath });
  fetchFile(filePath);
}

async function fetchFile(filePath) {
  const res = await fetch(`/api/filesystem/read?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) { setError(await res.json().then(d => d.error)); return; }
  setViewerData(await res.json());
}
```

**Layout (mobile-first, 360 px safe per N7):**
```
┌─────────────────────────────────────┐
│  🔍 File Explorer                    │  ← header
├─────────────────────────────────────┤
│  [root] › docs › specs              │  ← Breadcrumb (wraps at 360px)
├─────────────────────────────────────┤
│  📁 images/          4.2 MB  Oct 15 │  ← FileList rows
│  📄 AGENTS.md        2.8 KB  Oct 17 │
│  📄 config.yaml      800 B   Oct 12 │
├─────────────────────────────────────┤
│                                     │
│  [FileViewer panel — shown when     │
│   a file is selected]               │
│                                     │
└─────────────────────────────────────┘
```

On desktop (>768px): two-pane layout (list left, viewer right).
On mobile (≤768px): single-pane, viewer slides in below list.

### 3.2 — `Breadcrumb.jsx`

**Props:** `{ path: string, onNavigate: (segPath: string) => void }`

- Splits `path` on `/`, renders clickable segments.
- Root segment is always clickable (navigates to `""`).
- Last segment is non-clickable (current location, bold).
- At 360px: segments wrap; max 2 visible with ellipsis overflow.

### 3.3 — `FileList.jsx`

**Props:** `{ entries: [], onDirClick: (name: string) => void, onFileClick: (name: string) => void, selectedFile: string|null }`

- Renders a table (or `div` rows for mobile) with columns: Name, Size, Modified.
- Folders sort first (alpha), then files (alpha). Server returns them pre-sorted.
- Empty array → render `<p className="empty-msg">This folder is empty</p>` (F10).
- Loading state → skeleton rows or spinner.
- Icon per file type (emoji or inline SVG — no new package):
  - `.md` → 📝, `.js/.ts` → 📜, `.png/.jpg` → 🖼, `.pdf` → 📕, `.mp3/.wav` → 🎵, `.mp4` → 🎬, default → 📄
- Clickable rows with `cursor: pointer`, hover highlight.
- Selected file row highlighted.

### 3.4 — `FileViewer.jsx`

**Props:** `{ data: { path, mime, size, content, truncated, downloadUrl } }`

**Render logic (determined by `mime`):**

```
IF mime starts with "text/" OR mime === "application/json" OR mime === "image/svg+xml":
  → <TextViewer content={data.content} truncated={data.truncated} />

ELSE IF mime starts with "image/":
  → <ImageViewer downloadUrl={data.downloadUrl} name={basename(data.path)} />

ELSE IF mime === "application/pdf":
  → <PdfViewer downloadUrl={data.downloadUrl} />

ELSE IF mime starts with "audio/":
  → <AudioPlayer downloadUrl={data.downloadUrl} />

ELSE IF mime starts with "video/":
  → <VideoPlayer downloadUrl={data.downloadUrl} />

ELSE:
  → <BinaryNotice size={data.size} downloadUrl={data.downloadUrl} />
```

**Sub-renderers (all inline in `FileViewer.jsx`, no separate files):**

- **TextViewer:**
  - `<pre>` with `monospace` font, `overflow-x: auto`, `max-height: 60vh`, line numbers via CSS `counter` or a simple `data` row split.
  - If `truncated === true`: render `<div class="trunc-notice">⚠️ File truncated — showing first 1 MB</div>` above the `<pre>` (F9).
  - Syntax highlighting: **out of scope** (N3 — no new deps). Plain monospace text.

- **ImageViewer:**
  - `<img src={downloadUrl} alt={name} style="max-width:100%; max-height:60vh; object-fit:contain" />`
  - Centered in the viewer panel.

- **PdfViewer:**
  - `<embed src={downloadUrl} type="application/pdf" style="width:100%; height:60vh" />`
  - Fallback: `<a href={downloadUrl} download>Download PDF</a>` if embed fails.

- **AudioPlayer:**
  - `<audio controls src={downloadUrl} style="width:100%" />`

- **VideoPlayer:**
  - `<video controls src={downloadUrl} style="width:100%; max-height:60vh" />`

- **BinaryNotice (F8):**
  - `<div>This is a binary file (size: {formatSize(size)}).</div>`
  - `<a href={downloadUrl} download className="btn">⬇️ Download</a>`

### 3.5 — Styles

Use whatever the existing frontend uses (confirm in Step 0.6). If Tailwind: utility classes inline. If CSS: `FileExplorer.css` with BEM-style class names.

**Mobile breakpoints (N7):**
- `≤ 480px`: single column, breadcrumb wraps, file rows stack (name on top, size + mtime below)
- `481px – 768px`: list + viewer stacked vertically
- `> 768px`: two-pane (list 40% left, viewer 60% right)

### 3.6 — Register the page/route

In `frontend/src/App.jsx` (or the router file):

```jsx
import FileExplorer from "./components/FileExplorer";

// Add to the routes array:
{ path: "/filesystem", element: <FileExplorer />, roles: ROLES.all }
```

### 3.7 — Add navigation entry

In the sidebar or user menu (whichever is the primary nav):

```jsx
// In Sidebar.jsx or equivalent:
{ label: "Files", icon: "📁", path: "/filesystem" }
```

---

## Step 4 — Server: Unit tests

**New file:** `server/__tests__/endpoints/filesystem.test.js`

Follow the pattern in `server/__tests__/utils/agents/aibitat/plugins/filesystem/per-user.test.js` (set `STORAGE_DIR` to `os.tmpdir()` before `require`, clean up in `afterAll`).

### Test cases (mapped to acceptance criteria):

| # | AC | Test name | Setup | Expected |
|---|----|-----------|-------|----------|
| T1 | AC1 | `list: returns entries for sandbox root (single-user)` | Write 2 files + 1 dir to default root. Call handler with `req.query.path = ""`, mock `user.id = null` | 200, entries array has 3 items, dirs first |
| T2 | AC2 | `list: user 42 sees only their files (multi-user)` | Write file to `users/42/`, file to `users/7/`. Call with `user.id = 42` | 200, entries has 1 file. Call with `user.id = 7` → 200, 1 file (different) |
| T3 | AC2 | `list: cross-user access denied` | Call with `user.id = 7`, `path = "../42/"` | 403, body contains "Access denied" |
| T4 | AC3 | `list: path traversal denied` | `req.query.path = "../../etc"` | 403 |
| T5 | AC4 | `read: text file returns JSON content` | Write `notes.md` with known content. `user.id = null` | 200, `content` matches, `truncated: false` |
| T6 | AC5 | `read: binary file returns null + downloadUrl` | Write a 1-byte PNG. `raw` not set | 200, `content: null`, `downloadUrl` ends with `&raw=true` |
| T7 | AC6 | `read: raw mode streams bytes with correct headers` | Write a PNG. `req.query.raw = "true"` | 200, `Content-Type: image/png`, `Content-Disposition: inline`, `Cache-Control: no-store` |
| T8 | AC7 | `read: path traversal denied` | `req.query.path = "../../../etc/passwd"` | 403 |
| T9 | AC8 | `read: nonexistent file returns 404` | `req.query.path = "nonexistent.txt"` | 404 |
| T10 | AC9 | `unauthenticated request returns 401` | No session cookie | 401 (tested via middleware, not handler) |
| T11 | AC10 | `read: 2MB text file truncated to ~1MB` | Write a 2 MB text file | 200, `truncated: true`, `content.length` ≈ 1 MB |
| T12 | AC12 | `empty directory returns empty array` | Create empty dir, list it | 200, `entries: []` |

**Mock strategy:**
- Mock `userFromSession` to return `{ id: 42 }` or `{ id: null }` as needed.
- Use real `fs` against `os.tmpdir()` (no jest mock for `fs`) — same pattern as per-user tests.
- For raw streaming: use `supertest` or mock `res` to capture headers + stream.

**Run:** `yarn test --testPathPattern=filesystem`

---

## Step 5 — Frontend: Manual QA checklist

No automated frontend tests in the existing suite (confirm in Step 0). Use manual QA:

| # | Check | How |
|---|-------|-----|
| Q1 | Default view loads sandbox root | Open `/filesystem` in browser |
| Q2 | Breadcrumb: click folder → navigates in; click "root" → goes back | Click through 2+ levels |
| Q3 | Text file renders with line numbers, monospace | Open a `.md` or `.js` file |
| Q4 | 2 MB text file shows truncation notice | Create a large file via agent, open it |
| Q5 | Image renders inline | Place a PNG in sandbox, click it |
| Q6 | PDF renders in embed/iframe | Place a PDF, click it |
| Q7 | Audio/Video play natively | Place an MP3 + MP4, click each |
| Q8 | Binary file shows notice + download link | Place an `.exe` or unknown ext file |
| Q9 | Empty directory shows "This folder is empty" | Create an empty dir, navigate to it |
| Q10 | 360px viewport: no horizontal scroll | DevTools → responsive mode → 360px |
| Q11 | 403 on cross-user: user 7 tries to list user 42's dir | Multi-user mode, switch users |
| Q12 | 401: clear session cookie, hit `/api/filesystem/list` | Network tab in DevTools |

---

## Step 6 — Docs & release

| # | Task | File |
|---|------|------|
| 6.1 | Update `totem_docs/file-explorer/requirement-spec.md` status → "Implemented" | `totem_docs/file-explorer/requirement-spec.md` |
| 6.2 | Create `totem_docs/file-explorer/README.md` (usage, API reference, screenshots) | `totem_docs/file-explorer/README.md` |
| 6.3 | Update `totem_docs/README.md` — add file-explorer row with status | `totem_docs/README.md` |
| 6.4 | Add bullet to `RELEASE.md` under "Upcoming / Unreleased" | `RELEASE.md` |

---

## Ordering & risk

| Step | Files touched | Risk | Notes |
|------|--------------|------|-------|
| 0 | — (read-only) | none | Investigation only; output is notes in this file |
| 1 | `server/endpoints/filesystem.js` (new) | low | Self-contained; no existing code modified. Reuses `getFilesystemFor` + `validatePath` — zero new security surface (N1) |
| 2 | `server/index.js` | **low** | 2 additive route lines. No existing routes modified. |
| 3 | `frontend/src/components/FileExplorer/*` (new), `App.jsx`, `Sidebar.jsx` | **medium** | New component + 2 small edits to existing files. Biggest visual surface. Mitigated by Step 5 manual QA. |
| 4 | `server/__tests__/endpoints/filesystem.test.js` (new) | none | Gate for merge. Catches regression in Steps 1–2. |
| 5 | — (manual) | — | QA gate before PR. |
| 6 | 4 doc files | none | Docs only. |

**PR strategy:** All steps (0–6) land in **a single PR** — `feat: file explorer & viewer`. Steps 0→6 are executed sequentially during development; they are not separate PRs.

---

## Open questions (resolve in Step 0)

| # | Question | Default assumption if unresolved |
|---|----------|---------------------------------|
| OQ1 | Does `validatedRequest` return the user object or set it on `req.user`? | `req.user` property (standard Express pattern) |
| OQ2 | Is there an existing `fetch` wrapper in the frontend, or do we use raw `fetch`? | Raw `fetch` with `credentials: "include"` |
| OQ3 | Is Tailwind in the frontend `package.json`? | If yes → utility classes; if no → CSS file |
| OQ4 | Where exactly in `server/index.js` are routes registered? (top-level, or in a `routes.js`?) | Follow existing pattern in Step 0.2 |
| OQ5 | Should `GET /api/filesystem/list` also accept `?includeHidden=true` to show dotfiles? | No — default `readdir` excludes nothing; keep simple. Dotfiles visible by default (they're the user's files). |

---

## Step 0 — Findings (completed)

### 0.1 · `validatedRequest` + `flexUserRoleValid` import & application

**Imports** (confirmed from `server/endpoints/credits.js` and `server/endpoints/workspaces.js`):

```js
const { userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { flexUserRoleValid, ROLES } = require("../utils/middleware/multiUserProtected");
```

**Application** — middleware array runs *before* the handler:

```js
app.get("/credits", [validatedRequest], async (request, response) => {
  const user = await userFromSession(request, response);
  // ... use user?.id
});

// Elevated roles (not what we need here — for reference):
app.post("/workspace/new", [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])], async (req, res) => { /* ... */ });
```

**`ROLES.all` confirmed** in `server/utils/middleware/multiUserProtected.js`:

```js
const ROLES = { all: "<all>", admin: "admin", manager: "manager", default: "default" };
```

`flexUserRoleValid` short-circuits with `next()` when `ROLES.all` is in the list, so `[ROLES.all]` is the correct array for "any authenticated user". There is no `ROLES.read` token — the plan's note on that is moot.

**Decision:** use `flexUserRoleValid([ROLES.all])`. (OQ1 + the ROLES question resolved.)

---

### 0.2 · Route registration pattern in `server/index.js`

Routes register into an `apiRouter` (mounted at `/api`), **not** directly on `app`. Each endpoint module is a *function* called with `apiRouter` as its argument:

```js
// server/index.js
const app = express();
const apiRouter = express.Router();
app.use("/api", apiRouter);

const { creditEndpoints } = require("./endpoints/credits");
// ...
creditEndpoints(apiRouter);   // each module receives apiRouter and calls apiRouter.get/post(...)
```

```js
// server/endpoints/credits.js (pattern to copy)
function creditEndpoints(app) {
  if (!app) return;
  app.get("/credits", [validatedRequest], async (request, response) => { /* ... */ });
}
module.exports = { creditEndpoints };
```

So the new file exports `{ filesystemEndpoints }`, and `server/index.js` gets one extra line: `filesystemEndpoints(apiRouter);` (placed alongside `creditEndpoints(apiRouter)`).

Because routes register on `apiRouter`, in-handler paths are relative — i.e. `app.get("/filesystem/list", …)` produces the full URL `/api/filesystem/list`. **Step 2 of the plan needs to change** from `app.get("/api/filesystem/list", …)` to `app.get("/filesystem/list", …)` (the `app` argument is the router).

---

### 0.3 · `userFromSession` contract

**Location:** `server/utils/http/index.js` (note: `utils/http/` is a **directory** with `index.js`, not `utils/http.js` — the `require("../utils/http")` import resolves to `index.js`).

**Signature:** `async function userFromSession(request, response = null)` → returns a user record or `null`.

**Semantics:**
- **Multi-user mode:** `validatedRequest` → `validateMultiUserRequest` sets `response.locals.user` to a `User` record; `userFromSession` returns that. `user.id` is the numeric id, `user.role` is `"admin" | "manager" | "default"`.
- **Single-user mode (with or without password):** `userFromSession` returns `null` — there is no user record. `validatedRequest` just runs `next()`.

**Decision for `resolveFsForUser`:** use `user?.id ?? null`. `null` → shared default filesystem (single-user mode). Numeric id → per-user sandbox. This matches `getFilesystemFor(userId)` semantics in `lib.js` (which keys instances by `userId`, with `null` falling through to the shared default instance). (OQ1 confirmed: user is on `response.locals.user`, not `req.user`.)

---

### 0.4 · Frontend routing structure

**Routes live in `frontend/src/main.jsx`** (not `App.jsx`). `App.jsx` is a layout wrapper that renders `<Outlet/>`. Router is `react-router-dom` v6 via `createBrowserRouter`.

Each route uses a `lazy` import + a route-wrapper component from `frontend/src/components/PrivateRoute/index.jsx`:

```jsx
// main.jsx (excerpt)
import PrivateRoute, { AdminRoute, ManagerRoute, SingleUserRoute } from "@/components/PrivateRoute";

const router = createBrowserRouter([
  { path: "/", element: <App />, children: [
    { path: "/", lazy: async () => { const { default: Main } = await import("@/pages/Main"); return { element: <PrivateRoute Component={Main} /> } } },
    // AdminRoute for admin-only pages; ManagerRoute for manager+admin; PrivateRoute for any authenticated user
  ]}
]);
```

**Route wrapper selection** for FileExplorer: **`PrivateRoute`** — any authenticated user (matches `ROLES.all` on the server). `AdminRoute` / `ManagerRoute` / `SingleUserRoute` are the only other variants defined; none fit.

**Navigation entry:** the primary sidebar (`frontend/src/components/Sidebar/index.jsx`) only holds Home + the workspace list + a settings gear. Cross-cutting user-level pages (credits, invites, users, chats, security, branding, etc.) all live under the **GeneralSettings** area (`/settings/...`), not the left sidebar. **Decision:** place the new page at **`/settings/files`** under `GeneralSettings` (consistent with `/settings/credits`, `/settings/chats`, etc.), with a corresponding entry in the `GeneralSettings` nav menu. This avoids touching the primary sidebar (lowers Step 3 risk). (OQ4 resolved.)

---

### 0.5 · Frontend API-call pattern

**No custom fetch wrapper, no axios.** Pattern (from `frontend/src/context/CreditContext.jsx` and `frontend/src/pages/GeneralSettings/ImportData/index.jsx`):

```js
import { API_BASE } from "@/utils/constants";   // "/api" by default
import { baseHeaders } from "@/utils/request";  // { Authorization: `Bearer ${token}` }

const res = await fetch(`${API_BASE}/credits`, { headers: baseHeaders() });
const data = await res.json();
```

- Auth is **header-based** (`Authorization: Bearer …`), not cookies / `credentials: include`.
- All calls are same-origin (the frontend is served alongside the API in production via `express.static`).
- `baseHeaders()` reads the token from `localStorage` (constant `AUTH_TOKEN`).

**Decision:** raw `fetch` with `headers: baseHeaders()`. No new deps. **OQ2 resolved** — the plan's "credentials: include" assumption was wrong; the codebase uses header auth.

---

### 0.6 · Styling system

**Tailwind CSS is the styling system** (`tailwindcss` in `devDependencies`, `tailwind.config.js` present, `@tailwind base/components/utilities` in `frontend/src/index.css`). Custom theme tokens defined in `tailwind.config.js` (e.g. `primary-button`, `secondary`, `sidebar`) backed by CSS variables in `:root`.

Available helpers (already in `deps` — no new packages needed):
- `@phosphor-icons/react` — icon set (the rest of the app uses this; **prefer over emoji** for folder/file icons)
- `react-loading-skeleton` — loading states
- `highlight.js` — **is in `deps`**, so lightweight syntax highlighting is feasible later (out of v1 scope per N3, but available if requested)

**Decision:** use Tailwind utility classes inline; **drop the `FileExplorer.css` file** from Step 3 (use the Tailwind branch of Step 3.5). (OQ3 resolved: Tailwind, yes.)

---

### 0.7 · `getFilesystemFor` export shape

Confirmed in `server/utils/agents/aibitat/plugins/filesystem/lib.js` (lines 840, 859–862):

```js
function getFilesystemFor(userId) { /* ... */ }
module.exports = defaultFilesystem;                              // legacy shared instance
module.exports.defaultFs = defaultFilesystem;
module.exports.getFilesystem = () => defaultFilesystem;
module.exports.getFilesystemFor = getFilesystemFor;
```

- `getFilesystemFor(null)` → shared default instance (single-user).
- `getFilesystemFor(42)` → per-user instance sandboxed to `totemllm-fs/users/42/` (multi-user).
- `instance.validatePath(requestedPath)` throws on traversal / missing path / null bytes (method at `lib.js:444`). It handles symlink escapes, null-byte injection, and parent-directory traversal. No need for a bespoke `validatePathOrThrow` wrapper beyond error→status mapping (Step 1.3 still applies — it's a thin status-code mapper, not a re-implementation).

Step 1.2 signature confirmed correct as written. (OQ7 closed.)

---

### 0.8 · Where to put `filesystem.js`

`server/endpoints/` holds ~28 sibling files (`credits.js`, `workspaces.js`, `wallet.js`, `telegram.js`, …) — each a small module exposing a single `function xxxEndpoints(app)`. `server/endpoints/api/` is a separate namespace for the **developer-facing** API surface (OpenAI-compatible, API-key auth, `developerEndpoints(app, apiRouter)` takes both `app` and `router`).

**Decision:** `server/endpoints/filesystem.js` — sibling of `credits.js`. **Not** inside `server/endpoints/api/` (different audience and different auth model). (OQ4 / Step 0.8 closed.)

---

### Step 0 → plan deltas

| Plan line | Original | Step 0 finding | Required change |
|-----------|----------|----------------|-----------------|
| Step 1.2 imports | `require("../utils/agents/aibitat/plugins/filesystem/lib.js")` | Confirmed correct | — |
| Step 2 registration | `app.get("/api/filesystem/list", …)` on `app` | Routes register on `apiRouter` inside a `function …Endpoints(app)` module | Export `filesystemEndpoints`; register paths as `/filesystem/list` & `/filesystem/read`; add `filesystemEndpoints(apiRouter);` in `server/index.js` |
| Step 3.1 fetch | `fetch(\`/api/filesystem/list?path=...\`)` | Frontend uses `API_BASE` + `baseHeaders()` | `fetch(\`${API_BASE}/filesystem/list?path=...\`, { headers: baseHeaders() })` |
| Step 3.5 styles | "CSS file or Tailwind — decide in Step 0.6" | Tailwind confirmed; `@phosphor-icons/react` available | Drop `FileExplorer.css`; utility classes inline; icons from `@phosphor-icons/react` |
| Step 3.6 route | `App.jsx` route + sidebar entry | Routes in `main.jsx`; nav convention is `GeneralSettings` area | Register `/settings/files` in `main.jsx` with `PrivateRoute`; add nav row in `GeneralSettings` menu |
| Step 2 roles | `flexUserRoleValid([ROLES.all])` | Confirmed — `ROLES.all` is canonical "any role" token | — |
| T10 (401 test) | "Tested via middleware, not handler" | `validatedRequest` sets `response.locals.user` in MUM and passes through in single-user; `userFromSession` reads `response.locals.user` first | Unit tests can call the handler directly with a mocked `response = { locals: { user: { id: 42 } } }` and verify 401 paths separately via `validatedRequest` middleware |

**Unresolved / accepted defaults:**
- **OQ5 (dotfiles):** keep default — `readdir` with no filter, dotfiles visible (they're the user's files). No `?includeHidden=true` flag.

---

## Step 1 — Findings (completed)

**Deliverable:** `server/endpoints/filesystem.js` (CJS, ~380 lines).

### What was built

| Plan item | Status | Notes |
|-----------|--------|-------|
| 1.1 `MIME_MAP` + `mimeFor()` | ✅ | Copied from plan. Exported for tests. |
| 1.2 `resolveFsForUser` | ✅ → `resolveFsForRequest(request, response)` | **Refactored:** takes `(request, response)` and calls `userFromSession` internally, so handlers don't call it separately (matches `credits.js`). |
| 1.3 error→status mapping | ✅ → `classifyValidationError(error)` | **Refactored:** takes the caught error, returns `{ status, message }` (403 / 404 / 500) — used in both handlers' `try/catch`. |
| 1.4 `GET /filesystem/list` | ✅ | Dirs-first, case-insensitive alpha sort. Each entry: `{ name, type, size, sizeFormatted, modified, mime }`. Parallel per-entry `fs.stat`; broken symlinks still listed (size/mtime omitted). |
| 1.5 `GET /filesystem/read` | ✅ | JSON + raw modes. 1 MiB truncation via `fs.open`+`fh.read` (range read). Binary → `content:null` + `downloadUrl`. `Cache-Control: no-store` on raw only. `Content-Disposition` filename quote-escaped. |
| 1.6 Export | ✅ → `{ filesystemEndpoints, handleList, handleRead, mimeFor, isTextMime, MAX_TEXT_BYTES }` | **Extended** to export `filesystemEndpoints` (Step 2) + helpers (Step 4). |

### Extras (not in original plan, all additive)

- `isTextMime(mime)` — single source of truth for text-vs-binary (replaces inline check in §1.5.8).
- `MAX_TEXT_BYTES` exported so tests can assert the exact cap.
- Explicit null-byte fast-fail (400) in both handlers, before `validatePath`.

### Smoke test — 43 / 43 passed

Ran a 15-case script against a real `os.tmpdir()` sandbox (root `package.json` is ESM, so it's a `.cjs` run):

- **list:** root (3 entries, dirs first, size/mtime/mime), subdir, `../../etc`→403, `/etc`→403, null-byte→400, missing→404, on-file→404 ✅
- **read:** text JSON (content/mime/truncated=false), 1.28 MB text→truncated=true at exactly 1 MiB, PNG JSON→`content:null`+`downloadUrl`, PNG raw→correct headers + 10 bytes streamed, missing→404, no-path→400, on-dir→400, `../../etc/passwd`→403 ✅

### Deviations from plan (all improvements, no scope change)

1. `resolveFsForRequest(request, response)` instead of `resolveFsForUser(user)` — pulls the user internally; cleaner handlers.
2. `classifyValidationError(error)` returns `{status,message}` instead of throwing a typed error.
3. `isTextMime` + `MAX_TEXT_BYTES` exported for isolated testing.
4. `handleList` stats each entry in parallel and tolerates broken symlinks.
5. `Content-Disposition` filename escaped against header injection.
6. Null-byte fast-fail before `validatePath` for a clearer 400 message.

### Files changed

| File | Change |
|------|--------|
| `server/endpoints/filesystem.js` | **new** (Step 1 deliverable) |
| `totem_docs/file-explorer/implementation-plan.md` | Step 1 marked ✅ DONE + this findings section |

### Ready for Step 2

`server/index.js` needs:
```js
const { filesystemEndpoints } = require("./endpoints/filesystem");
// alongside the other endpoint registrations:
filesystemEndpoints(apiRouter);
```
