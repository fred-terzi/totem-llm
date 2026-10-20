import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const StorageFiles = {
  /**
   * Download a file from the server
   * @param {string} storageFilename - The storage filename to download
   * @param {boolean} sandboxFile - When true, `storageFilename` is a
   * sandbox-relative path (e.g. `images/20261020-...png` inside the per-user
   * agent filesystem) and is fetched through the session-authenticated
   * `/filesystem/read?raw=true` endpoint instead of `generated-files`.
   * @returns {Promise<Blob|null>}
   */
  download: async function (storageFilename, sandboxFile = false) {
    const url = sandboxFile
      ? `${API_BASE}/filesystem/read?path=${encodeURIComponent(
          storageFilename
        )}&raw=true`
      : `${API_BASE}/agent-skills/generated-files/${encodeURIComponent(storageFilename)}`;
    return await fetch(url, { headers: baseHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to download file");
        return res.blob();
      })
      .catch((e) => {
        console.error("Download failed:", e);
        return null;
      });
  },
};

export default StorageFiles;
