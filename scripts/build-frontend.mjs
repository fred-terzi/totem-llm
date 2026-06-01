#!/usr/bin/env node
/**
 * build-frontend.mjs
 *
 * Runs as part of `prepublishOnly` to:
 *   1. Install frontend dependencies (yarn)
 *   2. Build the Vite app (yarn build)
 *   3. Copy the dist/ output into server/public/ (served by Express in production)
 *
 * This script is intended for package maintainers only and should never run on
 * end-user machines.
 */

import { spawnSync } from "child_process";
import { cpSync, existsSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

const frontendDir = join(packageRoot, "frontend");
const distDir = join(frontendDir, "dist");
const publicDir = join(packageRoot, "server", "public");

const isWin = process.platform === "win32";
/** Resolve the correct executable name on Windows (.cmd wrapper required). */
function bin(name) {
  return isWin ? `${name}.cmd` : name;
}

function run(cmd, args, cwd) {
  const result = spawnSync(bin(cmd), args, { cwd, stdio: "inherit", shell: false });
  if (result.status !== 0) {
    process.stderr.write(
      `"${cmd} ${args.join(" ")}" failed with exit code ${result.status}\n`
    );
    process.exit(result.status ?? 1);
  }
}

console.log("\nBuilding frontend for npm release…");

// 1. Install frontend dependencies
console.log("  [frontend] yarn install");
run("yarn", ["install", "--frozen-lockfile"], frontendDir);

// 2. Build the Vite app
console.log("  [frontend] yarn build");
run("yarn", ["build"], frontendDir);

if (!existsSync(distDir)) {
  process.stderr.write(
    `Build succeeded but dist/ was not created at ${distDir}\n`
  );
  process.exit(1);
}

// 3. Copy dist/ → server/public/
console.log(`  Copying dist/ → server/public/`);
if (existsSync(publicDir)) {
  rmSync(publicDir, { recursive: true, force: true });
}
cpSync(distDir, publicDir, { recursive: true });

console.log("  Frontend build complete.\n");
