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
  // --no-global: overrides npm_config_global=true inherited from the outer `npm install -g`
  //   so packages install into dir/node_modules instead of the global prefix.
  // --prefix dir: explicit local install target (belt-and-suspenders with --no-global).
  // --legacy-peer-deps: the project has known peer-dep conflicts (e.g. apache-arrow,
  //   prettier version ranges) that are fine at runtime but fail strict npm v7+ resolution.
  await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--legacy-peer-deps", "--no-global", "--prefix", dir], dir);
}

async function main() {
  // Skip in CI environments where dependency management is handled externally
  if (process.env.CI) return;

  // Skip if running inside the development workspace (i.e. a developer has
  // cloned the repo and run `yarn install` at the root). We detect this by
  // checking whether the root package.json name matches AND we are NOT being
  // installed as a dependency of something else.
  // NOTE: npm_config_global is "true" for `npm install -g` (even with --prefix),
  // so we must NOT skip when it is set — otherwise the postinstall is a no-op
  // when the tarball is installed from within the project directory.
  const isLocalDev =
    !process.env.npm_config_global &&
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
