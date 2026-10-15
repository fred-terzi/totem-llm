#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Totem LLM — Beta container entrypoint
#
# Steps:
#   1. Clone the repo (skip if already present) and checkout REPO_BRANCH
#   2. yarn setup  (installs deps, copies .env files, runs prisma)
#   3. Start cloudflared quick tunnel → http://localhost:13000
#   4. Print the temp URL prominently
#   5. Run yarn dev:all in the foreground (server + collector + frontend)
#
# All stdout goes to the container log, so `docker logs -f <container>` shows:
#   • setup / install progress
#   • the highlighted temp URL
#   • all of dev:all's debug output (server, collector, frontend)
#
# SIGTERM / SIGINT handling:
#   `yarn dev:all` runs in the foreground via `exec` so the signal propagates
#   to the whole process group (concurrently → nodemon → node). cloudflared
#   is cleaned up in the EXIT trap.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/fred-terzi/totem-llm.git}"
REPO_BRANCH="${REPO_BRANCH:-dev-totem}"
REPO_DIR="${REPO_DIR:-/app/repo}"
TUNNEL_TARGET="${TUNNEL_TARGET:-http://localhost:13000}"
CF_LOG="/tmp/cloudflared.log"
CF_PID=""

# ── Cloudflared argument selection ───────────────────────────────────────────
# If TUNNEL_TOKEN is set (docker/beta/.env via compose), run a NAMED tunnel →
# permanent URL https://beta.totemai.xyz. Otherwise fall back to an
# account-less QUICK tunnel (random *.trycloudflare.com URL, changes each run).
CF_ARGS=(tunnel)
CF_URL_PATTERN='https://[a-z0-9-]+\.trycloudflare\.com'
TUNNEL_KIND="quick (temporary)"
if [ -n "${TUNNEL_TOKEN:-}" ]; then
    CF_ARGS=(tunnel run --token "$TUNNEL_TOKEN")
    CF_URL_PATTERN='beta\.totemai\.xyz'
    TUNNEL_KIND="named (permanent)"
fi

# ── Cleanup on exit ──────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Shutting down beta container…"
    if [ -n "$CF_PID" ] && kill -0 "$CF_PID" 2>/dev/null; then
        echo "  Stopping cloudflared (PID $CF_PID)"
        kill "$CF_PID" 2>/dev/null || true
        wait "$CF_PID" 2>/dev/null || true
    fi
    echo "  Bye."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}
trap cleanup EXIT INT TERM

# ── Step 1: Clone or update ──────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Totem LLM — Beta container starting"
echo "  Repo:  $REPO_URL"
echo "  Branch: $REPO_BRANCH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -d "$REPO_DIR/.git" ]; then
    echo "  Repo already present at $REPO_DIR — pulling latest $REPO_BRANCH"
    cd "$REPO_DIR"
    git checkout "$REPO_BRANCH"
    # Discard any local modifications (e.g. the vite.config.js sed patch from
    # the previous run) so the pull can apply cleanly. The patch is
    # re-applied in Step 2b below.
    git checkout -- .
    git fetch origin
    git pull origin "$REPO_BRANCH"
else
    echo "  Cloning $REPO_URL (branch: $REPO_BRANCH) → $REPO_DIR"
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
echo ""
echo "  On commit: $(git rev-parse --short HEAD)  ($(git log -1 --format=%s))"
echo ""

# ── Step 2b: Patch vite.config.js ────────────────────────────────────────────
# Vite ≥ 4.5 adds a DNS-rebinding host check. In the container, cloudflared
# sends the trycloudflare.com hostname which Vite blocks by default.
# `allowedHosts: true` disables the check entirely (fine for a dev/beta
# container — the app is already auth-bypassed in development mode).
# This patch is idempotent: if the line is already present (e.g. the local
# repo already has it), the sed is a no-op.
if ! grep -q 'allowedHosts' "$REPO_DIR/frontend/vite.config.js"; then
    echo "  Patching vite.config.js: adding allowedHosts: true for cloudflared…"
    sed -i 's/^  server: {$/  server: {\n    allowedHosts: true,/' "$REPO_DIR/frontend/vite.config.js"
