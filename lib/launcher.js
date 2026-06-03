import { spawn } from "child_process";
import { join } from "path";
import { getEnv } from "./config.js";
import { getPackageVersion } from "./version.js";

/**
 * Spawn a Node.js service and prefix every log line with a fixed-width label.
 *
 * @param {string}   nodeExe     Absolute path to the Node binary (process.execPath)
 * @param {string}   cwd         Working directory for the child process
 * @param {object}   env         Environment variables to pass to the child
 * @param {string}   label       Log prefix, e.g. "[server]   "
 * @returns {{ process: import('child_process').ChildProcess }}
 */
function spawnService(nodeExe, cwd, env, label) {
  const child = spawn(nodeExe, ["index.js"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pad = label.padEnd(13);
  let buf = "";

  function flush(stream, chunk) {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop(); // keep any incomplete trailing line
    for (const line of lines) {
      if (line.trim()) stream.write(`${pad} ${line}\n`);
    }
  }

  child.stdout.on("data", (c) => flush(process.stdout, c));
  child.stderr.on("data", (c) => flush(process.stderr, c));

  return child;
}

/**
 * Launch the server (and optionally the collector), wire up graceful shutdown,
 * and keep the process alive until the user presses Ctrl+C.
 *
 * @param {{ packageRoot: string, noCollector?: boolean, port?: string }} opts
 */
export async function launch({ packageRoot, noCollector = false, port } = {}) {
  const env = getEnv();
  if (port) env.SERVER_PORT = port;

  let appVersion = "unknown";
  try {
    appVersion = getPackageVersion(packageRoot) ?? "unknown";
  } catch {}

  const serverPort = env.SERVER_PORT ?? "3001";
  const collectorPort = env.COLLECTOR_PORT ?? "8888";
  const nodeExe = process.execPath; // cross-platform: always the right Node binary

  const serverDir = join(packageRoot, "server");
  const collectorDir = join(packageRoot, "collector");

  console.log("Starting Totem LLM…");
  console.log(`  Version    → ${appVersion}`);
  console.log(`  Server     → http://localhost:${serverPort}`);
  if (!noCollector) {
    console.log(`  Collector  → http://localhost:${collectorPort}`);
  }
  console.log(`  Storage    → ${env.STORAGE_DIR}`);
  console.log("\nPress Ctrl+C to stop.\n");

  const serverProc = spawnService(nodeExe, serverDir, env, "[server]");

  let collectorProc = null;
  if (!noCollector) {
    collectorProc = spawnService(nodeExe, collectorDir, env, "[collector]");
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\nShutting down (${signal})…`);
    serverProc.kill("SIGTERM");
    if (collectorProc) collectorProc.kill("SIGTERM");

    // Force-kill after 8 s if processes are still running
    const forceKill = setTimeout(() => {
      if (!serverProc.killed) serverProc.kill("SIGKILL");
      if (collectorProc && !collectorProc.killed) collectorProc.kill("SIGKILL");
      process.exit(0);
    }, 8000);

    forceKill.unref(); // Don't prevent Node from exiting naturally
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Exit this process when the server exits unexpectedly
  serverProc.on("close", (code) => {
    if (!shuttingDown && code !== null && code !== 0) {
      console.error(`[server] exited unexpectedly with code ${code}`);
      shutdown("server-exit");
      setTimeout(() => process.exit(1), 500);
    }
  });

  if (collectorProc) {
    collectorProc.on("close", (code) => {
      if (!shuttingDown && code !== null && code !== 0) {
        console.error(
          `[collector] exited with code ${code} — document ingestion unavailable`
        );
      }
    });
  }

  // Keep the main process alive indefinitely
  await new Promise(() => {});
}
