# File Explorer — Top Bar Button (Multi-User Default-Role Fix)

## Context

In multi-user mode, `role === "default"` users cannot access the Settings tab.
The Settings sidebar (Wrench icon, `/settings/*` routes) is intentionally hidden
for them (`SettingsButton` returns `null` for `role === "default"`, and the
Sidebar role guard hides the Settings entry). However, the File Explorer (built
in Steps 1–3) lives at `/settings/files` — a path these users can never
navigate to via the sidebar.

**Fix:** Add a `Files` icon button to the top bar (`UserMenu`), visible to
**all** authenticated roles. On the File Explorer page, the same button becomes
a back arrow (`ArrowUUpLeft`) linking to `paths.home()`.

Default-role users do **not** gain access to the Settings tab or Wrench icon.
The top bar button is their only path in and out of the File Explorer.

---

## Design

### Single component, two states

**File:** `frontend/src/components/FileExplorerButton/index.jsx`

> Location rationale: this is a *global topbar* control (a sibling of
> `SettingsButton`), not part of the FileExplorer feature itself — so it lives
> at the top-level `components/` directory, matching repo convention.

| State | Icon | Tooltip | Link target |
|---|---|---|---|
| Not on `/settings/files` | `Files` (Phosphor) | `t("settings.files", "Files")` | `paths.settings.files()` |
| On `/settings/files` | `ArrowUUpLeft` (Phosphor) | `t("file-explorer.back-home", "Back to Workspaces")` | `paths.home()` |

- 35×35 circular button, matching `ChatSettingsMenu` visual style
- Uses `useMatch("/settings/files")` from `react-router-dom` to toggle
- Tooltip via tippy `data-tooltip-id="footer-item"` +
  `data-tooltip-content`, identical to the existing `SettingsButton` pattern
- Rendered inside **`UserMenu`** → appears in the top bar on every
  authenticated page (`PrivateRoute` routes: chat, `/settings/files`;
  `AdminRoute` pages where `UserMenu` is shown)

### Where the button intentionally does NOT appear

| Surface | Behavior | Reason |
|---|---|---|
| Agent builder (`AdminRoute` with `hideUserMenu={true}`) | Hidden | `UserMenu` itself is hidden there — consistent |
| Unauthenticated | Hidden | Behind `PrivateRoute` → login redirect |

### What does NOT change

| File | Status | Reason |
|---|---|---|
| `components/SettingsButton/index.jsx` | **Untouched** | Default users still get `null` (no Wrench, no `/settings/interface`) |
| `components/Sidebar/index.jsx` (role guards) | **Untouched** | `role !== "default"` guard stays on both desktop and mobile |
| `components/SettingsSidebar/index.jsx` | **Untouched** | Tools → Files entry stays (admin/manager path) |
| `src/locales/*/common.js` | **Untouched (optional)** | See i18n note below — component ships with EN fallbacks, locale additions can follow |

### Net effect per role

| Role | Top bar button | Sidebar footer (SettingsButton) |
|---|---|---|
| `admin` / `manager` | `Files` → Explorer / `←` → Home | Wrench → `/settings/interface` / `←` → Home (unchanged) |
| `default` (multi-user) | `Files` → Explorer / `←` → Home | **Hidden** (unchanged) |
| `default` (single-user) | `Files` → Explorer / `←` → Home | **Hidden** (unchanged) |

---

## i18n

The codebase uses `react-i18next` throughout the topbar. The component must
therefore use `t()` with English fallbacks — never raw hardcoded strings:

- `t("settings.files", "Files")` — **key already used** in
  `SettingsSidebar/index.jsx:474` (via fallback), so no new EN locale entry is
  strictly required; it resolves in EN and falls back to English elsewhere.
- `t("file-explorer.back-home", "Back to Workspaces")` — new key, EN fallback.

**Follow-up (optional, non-blocking):** add both keys to
`src/locales/en/common.js` (under `settings` / new `file-explorer` section) and
let the existing `findUnusedTranslations` / `verifyTranslations` tooling keep
locales in sync.

---

## Files to change

| File | Change |
|---|---|
| **NEW** `frontend/src/components/FileExplorerButton/index.jsx` | ~45-line component: `useMatch`, `Link`, Phosphor `Files` / `ArrowUUpLeft`, tippy tooltip, `t()` strings, 35×35 circle |
| `frontend/src/components/UserMenu/index.jsx` | Add `import` + render `<FileExplorerButton />` between `CreditBadge` and `UserButton` |

**Total scope: 1 new file + 2 lines added to `UserMenu`.**

---

## Implementation steps

