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

import { spawnSync, spawn } from "child_process";
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
console.log("\n[4/5] Running totem-llm setup…");
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
  console.error(`\nSmoke test FAILED at setup (exit ${setupResult.status})`);
  console.error(`  Inspect the install at: ${testPrefix}`);
  process.exit(1);
}

// 5. Spawn `totem-llm start` and verify no MODULE_NOT_FOUND errors surface.
//    require() is synchronous, so any missing file crashes within the first
//    second — long before the server binds to a port or does real work.
console.log("\n[5/5] Verifying totem-llm start (module resolution check)…");
await new Promise((resolveCheck, rejectCheck) => {
  const startProc = spawn(totemBin, ["start"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TOTEM_STORAGE_DIR: storageDir },
    shell: isWin,
  });

  let output = "";
  let settled = false;

  function finish(ok, msg) {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    try { startProc.kill("SIGTERM"); } catch {}
    if (ok) resolveCheck();
    else rejectCheck(new Error(msg));
  }

  // Give the process 20 s; if it's still alive with no module errors, modules are fine.
  const watchdog = setTimeout(() => finish(true), 20_000);

  function checkChunk(chunk) {
    output += chunk.toString();
    if (/Cannot find module|MODULE_NOT_FOUND/.test(output)) {
      const snippet = output.split("\n").filter(l => /Cannot find module|MODULE_NOT_FOUND|Require stack/.test(l)).join("\n");
      finish(false, `Module resolution failed:\n${snippet}`);
    }
    // Server + collector both up → pass early
    if (/listening on port|Document processor app listening/.test(output)) {
      finish(true);
    }
  }

  startProc.stdout.on("data", checkChunk);
  startProc.stderr.on("data", checkChunk);

  startProc.on("exit", (code) => {
    if (!settled) {
      if (code !== 0) {
        const tail = output.split("\n").slice(-15).join("\n");
        finish(false, `totem-llm start exited unexpectedly (code ${code}):\n${tail}`);
      } else {
        finish(true);
      }
    }
  });
}).catch((err) => {
  console.error(`\nSmoke test FAILED at start check:\n  ${err.message}`);
  try { rmSync(testPrefix, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

// Cleanup prefix on success
try { rmSync(testPrefix, { recursive: true, force: true }); } catch {}

console.log("\n─────────────────────────────────────────");
console.log("  Smoke test PASSED. Safe to publish.\n");
