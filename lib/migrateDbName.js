import { existsSync, renameSync, copyFileSync, unlinkSync } from "fs";
import { join } from "path";

/**
 * New default SQLite database filename (Totem LLM).
 */
export const DB_FILENAME = "totem-llm.db";

/**
 * Legacy filename used by AnythingLLM before the Totem rebrand.
 */
const LEGACY_DB_FILENAME = "anythingllm.db";

/**
 * Migrate a pre-existing `anythingllm.db` in the storage directory to the new
 * default name `totem-llm.db`.
 *
 * Decision: rename + copy on startup (not keep-the-old-name). Renaming keeps
 * the data file co-located with the rest of Totem's storage layout and makes
 * backups/backends unambiguous. The migration is idempotent — it does nothing
 * when there is no legacy file or when the new file already exists.
 *
 * Behavior:
 *  - No legacy file            → no-op.
 *  - Legacy + no new           → rename (atomic on same filesystem).
 *    Falls back to copy+delete if rename fails across device boundaries.
 *  - Both exist                → keep the existing `totem-llm.db` untouched and
 *    leave a timestamped backup of the legacy file (`anythingllm.db.bak-<ts>`)
 *    so no data is destroyed silently. Logs a warning asking the user to merge.
 *
 * @param {string} storageDir  Absolute path to the storage directory.
 */
export function migrateDatabaseFilename(storageDir) {
  const legacyPath = join(storageDir, LEGACY_DB_FILENAME);
  const newPath = join(storageDir, DB_FILENAME);

  if (!existsSync(legacyPath)) return; // nothing to do

  if (existsSync(newPath)) {
    // Both files present: refuse to overwrite the current database. Preserve
    // the legacy file as a backup and surface it to the user in the log.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(storageDir, `${LEGACY_DB_FILENAME}.bak-${stamp}`);
    try {
      copyFileSync(legacyPath, backupPath);
      unlinkSync(legacyPath);
      console.warn(`  [db-migrate] WARNING: both ${DB_FILENAME} and ${LEGACY_DB_FILENAME} exist.`);
      console.warn(`              The existing ${DB_FILENAME} was kept. The legacy file`);
      console.warn(`              was saved as a backup at: ${backupPath}`);
    } catch (err) {
      console.warn(
        `  [db-migrate] WARNING: could not migrate/backup ${LEGACY_DB_FILENAME}: ${err.message}. Both files were left in place.`
      );
    }
    return;
  }

  try {
    renameSync(legacyPath, newPath);
    console.log(`  [db-migrate] Renamed legacy database: ${LEGACY_DB_FILENAME} → ${DB_FILENAME}`);
  } catch (renameErr) {
    // Cross-device rename is not possible on some filesystems; fall back to copy.
    try {
      copyFileSync(legacyPath, newPath);
      unlinkSync(legacyPath);
      console.log(`  [db-migrate] Migrated legacy database: ${LEGACY_DB_FILENAME} → ${DB_FILENAME}`);
    } catch (copyErr) {
      // Non-fatal: the app will simply start with an empty new DB. Surface it loudly.
      console.error(
        `  [db-migrate] ERROR: failed to migrate legacy database file: ${copyErr.message}.`
      );
    }
  }
}
