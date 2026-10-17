#!/usr/bin/env node
/**
 * migrate-fs-to-users.mjs
 *
 * One-time migration: copy legacy top-level files/dirs from
 * $STORAGE_DIR/totemllm-fs/ into $STORAGE_DIR/totemllm-fs/users/<userId>/.
 *
 * After the per-user filesystem rollout (Steps 0-4), every agent session
 * scoped to a user writes into `users/<userId>/`.  Files created before
 * that change still sit directly under `totemllm-fs/` and are only visible
 * to the shared (single-user) filesystem.  This script copies them into
 * the admin's per-user directory so the admin can see their old work.
 *
 * Safety guarantees:
 *   - COPY, never move.  Originals are left in place.
 *   - Idempotent.  Running it twice is a no-op (skips entries already present
 *     at the destination).
 *   - Skips `users/`, `sessions/`, and any `.git*` entry.
 *   - Recursive: directory trees are copied fully.
 *
 * Usage:
 *   node scripts/migrate-fs-to-users.mjs [--userId 1] [--storage-dir /path]
 *   yarn fs:migrate
 *
 * Flags:
 *   --userId N        Prisma user ID for the destination (default: 1, i.e. admin)
 *   --storage-dir P   Override $STORAGE_DIR (default: env or repo-relative fallback)
 *   --dry-run         Log what would be copied without touching disk
 *
 * Exit codes: 0 = success (or nothing to do), 1 = error
 */

import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const packageRoot = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI parsing (minimal, no deps)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function getFlag(name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}
const isDryRun = args.includes("--dry-run");

const userId = getFlag("userId", "1");
const storageDir = getFlag(
  "storage-dir",
  process.env.STORAGE_DIR || join(os.homedir(), "totem-llm"),
);

// Validate userId is a positive integer
if (!/^\d+$/.test(userId) || Number(userId) < 1) {
  console.error(`Error: --userId must be a positive integer, got "${userId}"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const fsRoot = join(storageDir, "totemllm-fs");
const usersDir = join(fsRoot, "users");
const destDir = join(usersDir, userId);

// Entries to skip at the top level of totemllm-fs/
const SKIP_PATTERNS = [
  /^users$/,
  /^sessions$/,
  /^\.git/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isSkipped(name) {
  return SKIP_PATTERNS.some((re) => re.test(name));
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("\nTotem LLM – per-user filesystem migration");
  console.log("────────────────────────────────────────────");
  console.log(`  Storage root : ${fsRoot}`);
  console.log(`  Destination  : ${destDir}`);
  console.log(`  Dry run      : ${isDryRun ? "yes" : "no"}`);
  console.log("");

  // Source root must exist
  if (!existsSync(fsRoot)) {
    console.log(`  Nothing to do – ${fsRoot} does not exist.`);
    console.log("  (This is normal on a fresh install.)\n");
    return;
  }

  // Ensure destination exists
  if (!isDryRun) {
    await mkdir(destDir, { recursive: true });
  }

  const entries = await readdir(fsRoot, { withFileTypes: true });

  let copied = 0;
  let skipped = 0;
  let skippedDest = 0;

  for (const entry of entries) {
    if (isSkipped(entry.name)) {
      continue;
    }

    const srcPath = join(fsRoot, entry.name);
    const destPath = join(destDir, entry.name);

    // Idempotency: if the destination already has this entry, skip it.
    if (await pathExists(destPath)) {
      skippedDest++;
      continue;
    }

    if (isDryRun) {
      console.log(`  [dry-run] would copy  ${entry.name}${entry.isDirectory() ? "/" : ""}`);
      copied++;
      continue;
    }

    // Copy (recursive for directories)
    const opts = { recursive: true, preserveMode: true, preserveTimestamps: true };
    await cp(srcPath, destPath, opts);
    console.log(`  copied  ${entry.name}${entry.isDirectory() ? "/" : ""}`);
    copied++;
  }

  // Summary
  console.log("");
  console.log("────────────────────────────────────────────");
  if (copied === 0 && skippedDest === 0) {
    console.log("  Nothing to migrate. All top-level entries are already in place.");
  } else {
    console.log(`  Copied:  ${copied} item(s)`);
    if (skippedDest > 0) {
      console.log(`  Skipped (already in destination): ${skippedDest} item(s)`);
    }
    if (!isDryRun) {
      console.log("");
      console.log("  Note: originals were left in place (copy, not move).");
      console.log("        Review the destination and remove duplicates manually");
      console.log("        when you are confident the migration is complete.");
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\nMigration failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
