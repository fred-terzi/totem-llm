#!/usr/bin/env node
/**
 * test-install.mjs
 *
 * Pre-publish smoke test. Packs the package into a tarball, installs it into
 * an isolated npm prefix under /tmp, and runs `totem-llm setup` against it.
 * This catches issues (wrong Prisma version, missing files, Windows .cmd
 * issues, etc.) before they reach published users.
 *
 * Usage:
 *   yarn test:install
 *   npm run test:install
 *
 * Requires the frontend to already be built (run `node scripts/build-frontend.mjs`
 * first, or use `--build` flag).
 *
 * The test prefix is cleaned up automatically on success; on failure it is
 * left in place at /tmp/totem-test-<timestamp> for inspection.
 */

import { spawnSync } from "child_process";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const packageRoot = resolve(__dirname, "..");
const isWin = process.platform === "win32";

function bin(name) {
  return isWin ? `${name}.cmd` : name;
}

function run(cmd, args, { cwd = packageRoot, failOk = false } = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(bin(cmd), args, { cwd, stdio: "inherit", shell: isWin });
  if (!failOk && result.status !== 0) {
    console.error(`\nFailed: ${cmd} ${args.join(" ")} (exit ${result.status})`);
    process.exit(1);
  }
  return result;
}

const buildFirst = process.argv.includes("--build");
const timestamp = Date.now();
const testPrefix = join("/tmp", `totem-test-${timestamp}`);
const storageDir = join(testPrefix, "storage");

console.log("\nTotem LLM – pre-publish install smoke test");
console.log("─────────────────────────────────────────");

// 1. Optionally build the frontend
if (buildFirst) {
  console.log("\n[1/4] Building frontend…");
  run("node", ["scripts/build-frontend.mjs"]);
} else {
  console.log("\n[1/4] Skipping frontend build (pass --build to include it)");
  if (!existsSync(join(packageRoot, "server", "public", "_index.html"))) {
    console.error("  ERROR: server/public/_index.html not found.");
    console.error("  Run with --build or run `node scripts/build-frontend.mjs` first.");
    process.exit(1);
  }
}

// 2. Pack the tarball (respects .npmignore)
console.log("\n[2/4] Packing tarball…");
const packResult = spawnSync(bin("npm"), ["pack", "--json"], {
  cwd: packageRoot,
  shell: isWin,
});
if (packResult.status !== 0) {
  console.error("  npm pack failed");
  process.exit(1);
}
let tarball;
try {
  const packOutput = JSON.parse(packResult.stdout.toString());
  tarball = resolve(packageRoot, packOutput[0].filename);
} catch {
  console.error("  Could not parse npm pack output");
  process.exit(1);
}
console.log(`  Packed: ${tarball}`);

// 3. Install into isolated prefix
console.log(`\n[3/4] Installing into ${testPrefix}…`);
mkdirSync(testPrefix, { recursive: true });
mkdirSync(storageDir, { recursive: true });
run("npm", ["install", "-g", "--prefix", testPrefix, tarball]);

// 4. Run setup
console.log("\n[4/4] Running totem-llm setup…");
const totemBin = isWin
  ? join(testPrefix, "bin", "totem-llm.cmd")
  : join(testPrefix, "bin", "totem-llm");

const setupResult = spawnSync(totemBin, ["setup"], {
  stdio: "inherit",
  shell: isWin,
  env: { ...process.env, TOTEM_STORAGE_DIR: storageDir },
});

// Cleanup tarball
try { rmSync(tarball); } catch {}

if (setupResult.status !== 0) {
  console.error(`\nSmoke test FAILED (exit ${setupResult.status})`);
  console.error(`  Inspect the install at: ${testPrefix}`);
  process.exit(1);
}

// Cleanup prefix on success
try { rmSync(testPrefix, { recursive: true, force: true }); } catch {}

console.log("\n─────────────────────────────────────────");
console.log("  Smoke test PASSED. Safe to publish.\n");
