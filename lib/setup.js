import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { getStorageDir, getEnvPath, getEnv } from "./config.js";

/** Subdirectories that must exist inside the storage directory. */
const STORAGE_SUBDIRS = [
  "documents",
  "vector-cache",
  "models",
  "direct-uploads",
  "generated-files",
  "comkey",
  "tmp",
];

function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

function buildEnvFile(storageDir) {
  return [
    "# Totem LLM configuration",
    `# Generated ${new Date().toISOString()}`,
    "# Edit this file to configure your instance, then restart.",
    "",
    `STORAGE_DIR="${storageDir}"`,
    "SERVER_PORT=3001",
    "COLLECTOR_PORT=8888",
    "",
    "# Security secrets (auto-generated — do not share these)",
    `JWT_SECRET="${generateSecret(24)}"`,
    `SIG_KEY="${generateSecret(32)}"`,
    `SIG_SALT="${generateSecret(32)}"`,
    "",
    "# LLM provider — configure via the UI after first launch, or set here.",
    "# Example (Ollama running locally):",
    "# LLM_PROVIDER=ollama",
    "# OLLAMA_BASE_PATH=http://127.0.0.1:11434",
    "",
    "# Vector database (lancedb = zero-setup file-based default)",
    "VECTOR_DB=lancedb",
    "",
    "# Embedding engine (native = built-in, no external service needed)",
    "EMBEDDING_ENGINE=native",
    "",
  ].join("\n");
}

/**
 * Run a command and stream its output to the parent's stdio.
 * Rejects with a descriptive error if the process exits non-zero.
 */
function runCommand(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    // On Windows, executables like "npx" need the .cmd wrapper
    const isWin = process.platform === "win32";
    const bin = isWin && !cmd.endsWith(".cmd") ? `${cmd}.cmd` : cmd;

    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: "inherit",
      shell: false,
    });

    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(`"${cmd} ${args.join(" ")}" exited with code ${code}`)
      );
    });
    child.on("error", (err) => {
      reject(new Error(`Failed to run "${cmd}": ${err.message}`));
    });
  });
}

/**
 * Ensure the storage directory and all required subdirectories exist.
 */
function ensureStorageDirs(storageDir) {
  if (!existsSync(storageDir)) {
    console.log(`  Creating storage directory: ${storageDir}`);
    mkdirSync(storageDir, { recursive: true });
  }
  for (const sub of STORAGE_SUBDIRS) {
    const dir = join(storageDir, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/**
 * Run Prisma database migrations against the storage-dir SQLite file.
 * Safe to call on every startup — only applies pending migrations.
 */
async function runMigrations(serverDir, env) {
  await runCommand("npx", ["prisma", "migrate", "deploy", "--schema", join(serverDir, "prisma", "schema.prisma")], {
    cwd: serverDir,
    env,
  });
}

/**
 * First-run (and subsequent startup) setup:
 *  1. Creates storage directory + subdirectories
 *  2. Generates secrets and writes ~/.totem-llm/.env (skipped if already present)
 *  3. Runs Prisma migrations (idempotent)
 *
 * @param {{ packageRoot: string, force?: boolean }} opts
 *   packageRoot – absolute path to the installed package root
 *   force       – if true, regenerate the .env file even if it already exists
 */
export async function setup({ packageRoot, force = false }) {
  const storageDir = getStorageDir();
  const envPath = getEnvPath();

  console.log("\nTotem LLM – setup");
  console.log("─────────────────────────────────────────");

  // 1. Storage directory
  ensureStorageDirs(storageDir);

  // 2. Configuration file
  if (!existsSync(envPath) || force) {
    console.log("  Generating configuration...");
    writeFileSync(envPath, buildEnvFile(storageDir), "utf8");
    console.log(`  Config saved to: ${envPath}`);
  } else {
    console.log(`  Config found: ${envPath}`);
  }

  // 3. Database migrations
  const serverDir = join(packageRoot, "server");
  const env = getEnv({ storageDir });

  console.log("  Running database migrations...");
  await runMigrations(serverDir, env);
  console.log("  Database ready.");

  console.log("─────────────────────────────────────────\n");
}