fi
# `yarn setup` (root package.json):
#   cd server && yarn && cd ../collector && yarn && cd ../frontend && yarn && \
#   cd .. && yarn setup:envs && yarn prisma:setup
#
# It is idempotent:
#   • yarn install is a no-op if node_modules is up to date
#   • setup-envs copies .env.example → .env only if the target doesn't exist
#   • prisma:setup (generate + migrate + seed) is safe to re-run
#
# We also run the root `yarn install` first so `concurrently` (a root
# devDependency) is available for `yarn dev:all`.
echo "  Installing root dev deps (concurrently, etc.)"
yarn install --ignore-engines --no-audit --no-fund 2>/dev/null || yarn install --ignore-engines --no-audit --no-fund
echo ""

echo "  Running setup (sub-package installs + envs + prisma)…"
echo "  (npm for sub-packages: yarn v1 can't resolve collector's git+https dep,"
echo "   and we need full dev deps so nodemon/vite are available for dev:all)"
echo ""

cd "$REPO_DIR"

echo "  [1/5] Installing server deps (dev+prod)…"
(cd server && npm install --legacy-peer-deps --no-audit --no-fund --ignore-engines 2>&1 | tail -5)

echo "  [2/5] Installing collector deps (dev+prod)…"
(cd collector && npm install --legacy-peer-deps --no-audit --no-fund --ignore-engines 2>&1 | tail -5)

echo "  [3/5] Installing frontend deps (dev+prod)…"
(cd frontend && npm install --legacy-peer-deps --no-audit --no-fund --ignore-engines 2>&1 | tail -5)

echo "  [4/5] Setting up .env files…"
yarn setup:envs

echo "  [5/5] Prisma: generate + migrate + seed…"
yarn prisma:setup
echo ""

# ── Step 3: cloudflared tunnel ───────────────────────────────────────────────
# With TUNNEL_TOKEN:   `cloudflared tunnel --token <token>` — named tunnel.
#   The ingress rules (beta.totemai.xyz → http://localhost:13000) live on the
#   Cloudflare side (remotely-managed), so no config file is needed.
# Without:             `cloudflared tunnel --url <target>` — "quick tunnel",
#   no account needed. It prints a line like:
#   INF | https://random-words.trycloudflare.com |
#
# We start it in the background, wait for it to register, then announce it.
echo "  Starting cloudflared $TUNNEL_KIND tunnel"
echo "  (named → https://beta.totemai.xyz | quick → $TUNNEL_TARGET)"
cloudflared "${CF_ARGS[@]}" > "$CF_LOG" 2>&1 &
CF_PID=$!
echo "  cloudflared PID: $CF_PID"

# Wait up to 45 s for the tunnel to register (registration log line or URL).
CF_URL=""
for i in $(seq 1 45); do
    # Named tunnel: wait for a successful "Registered tunnel connection" line.
    if [ "$TUNNEL_KIND" != "quick (temporary)" ]; then
        if grep -q 'Registered tunnel connection' "$CF_LOG" 2>/dev/null; then
            CF_URL="https://beta.totemai.xyz"
            break
        fi
    else
        CF_URL=$(grep -oE "$CF_URL_PATTERN" "$CF_LOG" | head -n1 || true)
        if [ -n "$CF_URL" ]; then
            break
        fi
    fi
    sleep 1
done

echo ""
if [ -n "$CF_URL" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅  BETA WEBSITE IS LIVE ($TUNNEL_KIND tunnel)"
    echo ""
    echo "      $CF_URL"
    echo ""
    echo "  (local: http://localhost:13000)"
    echo "  (tunnel log: $CF_LOG  — follow with: docker exec -it <ctr> tail -f $CF_LOG)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
    echo "  ⚠️  cloudflared did not register within 45 s."
    echo "      Check logs: docker exec -it <ctr> cat $CF_LOG"
    echo "      (the tunnel may still be starting — give it another moment)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi
echo ""

# ── Step 4: yarn dev:all (foreground) ────────────────────────────────────────
# Root package.json script:
#   SERVER_PORT=28686 COLLECTOR_PORT=28888 FRONTEND_PORT=13000 \
#     npx concurrently "yarn dev:server" "yarn dev:frontend" "yarn dev:collector"
#
# exec replaces this shell so SIGTERM/SIGINT go directly to concurrently,
# which forwards them to all three child services.
echo "  Starting dev:all (server + collector + frontend)…"
echo "  Ctrl-C / docker stop will trigger the cleanup trap."
echo ""
exec yarn dev:all
