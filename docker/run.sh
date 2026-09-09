#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Totem LLM — Container Entrypoint
#
# 1. Detects GPU(s) via nvidia-smi
# 2. Selects the optimal Ollama model + quant + context window
# 3. Starts Ollama in the background
# 4. Pulls the selected model (if not already on disk)
# 5. Launches totem-llm (foreground, PID 1)
#
# Pre-vetted model list:
#   qwen3.5:9b    — minimum LLM (CPU or small GPU)
#   qwen3.8:27b-mtp-q4_K_M   — primary LLM (≥ 24 GB VRAM), quant varies by VRAM tier
#   nomic-embed-text — RAG embeddings (all tiers)
#
# User overrides (via Runpod template env or docker run -e):
#   TOTEM_MODEL_OVERRIDE     — force a specific Ollama model tag
#   TOTEM_CONTEXT_OVERRIDE   — force a specific context window (tokens)
#
# These are translated to the Ollama provider env vars:
#   OLLAMA_MODEL_PREF        ← TOTEM_MODEL_OVERRIDE or GPU-detected model
#   OLLAMA_MODEL_TOKEN_LIMIT ← TOTEM_CONTEXT_OVERRIDE or GPU-detected context
# ──────────────────────────────────────────────────────────────────────────────

set -uo pipefail  # Note: no -e; we handle errors explicitly for proper cleanup

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[totem]${NC} $*"; }
warn() { echo -e "${YELLOW}[totem]${NC} $*"; }
err()  { echo -e "${RED}[totem]${NC} $*" >&2; }

# ══════════════════════════════════════════════════════════════════════════════
# 1. GPU DETECTION
# ══════════════════════════════════════════════════════════════════════════════
TOTAL_VRAM_GB=0
GPU_COUNT=0
GPU_NAMES=""

if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
    # Sum VRAM across all GPUs (Ollama can split layers across GPUs)
    # nvidia-smi reports memory.total in MiB with --format=nounits
    GPU_VRAM_MIB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | awk '{s+=$1} END {print s+0}' || echo 0)
    GPU_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l | tr -d ' ' || echo 1)
    GPU_NAMES=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | sed 's/ $//' || echo "unknown")
    TOTAL_VRAM_GB=$(( (GPU_VRAM_MIB + 512) / 1024 ))  # MiB → GB, round up
    log "GPU detected: ${GPU_NAMES} × ${GPU_COUNT} (~${TOTAL_VRAM_GB} GB total VRAM)"
else
    warn "No NVIDIA GPU detected — will use CPU-compatible model"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 2. MODEL SELECTION
#
# Tiers (by total VRAM across all GPUs):
#
#   Tier       | VRAM     | Model            | Quant   | Context  | Rationale
#   -----------|----------|------------------|---------|----------|----------------------------------
#   CPU        | 0        | qwen3.5:9b       | Q4_K_M  |  4096    | CPU inference, low ctx
#   Small      | 1-15 GB  | qwen3.5:9b       | Q4_K_M  |  8192    | Fits comfortably
#   Medium     | 16-23 GB | qwen3.5:9b-q8_0  | Q8_0    | 16384    | T4/A10G — 9b at high quality
#   Large      | 24-31 GB | qwen3.8:27b-mtp-q4_K_M      | Q4_K_M  |  8192    | 27b fits with default quant
#   XL         | 32-39 GB | qwen3.8:27b-mtp-q4_K_M      | Q4_K_M  | 32768    | A100 40GB — extra VRAM → bigger ctx
#   XXL        | 40-79 GB | qwen3.8:27b-mtp-q8_0 | Q8_0    | 32768    | A100 80GB — 27b full precision
#   MAX        | 80+ GB   | qwen3.8:27b-mtp-q8_0 | Q8_0    | 131072   | 2×H100/B200 — max context
# ══════════════════════════════════════════════════════════════════════════════

SELECTED_MODEL=""
SELECTED_CTX=""
TIER=""

# User override wins (set TOTEM_MODEL_OVERRIDE / TOTEM_CONTEXT_OVERRIDE)
if [ -n "${TOTEM_MODEL_OVERRIDE:-}" ]; then
    SELECTED_MODEL="$TOTEM_MODEL_OVERRIDE"
    SELECTED_CTX="${TOTEM_CONTEXT_OVERRIDE:-8192}"
    TIER="user override"
    log "Using user-specified model: ${SELECTED_MODEL} (ctx: ${SELECTED_CTX})"
