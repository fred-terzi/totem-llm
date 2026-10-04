#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Totem LLM — Venice AI Container Entrypoint (Phase 1)
#
# Responsibilities:
#   1. Validate that VENICE_API_KEY is set (it comes from `docker run -e`)
#   2. Export the provider / embedding / storage environment
#   3. Launch totem-llm (foreground, PID 1) — it spawns server + collector
#
# No Ollama, no GPU detection, no model pulls. Venice is a hosted API.
#
# The LLM provider (server/utils/AiProviders/venice/index.js) reads at runtime:
#   VENICE_API_KEY    — required (throws if missing)
#   VENICE_BASE_PATH  — default https://api.venice.ai/api/v1
#   VENICE_MODEL_PREF — default zai-org-glm-5-1
#   VENICE_MAX_TOKENS — default 1024
#
# The native embedder downloads its small model on first use into
#   $STORAGE_DIR/models/  (persists in the mounted volume).
# ──────────────────────────────────────────────────────────────────────────────

set -uo pipefail  # no -e; we handle the one fatal check explicitly

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[totem-venice]${NC} $*"; }
warn() { echo -e "${YELLOW}[totem-venice]${NC} $*"; }
err()  { echo -e "${RED}[totem-venice]${NC} $*" >&2; }

# ══════════════════════════════════════════════════════════════════════════════
# 1. VALIDATE VENICE_API_KEY
# ══════════════════════════════════════════════════════════════════════════════
# The key is injected by the orchestrator at container creation time.
# It is deliberately never written to a file — it only exists here in the
# process environment. If it's missing we fail fast with a clear message
# rather than letting the app start and 500 on the first chat request.
if [ -z "${VENICE_API_KEY:-}" ]; then
    err "VENICE_API_KEY is not set."
    err ""
    err "This container requires the shared Venice API key to be injected at creation time:"
    err "    docker run -e VENICE_API_KEY=<your-venice-key> totem-venice:latest"
    err ""
    err "In the hosted deployment the orchestrator provides this automatically."
    exit 1
fi
log "VENICE_API_KEY detected (value hidden)"

# ══════════════════════════════════════════════════════════════════════════════
# 2. EXPORT ENVIRONMENT FOR TOTEM
# ══════════════════════════════════════════════════════════════════════════════
# Provider is locked to Venice. The pre-created .env already sets these, but
# we also export them into the process env so the app is unambiguous even if
# the .env is ever removed. The .env takes priority in lib/config.js#getEnv(),
# and both agree on Venice, so there is no conflict.

export LLM_PROVIDER="venice"

# Venice model + token limits (optional overrides; sensible defaults otherwise)
export VENICE_MODEL_PREF="${VENICE_MODEL_PREF:-zai-org-glm-5-1}"
export VENICE_MAX_TOKENS="${VENICE_MAX_TOKENS:-1024}"

# Embedding — local/native (no external API key needed)
export EMBEDDING_ENGINE="native"
export EMBEDDING_MODEL_PREF="${EMBEDDING_MODEL_PREF:-Xenova/all-MiniLM-L6-v2}"

# Vector DB + storage
export VECTOR_DB="${VECTOR_DB:-lancedb}"
export TOTEM_STORAGE_DIR="${TOTEM_STORAGE_DIR:-/app/totem-storage}"
export STORAGE_DIR="$TOTEM_STORAGE_DIR"
export SERVER_PORT="${SERVER_PORT:-8686}"
export COLLECTOR_PORT="${COLLECTOR_PORT:-8888}"
export DISABLE_TELEMETRY=true

# Ensure storage directory exists (mounted volume in the hosted deployment)
mkdir -p "$TOTEM_STORAGE_DIR"

# ══════════════════════════════════════════════════════════════════════════════
# 3. LAUNCH TOTEM (foreground process — keeps container alive)
#
# totem-llm spawns server + collector as children (via lib/launcher.js) and
# handles SIGTERM/SIGINT for its own children. There is no Ollama to clean up.
# ══════════════════════════════════════════════════════════════════════════════

echo ""
log "════════════════════════════════════════════════════════════"
log "  Totem LLM (Venice) starting"
log "  UI:         http://localhost:${SERVER_PORT}"
log "  LLM:        Venice AI (${VENICE_MODEL_PREF})"
log "  Embedding:  native (${EMBEDDING_MODEL_PREF})"
log "  Vector DB:  ${VECTOR_DB}"
log "  Storage:    ${TOTEM_STORAGE_DIR}"
log "  Key:        hidden (env only)"
log "════════════════════════════════════════════════════════════"
echo ""

# Run in foreground. `exec` replaces this shell with totem-llm so it becomes
# PID 1 and receives Docker's stop signal (SIGTERM) directly — clean shutdown.
exec totem-llm
