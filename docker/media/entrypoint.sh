#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Totem LLM — Media instance entrypoint (runs BEFORE docker/beta/run.sh)
#
# The beta run.sh handles clone → install → dev:all. This small wrapper adds
# ONE thing for the media instance: ensure the WordPress MCP server
# ("totemai-website") is present in the live MCP config, so the team gets the
# totemai-website tools without any manual MCP registration.
#
# IMPORTANT: the product picks the config file by NODE_ENV
# (see server/utils/MCP/hypervisor/index.js):
#   development → <repo>/server/storage/plugins/anythingllm_mcp_servers.json
#   production  → $STORAGE_DIR/plugins/anythingllm_mcp_servers.json
# We target the correct one for the current NODE_ENV. The read-only seed is
# mounted at /seed/anythingllm_mcp_servers.json. We MERGE (not clobber) so any
# servers you add through the UI are preserved, and we only write when our
# server is missing — subsequent runs and UI edits are left untouched.
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

STORAGE_DIR="${STORAGE_DIR:-/app/totem-storage}"
REPO_DIR="${REPO_DIR:-/app/repo}"
SEED_SRC="/seed/anythingllm_mcp_servers.json"
SEED_NAME="totemai-website"

if [ "${NODE_ENV:-}" = "development" ]; then
    TARGET_FILE="$REPO_DIR/server/storage/plugins/anythingllm_mcp_servers.json"
else
    TARGET_FILE="$STORAGE_DIR/plugins/anythingllm_mcp_servers.json"
fi

if [ -f "$SEED_SRC" ] && command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs"), path = require("path");
      // NOTE: for `node -e` argv[0] is the node binary, so real args start at argv[1].
      const [target, seedSrc, name] = process.argv.slice(1);
      const seed = JSON.parse(fs.readFileSync(seedSrc, "utf8")).mcpServers[name];
      let cfg = { mcpServers: {} };
      if (fs.existsSync(target)) {
        try { cfg = JSON.parse(fs.readFileSync(target, "utf8")) || { mcpServers: {} }; }
        catch (e) { cfg = { mcpServers: {} }; }
      }
      cfg.mcpServers = cfg.mcpServers || {};
      if (!cfg.mcpServers[name]) {
        cfg.mcpServers[name] = seed;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(cfg, null, 2), "utf8");
        console.log("  Seeded MCP server " + name + " -> " + target);
      } else {
        console.log("  MCP server " + name + " already present at " + target + " - leaving as-is.");
      }
    ' "$TARGET_FILE" "$SEED_SRC" "$SEED_NAME"
fi

# Hand off to the real (beta) entrypoint. run.sh is copied to /usr/local/bin/run.sh
# by the Dockerfile. `exec` replaces this shell so signal handling and the
# foreground process group are identical to running it directly.
exec /usr/local/bin/run.sh