else
    # Auto-select based on VRAM tier
    if [ "$TOTAL_VRAM_GB" -ge 80 ]; then
        SELECTED_MODEL="qwen3.8:27b-mtp-q8_0"
        SELECTED_CTX=131072
        TIER="MAX (80+ GB)"
    elif [ "$TOTAL_VRAM_GB" -ge 40 ]; then
        SELECTED_MODEL="qwen3.8:27b-mtp-q8_0"
        SELECTED_CTX=32768
        TIER="XXL (40-79 GB)"
    elif [ "$TOTAL_VRAM_GB" -ge 32 ]; then
        SELECTED_MODEL="qwen3.8:27b-mtp-q4_K_M"
        SELECTED_CTX=32768
        TIER="XL (32-39 GB)"
    elif [ "$TOTAL_VRAM_GB" -ge 24 ]; then
        SELECTED_MODEL="qwen3.8:27b-mtp-q4_K_M"
        SELECTED_CTX=8192
        TIER="Large (24-31 GB)"
    elif [ "$TOTAL_VRAM_GB" -ge 16 ]; then
        SELECTED_MODEL="qwen3.5:9b-q8_0"
        SELECTED_CTX=16384
        TIER="Medium (16-23 GB)"
    elif [ "$TOTAL_VRAM_GB" -ge 1 ]; then
        SELECTED_MODEL="qwen3.5:9b"
        SELECTED_CTX=8192
        TIER="Small (1-15 GB)"
    else
        SELECTED_MODEL="qwen3.5:9b"
        SELECTED_CTX=4096
        TIER="CPU"
    fi

    log "Selected tier: ${TIER}"
    log "Model: ${SELECTED_MODEL}"
    log "Context window: ${SELECTED_CTX} tokens"
fi

# Embedding model (same across all tiers)
EMBEDDING_MODEL="nomic-embed-text:latest"
log "Embedding model: ${EMBEDDING_MODEL}"

# ══════════════════════════════════════════════════════════════════════════════
# 3. START OLLAMA (background)
# ══════════════════════════════════════════════════════════════════════════════
log "Starting Ollama server…"
OLLAMA_MODELS="${OLLAMA_MODELS:-/root/.ollama}" \
OLLAMA_HOST="0.0.0.0" \
    ollama serve > /tmp/ollama.log 2>&1 &
OLLAMA_PID=$!