### Step 1 — Create `FileExplorerButton`

```jsx
// frontend/src/components/FileExplorerButton/index.jsx
import { Link, useMatch } from "react-router-dom";
import { Files, ArrowUUpLeft } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { paths } from "../../utils/paths";

const FileExplorerButton = () => {
  const { t } = useTranslation();
  const isOnExplorer = !!useMatch("/settings/files");

  return (
    <Link
      to={isOnExplorer ? paths.home() : paths.settings.files()}
      data-tooltip-id="footer-item"
      data-tooltip-content={
        isOnExplorer ? t("file-explorer.back-home", "Back to Workspaces") : t("settings.files", "Files")
      }
      aria-label={
        isOnExplorer ? t("file-explorer.back-home", "Back to Workspaces") : t("settings.files", "Files")
      }
      className="flex items-center justify-center w-[35px] h-[35px] rounded-full
                 text-gray-600 dark:text-gray-300 hover:bg-gray-100
                 dark:hover:bg-gray-700 transition-colors"
    >
      {isOnExplorer ? (
        <ArrowUUpLeft size={18} weight="bold" />
      ) : (
        <Files size={18} weight="bold" />
      )}
    </Link>
  );
};

export default FileExplorerButton;
```

### Step 2 — Render in `UserMenu`

In `frontend/src/components/UserMenu/index.jsx`:

```diff
+ import FileExplorerButton from "../FileExplorerButton";
```

```diff
         <CreditBadge />
+        <FileExplorerButton />
         <UserButton />
```

### Step 3 — Lint + build

```bash
npx eslint src/components/FileExplorerButton/index.jsx src/components/UserMenu/index.jsx
npx vite build
```

---

## Verification (manual QA)

| # | Scenario | Expected |
|---|---|---|
| M1 | Multi-user, `default` user, on `/` | Top bar shows `Files` icon. Sidebar: **no** Wrench/Settings button |
| M2 | Click `Files` icon | Navigates to `/settings/files`, File Explorer loads, breadcrumb at `root` |
| M3 | On `/settings/files` | Top bar: `Files` icon replaced by `←` (ArrowUUpLeft). Click → returns to `/` |
| M4 | Mobile 360 px, `default` user | M1–M3 still work; no horizontal scroll; see mobile overflow note |
| M5 | `admin` / `manager` user, on `/` | Top bar: `Files` icon. Sidebar: Wrench visible (unchanged) |
| M6 | `admin` / `manager` on `/settings/files` | Top bar: `←`. Sidebar: `←` (SettingsButton back). Both work |
| M7 | Single-user mode | M1–M4 equivalent (no regression) |
| M8 | Unauthenticated, direct `/settings/files` | Redirect to login (PrivateRoute) |
| M9 | Agent builder route (admin) | `UserMenu` hidden → no `Files` button (expected) |
| M10 | Lint + build | `npx eslint` 0 errors on new/touched files; `npx vite build` succeeds |

### Mobile overflow note (360 px)

`UserMenu` already stacks `ChatSettingsMenu + TotemBalanceBadge + CreditBadge +
UserButton` in an absolute row at `right-4 gap-2`. The new 35 px button is the
**5th** item. The badges are conditionally rendered (only when a balance/credits
value exists), so the worst realistic case is the full 5-item row.

- **Do not** solve overflow by hiding the button on small screens
  (`hidden sm:flex`) — mobile `default` users are the primary beneficiaries of
  this fix and would lose it.
- If M4 overflows at 360 px, mitigations in order of preference:
  1. Tighten existing spacing (`gap-2 → gap-1.5` on the `UserMenu` row).
  2. Reduce badge horizontal padding at xs.
  3. As a last resort, allow the row to wrap (`flex-wrap`).

---

## Follow-up after implementation

- Add `RELEASE.md` bullet: *"Multi-user default-role users can now access File Explorer via the top bar without Settings tab access."*
- Update `totem_docs/file-explorer/requirement-spec.md`: add AC — "Default-role users reach File Explorer via top bar; Settings tab remains hidden."
- Optional: add `settings.files` and `file-explorer.back-home` keys to `src/locales/en/common.js`.
- Commit: `feat(file-explorer): top-bar Files button with back navigation for all roles`

---

## Risk

**Very low.** One new self-contained component + one JSX element in `UserMenu`.
No existing components modified. No server changes. No new dependencies.

The only regression vector is visual: the top bar gains one icon. See the
**Mobile overflow note** above — worst case at 360 px is a 5-item row, with
preferred mitigations defined and an explicit constraint that the button must
stay visible on mobile.
