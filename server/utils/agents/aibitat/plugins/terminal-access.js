const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs/promises");
const os = require("os");

/**
 * Terminal Access — built-in agent skill for executing shell commands.
 *
 * Security model (layered):
 *   1. Availability gate: tool only registers when the terminalAccess
 *      feature flag is enabled for the current TOTEM_BUILD_PROFILE
 *      (or in a Docker container).
 *   2. Admin opt-in: must be present in `default_agent_skills` SystemSettings
 *      to appear for users.
 *   3. Per-command approval: commands matching dangerous patterns trigger
 *      the user-approval websocket flow before execution.
 *   4. Process-level guards: timeout with process-group kill, output
 *      truncation, working-directory confinement (optional).
 */

// ---------------------------------------------------------------------------
// Dangerous command patterns — compiled once at module load.
// Each entry is an independent RegExp; a match on ANY triggers approval.
// ---------------------------------------------------------------------------
const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|\~|\$HOME)/i, // rm -rf / ~ $HOME
  /rm\s+-rf\s+["']?\/(?!tmp\b|var\b|dev\b)/i, // rm -rf on root-ish paths (allow /tmp, /var, /dev for cleanup)
  /\bdd\s+of=\/dev\//i, // dd writing to block devices
  /\bmkfs(\.[a-z]+)?\s/i, // mkfs, mkfs.ext4, etc.
  /:\(\)\{.*\|\s*&.*\};:/, // fork bomb (literal pipes escaped via char class)
  /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+(\/|~)/i, // chmod -R 777 / or ~
  />\s*\/dev\/sd[a-z]/i, // redirect to block device
  /\b(shutdown|reboot|halt|poweroff)\b/i, // system shutdown commands
  /\binit\s+[06]\b/, // init 0 (halt) / init 6 (reboot)
  /\bsystemctl\s+(stop|disable|mask)\s+ssh/i, // disable SSH
  /\bltinit\s+[06]\b/, // SysV equivalent
  /\btelinit\s+[06]\b/, // SysV alt
  /:\(\)\{.*\};:|fork\s*bomb/i, // fork bomb variants
  /\bwipefs\b|\bblkdiscard\b|\bsgdisk\b.*--zap/i, // disk wiping tools
  />\s*\/dev\/nvme/, // write to NVMe device
];

// ---------------------------------------------------------------------------
// Configuration constants (override via env vars at deploy time)
// ---------------------------------------------------------------------------
const DEFAULT_TIMEOUT_SECONDS = parseInt(
  process.env.TERMINAL_COMMAND_TIMEOUT || "300",
  10
);
const MAX_TIMEOUT_SECONDS = 600; // hard cap: 10 minutes
const MAX_OUTPUT_CHARS = 10000; // truncation threshold for LLM context
const MAX_COMMAND_LENGTH = 4096; // reject absurdly long commands

// ---------------------------------------------------------------------------
// TerminalManager — singleton holding persistent session state.
// Follows the same pattern as FilesystemManager in filesystem/lib.js.
// Only the working directory persists across invocations (each command
// spawns a fresh bash process). Environment vars, shell functions, etc.
// do NOT carry over between calls.
// ---------------------------------------------------------------------------
class TerminalManager {
  #workDir = null;
  #initialized = false;

