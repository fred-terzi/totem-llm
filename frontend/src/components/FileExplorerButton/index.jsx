import { Link, useMatch, useNavigate } from "react-router-dom";
import { Files, ArrowUUpLeft } from "@phosphor-icons/react";
import i18next from "@/i18n";
import paths from "@/utils/paths";

const t = i18next.t.bind(i18next);

/**
 * Top-bar Files button — visible to ALL authenticated roles.
 *
 * Navigates to /settings/files (File Explorer). When already on that page,
 * acts as a "back" button that returns the user to the page they came from
 * (e.g. the workspace/thread they were chatting in) via the browser history.
 * Falls back to the home page only if there is no previous entry (e.g. the
 * user landed directly on /settings/files via a bookmark).
 */
export default function FileExplorerButton() {
  const onFilesPage = !!useMatch("/settings/files");
  const navigate = useNavigate();

  const handleBack = () => {
    // `window.history.length` counts the current page too, so > 1 means a
    // previous entry exists that we can return to.
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(paths.home());
    }
  };

  if (onFilesPage) {
    const tooltip = t("file-explorer.back-home", "Back");

    return (
      <button
        type="button"
        onClick={handleBack}
        data-tooltip-id="footer-item"
        data-tooltip-content={tooltip}
        className="rounded-full bg-transparent text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 w-9 h-9 flex items-center justify-center transition-colors"
        aria-label={tooltip}
      >
        <ArrowUUpLeft size={22} weight="bold" />
      </button>
    );
  }

  return (
    <Link
      to={paths.settings.files()}
      data-tooltip-id="footer-item"
      data-tooltip-content={t("settings.files", "File Explorer")}
      className="rounded-full bg-transparent text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 w-9 h-9 flex items-center justify-center transition-colors"
      aria-label="File Explorer"
    >
      <Files size={22} weight="bold" />
    </Link>
  );
}