# Wait for Ollama to be ready (up to 30s)
for i in $(seq 1 30); do
    if curl -s --max-time 2 http://127.0.0.1:11434/api/version > /dev/null 2>&1; then
        OLLAMA_VER=$(curl -s http://127.0.0.1:11434/api/version 2>/dev/null | sed 's/.*"version":"\([^"]*\)".*/\1/' || echo "unknown")
        log "Ollama ready (v${OLLAMA_VER})"
        break
    fi
    if [ "$i" -eq 30 ]; then
        err "Ollama failed to start. Check /tmp/ollama.log"
        cat /tmp/ollama.log
        exit 1
    fi
    sleep 1
done

# Give Ollama a moment to index pre-baked models from disk
sleep 2

# ══════════════════════════════════════════════════════════════════════════════
# 4. PULL MODELS (skip if already on disk)
# ══════════════════════════════════════════════════════════════════════════════

model_exists() {
    # Check if a model (with tag) is already pulled
    # e.g. model_exists "qwen3.8:27b-mtp-q8_0"
    local full="$1"

    # Primary check: ollama list
    if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$full"; then
        return 0
    fi

    # Fallback: check filesystem directly (model may be on disk but Ollama
    # hasn't finished indexing it into its in-memory list yet)
    # Ollama layout: $OLLAMA_MODELS/models/manifests/registry.ollama.ai/library/<name>/<tag>
    local name="${full%%:*}"
    local tag="${full##*:}"
    if [ "$tag" = "$full" ]; then
        tag="latest"
    fi
    if [ -f "${OLLAMA_MODELS:-/root/.ollama}/models/manifests/registry.ollama.ai/library/${name}/${tag}" ]; then
        return 0
    fi

    return 1
}

# Pull embedding model
if ! model_exists "$EMBEDDING_MODEL"; then
    log "Pulling embedding model: ${EMBEDDING_MODEL}…"
    ollama pull "$EMBEDDING_MODEL"
    log "Embedding model ready."
else
    log "Embedding model already present: ${EMBEDDING_MODEL} ✓"
fi

# Pull LLM model
if ! model_exists "$SELECTED_MODEL"; then
    log "Pulling LLM model: ${SELECTED_MODEL} (this may take a few minutes)…"
    ollama pull "$SELECTED_MODEL"
    log "Model pull complete."
else
    log "LLM model already present: ${SELECTED_MODEL} ✓"
fi

# Display all loaded models
echo ""
log "Available models on this pod:"
ollama list 2>/dev/null | sed 's/^/    /'
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 5. EXPORT ENVIRONMENT FOR TOTEM
#
# The Ollama LLM provider (server/utils/AiProviders/ollama/index.js) reads:
#   OLLAMA_BASE_PATH        — server URL
#   OLLAMA_MODEL_PREF       — model tag (e.g. "qwen3.8:27b-mtp-q8_0")
#   OLLAMA_MODEL_TOKEN_LIMIT — max context window (num_ctx)
#   OLLAMA_KEEP_ALIVE_TIMEOUT — model warm-up timeout (seconds)
#
# The Ollama embedder (server/utils/EmbeddingEngines/ollama/index.js) reads:
#   EMBEDDING_BASE_PATH     — server URL
#   EMBEDDING_MODEL_PREF    — embedding model tag
#   EMBEDDING_MODEL_MAX_CHUNK_LENGTH — max input chunk size (chars)
# ══════════════════════════════════════════════════════════════════════════════

export LLM_PROVIDER="ollama"
export OLLAMA_BASE_PATH="http://127.0.0.1:11434"
export OLLAMA_MODEL_PREF="$SELECTED_MODEL"
export OLLAMA_MODEL_TOKEN_LIMIT="$SELECTED_CTX"
export OLLAMA_KEEP_ALIVE_TIMEOUT="${OLLAMA_KEEP_ALIVE_TIMEOUT:-3600}"

export EMBEDDING_ENGINE="ollama"
export EMBEDDING_BASE_PATH="http://127.0.0.1:11434"
export EMBEDDING_MODEL_PREF="$EMBEDDING_MODEL"
export EMBEDDING_MODEL_MAX_CHUNK_LENGTH="${EMBEDDING_MODEL_MAX_CHUNK_LENGTH:-8192}"

export VECTOR_DB="${VECTOR_DB:-lancedb}"
export TOTEM_STORAGE_DIR="${TOTEM_STORAGE_DIR:-/app/totem-storage}"
export STORAGE_DIR="$TOTEM_STORAGE_DIR"
export SERVER_PORT="${SERVER_PORT:-8686}"
export COLLECTOR_PORT="${COLLECTOR_PORT:-8888}"

# Ensure storage directory exists
mkdir -p "$TOTEM_STORAGE_DIR"

# ══════════════════════════════════════════════════════════════════════════════
# 6. LAUNCH TOTEM (foreground process — keeps container alive)
#
# totem-llm spawns server + collector as children (via lib/launcher.js).
# It handles SIGTERM/SIGINT for its own children. We just need to ensure
# Ollama is cleaned up when totem exits.
# ══════════════════════════════════════════════════════════════════════════════

echo ""
log "══════════════════════════════════════════════════════"
log "  Totem LLM starting"
log "  UI:            http://localhost:${SERVER_PORT}"
log "  LLM:           ${SELECTED_MODEL}"
log "  Context:       ${SELECTED_CTX} tokens"
log "  Embedding:     ${EMBEDDING_MODEL}"
log "  GPU:           ${GPU_NAMES:-CPU only}"
log "  Tier:          ${TIER}"
log "  Storage:       ${TOTEM_STORAGE_DIR}"
log "══════════════════════════════════════════════════════"
echo ""

# Launch totem-llm in background (we need to track its PID for signal forwarding)
totem-llm &
TOTEM_PID=$!

# Forward termination signals to both totem-llm and Ollama
trap 'log "Shutting down…"; kill -TERM $TOTEM_PID $OLLAMA_PID 2>/dev/null; wait $TOTEM_PID $OLLAMA_PID 2>/dev/null; exit 0' TERM INT

# Wait for totem-llm to exit (this is the main process that keeps the container alive)
wait $TOTEM_PID
EXIT_CODE=$?

# Clean up Ollama
kill -TERM $OLLAMA_PID 2>/dev/null
wait $OLLAMA_PID 2>/dev/null || true

log "Totem LLM exited with code ${EXIT_CODE}"
exit $EXIT_CODE
