import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

/**
 * Returns the storage directory where user data (database, documents, models, etc.) lives.
 * Controlled by TOTEM_STORAGE_DIR env var; defaults to ~/totem-llm.
 */
export function getStorageDir() {
  return process.env.TOTEM_STORAGE_DIR ?? join(homedir(), "totem-llm");
}

/** Path to the persisted .env file inside the storage directory. */
export function getEnvPath() {
  return join(getStorageDir(), ".env");
}

/** True if the storage directory has already been configured. */
export function isConfigured() {
  return existsSync(getEnvPath());
}

/**
 * Parse a .env file into a plain object.
 * Handles quoted values and ignores comments / blank lines.
 */
function parseEnvFile(contents) {
  const env = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding single or double quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * Build the merged environment object that is passed to the server and collector
 * child processes.  Order of precedence (lowest → highest):
 *   1. Current process.env
 *   2. Values from the storage .env file
 *   3. Computed values (STORAGE_DIR, DATABASE_URL, NODE_ENV)
 *
 * @param {{ storageDir?: string }} [opts]
 * @returns {NodeJS.ProcessEnv}
 */
export function getEnv({ storageDir } = {}) {
  const storage = storageDir ?? getStorageDir();
  const envPath = join(storage, ".env");

  let fileEnv = {};
  if (existsSync(envPath)) {
    try {
      fileEnv = parseEnvFile(readFileSync(envPath, "utf8"));
    } catch {
      // Non-fatal; missing or unreadable env file is handled during setup
    }
  }

  return {
    ...process.env,
    ...fileEnv,
    // Always override these so they point at the correct storage dir
    STORAGE_DIR: storage,
    DATABASE_URL: `file:${join(storage, "anythingllm.db")}`,
    NODE_ENV: "production",
  };
}
