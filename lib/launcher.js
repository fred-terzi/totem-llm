import { spawn } from "child_process";
import { join } from "path";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { getEnv, getStorageDir } from "./config.js";
import { getPackageVersion } from "./version.js";
import {
  startupBanner,
  header,
  statusLine,
  section,
  highlightBox,
  urlStyle,
  success,
  info,
  warning,
  error,
  divider,
} from "./formatter.js";
import os from "os"; 
import qrcode from "qrcode-terminal"


/**
 * Create a simple progress bar for terminal output.
 * @param {number} percent Progress percentage (0-100)
 * @param {number} width Bar width in characters (default 30)
 * @returns {string} Formatted progress bar
 */
function createProgressBar(percent, width = 30) {
  const filled = Math.round((width * percent) / 100);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${percent}%`;
}

/**
 * Spawn a Node.js service and prefix every log line with a fixed-width label.
 * Also writes all logs to a session log file.
 *
 * @param {string}   nodeExe     Absolute path to the Node binary (process.execPath)
 * @param {string}   cwd         Working directory for the child process
 * @param {object}   env         Environment variables to pass to the child
 * @param {string}   label       Log prefix, e.g. "[server]   "
 * @param {string}   logFile     Path to the session log file
 * @returns {{ process: import('child_process').ChildProcess }}
 */
function spawnService(nodeExe, cwd, env, label, logFile) {
  const child = spawn(nodeExe, ["index.js"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pad = label.padEnd(13);
  let buf = "";

  function flush(chunk) {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop(); // keep any incomplete trailing line
    for (const line of lines) {
      if (line.trim()) {
        appendFileSync(logFile, `${pad} ${line}\n`);
      }
    }
  }

  child.stdout.on("data", (c) => flush(c));
  child.stderr.on("data", (c) => flush(c));

  return child;
}

/**
 * Get the local network IPv4 address.
 * @returns {string|null} Local IP address or null if not found
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
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
  
  // Ensure SERVER_PORT is always set - defensive against dotenv loading issues
  if (!env.SERVER_PORT) {
    env.SERVER_PORT = "8686";
  }
  if (!env.COLLECTOR_PORT) {
    env.COLLECTOR_PORT = "8888";
  }

  let appVersion = "unknown";
  try {
    appVersion = getPackageVersion(packageRoot) ?? "unknown";
  } catch {}

  const serverPort = env.SERVER_PORT ?? "8686";
  const collectorPort = env.COLLECTOR_PORT ?? "8888";
  const nodeExe = process.execPath; // cross-platform: always the right Node binary

  const serverDir = join(packageRoot, "server");
  const collectorDir = join(packageRoot, "collector");

  // Initialize session log file - clear on each startup
  // Logs go into the user's storage directory (~/totem-llm/logs) not the npm package
  const logsDir = join(getStorageDir(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const sessionLogFile = join(logsDir, "totem-session.log");
  writeFileSync(
    sessionLogFile,
    `${"=".repeat(80)}\nSession started: ${new Date().toISOString()}\n${"=".repeat(80)}\n`
  );

  // Display startup banner with professional formatting
  process.stdout.write("\n");
  process.stdout.write(startupBanner(appVersion, "production"));

  // Display loading progress
  process.stdout.write(section("Starting Services", []));
  let progressPercent = 0;
  const progressInterval = setInterval(() => {
    if (progressPercent < 80) {
      progressPercent += Math.random() * 25;
      if (progressPercent > 80) progressPercent = 80;
      process.stdout.write(
        `\r${info("Loading")} ${createProgressBar(Math.floor(progressPercent))}`
      );
    }
  }, 300);

    // Display UI access information
    process.stdout.write(
      highlightBox(
        `Open UI in browser:\n${urlStyle(`http://localhost:${serverPort}/`)}`,
        "brightGreen"
      )
    );

    // Get local network details
    const localIP = getLocalIP();
    const networkUrl = localIP ? `http://${localIP}:${serverPort}/` : null;
    const localUrlLine = networkUrl ? `\nNetwork:  ${urlStyle(networkUrl)}` : "";

    // Generate QR code for mobile devices if network URL is available
    let qrCodeBox = "";
    if (networkUrl) {
      qrcode.generate(networkUrl, { small: true }, (qrcodeStr) => {
        // Add a small header and spacing around the generated QR code string
        qrCodeBox = `\n\n${info("Scan to open on mobile:")}\n${qrcodeStr}`;
      });
    }

  // Display UI access information
  process.stdout.write(
    highlightBox(
      `Open UI in browser:\nLocal:    ${urlStyle(`http://localhost:${serverPort}/`)}${localUrlLine}${qrCodeBox}`,
      "brightGreen"
    )
  );



  // Display logs information
  process.stdout.write(
    section("Configuration", [
      `Logs: ${urlStyle(sessionLogFile)}`,
      `Storage: ${urlStyle(getStorageDir())}`,
    ])
  );

  // Display help information
  process.stdout.write(
    section("Keyboard Shortcuts", [
      `${info("Ctrl+C")} Stop all services`,
      `${info("Check logs")} for errors and service status`,
    ])
  );

  process.stdout.write(divider());

  const serverProc = spawnService(nodeExe, serverDir, env, "[server]", sessionLogFile);

  let collectorProc = null;
  if (!noCollector) {
    collectorProc = spawnService(nodeExe, collectorDir, env, "[collector]", sessionLogFile);
  }

  // Complete the progress bar
  progressPercent = 100;
  process.stdout.write(
    `\r${success("Ready")}   ${createProgressBar(100)}\n\n`
  );
  clearInterval(progressInterval);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    const shutdownMsg = warning(`\nShutting down (${signal})…`);
    process.stdout.write(`${shutdownMsg}\n`);
    appendFileSync(sessionLogFile, `Shutting down (${signal})…\n`);
    
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
      const errMsg = error(`Server exited unexpectedly with code ${code}`);
      process.stderr.write(`${errMsg}\n`);
      appendFileSync(sessionLogFile, `Server exited unexpectedly with code ${code}\n`);
      shutdown("server-exit");
      setTimeout(() => process.exit(1), 500);
    }
  });

  if (collectorProc) {
    collectorProc.on("close", (code) => {
      if (!shuttingDown && code !== null && code !== 0) {
        const errMsg = warning(`Collector exited with code ${code} — document ingestion unavailable`);
        process.stderr.write(`${errMsg}\n`);
        appendFileSync(sessionLogFile, `Collector exited with code ${code} — document ingestion unavailable\n`);
      }
    });
  }

  // Keep the main process alive indefinitely
  await new Promise(() => {});
}
