#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Totem LLM — Media instance entrypoint (wraps docker/beta/run.sh)
#
# run.sh does: clone → yarn install → setup(envs+prisma) → cloudflared → dev:all
#
# This wrapper adds ONE thing: make sure the WordPress MCP server
# ("totemai-website") is present in the live MCP config, so the team gets the
# totemai-website tools without any manual MCP registration.
#
# THE ORDERING RULE (the bug this avoids):
#   In development mode the product reads the MCP config from the CLONED repo:
#       <repo>/server/storage/plugins/anythingllm_mcp_servers.json   →  /app/repo/…
#   (see server/utils/MCP/hypervisor/index.js — path chosen by NODE_ENV.)
#   We must NEVER create /app/repo before run.sh's `git clone`, because clone
#   fails if the destination dir already exists ("destination path '/app/repo'
#   already exists and is not an empty directory" → exit 128 → crash loop).
#   So we seed via a background poller that waits for <repo>/.git to appear
#   (i.e. AFTER the clone) and then writes the config. The clone + `yarn install`
#   take minutes before the server starts, so the seed always lands in time.
#
# The seeded file is gitignored (server/.gitignore), so it survives run.sh's
# `git checkout -- .` and `git pull` on subsequent boots, and the poller exits
# immediately when it's already present.
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_DIR="${REPO_DIR:-/app/repo}"
SEED_SRC="/seed/anythingllm_mcp_servers.json"
SEED_NAME="totemai-website"
TARGET_FILE="$REPO_DIR/server/storage/plugins/anythingllm_mcp_servers.json"

# Seed once (idempotent: only writes when our server is missing). Refuses to run
# until the repo is actually cloned (.git present) so we never pre-create /app/repo.
seed_once() {
    [ -d "$REPO_DIR/.git" ] || return 1          # not cloned yet
    [ -f "$SEED_SRC" ]      || return 1          # seed mount missing
    command -v node >/dev/null 2>&1 || return 1  # no node
    node -e '
      const fs = require("fs"), path = require("path");
      // for `node -e`, argv[0] is the node binary → real args start at argv[1].
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
        console.log("  [media] Seeded MCP server " + name + " -> " + target);
      } else {
        console.log("  [media] MCP server " + name + " already present - leaving as-is.");
      }
    ' "$TARGET_FILE" "$SEED_SRC" "$SEED_NAME"
}

# Background poller: wait for the clone, then seed. Survives the `exec` below
# (already a separate process). Bounded: up to ~30 min of retries.
(
    for _ in $(seq 1 600); do
        if seed_once; then
            # Confirm it actually landed before declaring success.
            if [ -f "$TARGET_FILE" ] && grep -q "$SEED_NAME" "$TARGET_FILE" 2>/dev/null; then
                echo "  [media] MCP seed complete: $SEED_NAME is registered."
                exit 0
            fi
        fi
        sleep 3
    done
    echo "  [media] WARN: MCP seed poller gave up waiting for $REPO_DIR/.git"
) &

# Hand off to the real (beta) entrypoint. `exec` replaces this shell so signal
# handling and the foreground process group are identical to running it directly.
exec /usr/local/bin/run.sh