  /**
   * Checks if the terminal tool is available.
   * Available when running in a Docker container, or when the
   * `terminalAccess` feature flag is enabled for the current
   * TOTEM_BUILD_PROFILE (e.g. the source profile running locally).
   * @returns {boolean} True if the tool is available
   */
  isToolAvailable() {
    if (process.env.ANYTHING_LLM_RUNTIME === "docker") return true;

    try {
      const {
        resolveFeatures,
      } = require("../../../../../../totem.features.cjs");
      const features = resolveFeatures();
      return features?.terminalAccess?.enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize the session working directory. Called lazily on first use.
   * Resolves ~ and relative paths, validates existence.
   */
  async init(workDir = null) {
    if (this.#initialized) return this.workDir;

    const raw =
      workDir || process.env.TERMINAL_DEFAULT_WORK_DIR || os.homedir();
    const resolved = path.resolve(this.#expandHome(raw));

    try {
      await fs.access(resolved);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        throw new Error(`"${resolved}" is not a directory`);
      }
    } catch (e) {
      throw new Error(
        `Terminal access: default working directory "${resolved}" is invalid. ` +
          `Set TERMINAL_DEFAULT_WORK_DIR to a valid path. (${e.message})`
      );
    }

    this.#workDir = resolved;
    this.#initialized = true;
    return this.workDir;
  }

  /** Current working directory (falls back to home if not yet initialized). */
  get workDir() {
    return this.#workDir || os.homedir();
  }

  /** Whether the session has been initialized. */
  get isInitialized() {
    return this.#initialized;
  }

  /**
   * Change the persistent working directory.
   * Resolves relative paths against current dir, validates existence.
   * @param {string} target - Absolute or relative path to cd into.
   * @throws If target does not exist or is not a directory.
   */
  async setWorkDir(target) {
    const resolved = path.resolve(this.workDir, this.#expandHome(target));

    try {
      await fs.access(resolved);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        throw new Error(`"${resolved}" is not a directory`);
      }
    } catch (e) {
      throw new Error(`Cannot change to "${target}": ${e.message}`);
    }

    this.#workDir = resolved;
  }

  /**
   * Execute a shell command with timeout and process-group kill.
   * Spawns a fresh login bash per invocation (no state carries over except CWD).
   *
   * @param {string} command - The shell command to execute.
   * @param {number} timeoutSeconds - Max seconds before SIGTERM/SIGKILL.
   * @returns {Promise<{exitCode: number, signal: string|null, timedOut: boolean, elapsedSeconds: number, output: string}>}
   */
  async execute(command, timeoutSeconds) {
    const workDir = this.workDir;
    const start = Date.now();

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killTimer = null;

      // Spawn in a new process group (detached: true) so we can kill
      // the entire tree on timeout — not just the direct bash child.
      const proc = spawn("/bin/bash", ["-l", "-c", command], {
        cwd: workDir,
        env: { ...process.env },
        shell: false,
        detached: true, // new process group leader
      });

      // Timeout guard — SIGTERM first, then SIGKILL after 3s grace period.
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch (_) {
          proc.kill("SIGTERM");
        }
        // Escalate to SIGKILL if still alive after 3 seconds.
        killTimer = setTimeout(() => {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch (_) {
            /* already dead */
          }
        }, 3000);
      }, timeoutSeconds * 1000);

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (killTimer) clearTimeout(killTimer);
      };

      proc.on("close", (code, signal) => {
        cleanup();
        // Also kill the process group in case children survived.
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch (_) {
          /* already dead */
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(2);

        let output = "";
        if (stdout.trim()) output += stdout.trim();
        if (stderr.trim()) {
          output += (output ? "\n" : "") + `[STDERR]\n${stderr.trim()}`;
        }

        resolve({
          exitCode: code ?? -1,
          signal: signal || null,
          timedOut,
          elapsedSeconds: parseFloat(elapsed),
          output: TerminalManager.truncateOutput(output || "(no output)"),
        });
      });

      proc.on("error", (err) => {
        cleanup();
        resolve({
          exitCode: -1,
          signal: null,
          timedOut: false,
          elapsedSeconds: 0,
          output: `Error executing command: ${err.message}`,
        });
      });
    });
  }

  /** Expand leading ~ to the user's home directory. */
  #expandHome(p) {
    if (p === "~" || p.startsWith("~/")) {
      return path.join(os.homedir(), p.slice(1));
    }
    return p;
  }

  /**
   * Truncate output to stay within LLM context limits.
   * Keeps head and tail, elides the middle.
   */
  static truncateOutput(str, maxLen = MAX_OUTPUT_CHARS) {
    if (!str || str.length <= maxLen) return str;
    const half = Math.floor(maxLen / 2);
    return (
      str.substring(0, half) +
      `\n... [${str.length - maxLen} chars truncated] ...\n` +
      str.substring(str.length - half)
    );
  }

  /**
   * Check whether a command matches any dangerous pattern.
   * @returns {boolean}
   */
  static isDangerous(command) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) return true;
    }
    return false;
  }

  /**
   * Parse a cd command. Supports:
   *   - `cd /path`
   *   - `cd /path && rest of command`
   *   - `cd ~/relative/path`
   * Returns { targetDir, remainder } or null if not a cd command.
   */
  static parseCd(command) {
    // Match: optional whitespace, 'cd', space, quoted/unquoted path, then optionally && rest
    const match = command.match(
      /^\s*cd\s+["']?([^"'&;|]+?)["']?(?:\s*&&\s*(.+))?$/i
    );
    if (!match) return null;

    return {
      targetDir: match[1].trim(),
      remainder: match[2] ? match[2].trim() : null,
    };
  }
}

// Singleton instance — state persists across agent invocations in the same process.
const terminalManager = new TerminalManager();

