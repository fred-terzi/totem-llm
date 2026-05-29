#!/usr/bin/env node
/**
 * postinstall.mjs
 *
 * Runs after `npm install -g totem-llm`.
 * Installs production dependencies for the server and collector sub-packages,
 * then generates the Prisma client for the current platform.
 *
 * All errors are caught and treated as non-fatal so that a transient network
 * issue doesn't leave the overall install in a broken state.  Users can re-run
 * this script manually via `node node_modules/totem-llm/scripts/postinstall.mjs`.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

const isWin = process.platform === "win32";

/** Wrap a command name so it resolves correctly on Windows (.cmd suffix). */
function bin(name) {
  return isWin ? `${name}.cmd` : name;
}

/** Run a command, streaming output, resolving on exit-0, rejecting otherwise. */
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin(cmd), args, { cwd, stdio: "inherit", shell: isWin });
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`"${cmd} ${args.join(" ")}" failed (exit ${code})`))
    );
    child.on("error", (err) =>
      reject(new Error(`Could not run "${cmd}": ${err.message}`))
    );
  });
}

async function installDeps(label, dir) {
  if (existsSync(join(dir, "node_modules"))) {
    console.log(`  [${label}] dependencies already installed — skipping`);
    return;
  }
  console.log(`  [${label}] installing production dependencies…`);
  // Prefer npm (always available in npm-installed contexts) over yarn
  await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], dir);
}

async function main() {
  // Skip in CI environments where dependency management is handled externally
  if (process.env.CI) return;

  // Skip if running inside the development workspace (i.e. a developer has
  // cloned the repo and run `yarn install` at the root). We detect this by
  // checking whether the root package.json name matches AND we are NOT being
  // installed as a dependency of something else.
  const isLocalDev =
    process.env.npm_config_local_prefix &&
    process.env.npm_config_local_prefix === process.env.INIT_CWD;
  if (isLocalDev) return;

  console.log("\nTotem LLM – post-install setup");
  console.log("─────────────────────────────────────────");

  const serverDir = join(packageRoot, "server");
  const collectorDir = join(packageRoot, "collector");

  try {
    await installDeps("server", serverDir);
  } catch (err) {
    console.warn(`  [server] dependency install failed: ${err.message}`);
    console.warn("  Run: npm install --omit=dev inside the server/ directory manually.");
  }

  try {
    // Only regenerate if the client doesn't exist yet (avoid re-running on
    // every install in already-configured environments)
    const prismaClientExists = existsSync(
      join(serverDir, "node_modules", ".prisma", "client", "index.js")
    );
    if (!prismaClientExists) {
      console.log("  [server] generating Prisma client…");
      // Use the locally-installed Prisma binary to avoid picking up a globally-
      // installed incompatible Prisma CLI version.
      const prismaBin = join(serverDir, "node_modules", ".bin", "prisma");
      await run(
        prismaBin,
        ["generate", "--schema", join(serverDir, "prisma", "schema.prisma")],
        serverDir
      );
    } else {
      console.log("  [server] Prisma client already generated — skipping");
    }
  } catch (err) {
    console.warn(`  [server] Prisma generate failed: ${err.message}`);
    console.warn("  Run: npx prisma generate inside the server/ directory manually.");
  }

  try {
    await installDeps("collector", collectorDir);
  } catch (err) {
    console.warn(`  [collector] dependency install failed: ${err.message}`);
    console.warn("  Run: npm install --omit=dev inside the collector/ directory manually.");
  }

  console.log("─────────────────────────────────────────");
  console.log('  Done. Run "totem-llm" to start.\n');
}

main().catch((err) => {
  // Non-fatal — print a warning but let the npm install succeed
  console.warn("Post-install script encountered an error:", err.message);
  console.warn('Run "totem-llm setup" after installation to complete setup.');
});