// ---------------------------------------------------------------------------
// Plugin definition (single-tool pattern, like web-browsing.js)
// ---------------------------------------------------------------------------
const terminalAccess = {
  name: "terminal-access",
  startupConfig: { params: {} },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        // Gate: do not register the tool at all if unavailable in this runtime.
        if (!terminalManager.isToolAvailable()) return;

        aibitat.function({
          super: aibitat,
          name: "terminal-access",
          description:
            "Execute shell commands with working directory tracking and safety guards. " +
            "Runs commands via login bash (loads .bashrc/.profile). " +
            "The working directory persists between calls — use 'cd /path' to navigate. " +
            "Environment variables and shell state do NOT persist between calls. " +
            "Use this for: running tests, builds, git operations, package installs, scripts, " +
            "and any task that requires executing a program.",
          examples: [
            {
              prompt: "List files in the current directory",
              call: JSON.stringify({ command: "ls -la" }),
            },
            {
              prompt: "Navigate to my project and show git status",
              call: JSON.stringify({
                command: "cd ~/projects/myapp && git status",
              }),
            },
            {
              prompt: "Run the test suite",
              call: JSON.stringify({ command: "yarn test" }),
            },
            {
              prompt: "Install a new npm package",
              call: JSON.stringify({ command: "npm install express" }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              command: {
                type: "string",
                description:
                  "The shell command to execute. Use absolute paths or 'cd /path && cmd' for navigation.",
              },
            },
            required: ["command"],
            additionalProperties: false,
          },
          handler: async function ({ command }) {
            const caller = this.caller || "agent";

            // --- Input validation ---
            if (!command || !command.trim()) {
              return JSON.stringify({
                status: "error",
                message: 'No command provided. Use the "command" parameter.',
              });
            }

            const trimmed = command.trim();

            if (trimmed.length > MAX_COMMAND_LENGTH) {
              return JSON.stringify({
                status: "error",
                message: `Command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters.`,
              });
            }

            try {
              // --- Lazy init ---
              await terminalManager.init();

              const timeoutSecs = Math.min(
                Number.isFinite(DEFAULT_TIMEOUT_SECONDS) &&
                  DEFAULT_TIMEOUT_SECONDS > 0
                  ? DEFAULT_TIMEOUT_SECONDS
                  : 300,
                MAX_TIMEOUT_SECONDS
              );

              this.super.introspect(
                `${caller} executing: ${trimmed.substring(0, 120)}${trimmed.length > 120 ? "..." : ""}`
              );

              // --- Dangerous command check → user approval ---
              if (TerminalManager.isDangerous(trimmed)) {
                this.super.introspect(
                  `${caller} WARNING: dangerous pattern detected. Requesting user approval...`
                );

                const { approved, message } =
                  await this.super.requestToolApproval({
                    skillName: "terminal-access",
                    payload: trimmed,
                    description: `Execute shell command in ${terminalManager.workDir}: "${trimmed}"`,
                  });

                if (!approved) {
                  return JSON.stringify({
                    status: "rejected",
                    reason: message || "User rejected the command.",
                    command: trimmed,
                  });
                }

                this.super.introspect(`${caller} Command approved by user.`);
              } else {
                this.super.handlerProps.log(
                  `${caller}: safe command, auto-executing: ${trimmed}`
                );
              }

              // --- cd handling (updates persistent working directory) ---
              let effectiveCommand = trimmed;
              const cdParsed = TerminalManager.parseCd(trimmed);

              if (cdParsed) {
                const { targetDir, remainder } = cdParsed;
                await terminalManager.setWorkDir(targetDir);

                if (remainder) {
                  // Execute the part after && in the new directory.
                  effectiveCommand = remainder;
                } else {
                  // Bare cd — just report success with updated dir.
                  this.super.introspect(
                    `${caller} Changed working directory to ${terminalManager.workDir}`
                  );
                  return JSON.stringify({
                    status: "success",
                    command: trimmed,
                    workingDirectory: terminalManager.workDir,
                    exitCode: 0,
                    timedOut: false,
                    elapsedSeconds: 0,
                    output: `Changed to ${terminalManager.workDir}`,
                  });
                }
              }

              // --- Execute the command ---
              const result = await terminalManager.execute(
                effectiveCommand,
                timeoutSecs
              );

              this.super.introspect(
                `${caller} completed. Exit: ${result.exitCode}, Time: ${result.elapsedSeconds}s, Dir: ${terminalManager.workDir}`
              );

              return JSON.stringify({
                status: result.exitCode === 0 ? "success" : "error",
                command: trimmed,
                workingDirectory: terminalManager.workDir,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                elapsedSeconds: result.elapsedSeconds,
                output: result.output,
              });
            } catch (e) {
              this.super.handlerProps.log(
                `${caller}: terminal-access error: ${e.message}`
              );
              return JSON.stringify({
                status: "error",
                message: e.message,
                command: trimmed,
              });
            }
          },
        });
      },
    };
  },
};

module.exports = {
  terminalAccess,
  terminalManager,
};
