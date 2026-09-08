# ──────────────────────────────────────────────────────────────────────────────
# Totem LLM — GPU-Aware Docker Image (npm package + Ollama)
#
# Strategy:
#   • Install the published `totem-llm` npm package (frontend pre-built,
#     all production deps, Prisma client generated via postinstall)
#   • Install Ollama (bundles CUDA runtime — auto-detects GPU at runtime)
#   • Pre-pull the smallest LLM + embedding model into the image
#   • At startup, detect GPU VRAM and pull/select the optimal model
#
# Primary target: Runpod GPU pod templates.
# Also works: local `docker run --gpus all`, any OCI registry.
#
# GPU detection at runtime (run.sh):
#   - Uses nvidia-smi if available (Runpod base images include it)
#   - Falls back to /dev/nvidia* device check
#   - Falls back to CPU mode (smallest model, low context)
#
# Override model selection (optional):
#   TOTEM_MODEL_OVERRIDE    — force a specific Ollama model tag
#   TOTEM_CONTEXT_OVERRIDE  — force a specific context window (tokens)
# ──────────────────────────────────────────────────────────────────────────────

FROM node:18-slim AS base

# ── Build args ───────────────────────────────────────────────────────────────
ARG TOTEM_LLM_VERSION=latest

# ── System dependencies ──────────────────────────────────────────────────────
# Required for: Chromium/Puppeteer (web-scraping), ffmpeg (audio),
#              tesseract (OCR), basic utilities.
#
# NOTE: nvidia-smi is NOT installed here. It is injected at runtime by the
# NVIDIA container runtime (--gpus all / Runpod GPU allocation). The run.sh
# script gracefully falls back to CPU mode if nvidia-smi is unavailable.
RUN apt-get update --yes && \
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        curl ca-certificates gnupg zstd \
        libasound2 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
        libexpat1 libfontconfig1 libglib2.0-0 libgtk-3-0 libnspr4 \
        libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
        libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
        libxrender1 libxss1 libxtst6 libnss3 \
        xdg-utils git ffmpeg tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# ── Ollama ───────────────────────────────────────────────────────────────────
# The Ollama binary bundles its own CUDA runtime. At runtime it dlopen()s
# libcuda.so.1 which is provided by the host driver (mounted by Docker's
# --gpus flag / Runpod's GPU allocation). No CUDA packages needed here.
RUN curl -fsSL https://ollama.com/install.sh | sh

# ── Install totem-llm globally ───────────────────────────────────────────────
# The npm package postinstall script (scripts/postinstall.mjs) handles:
#   • npm install --production in server/
#   • npm install --production in collector/
#   • npx prisma generate (platform-specific client)
# The frontend is pre-built in the npm tarball (prepublishOnly at publish).
RUN npm install -g "totem-llm@${TOTEM_LLM_VERSION}" --legacy-peer-deps --no-audit --no-fund

# ── Pre-pull Ollama models (baked into image for instant start) ──────────────
# nomic-embed-text:  ~274 MB  — RAG embeddings (needed from first message)
# qwen3.5:9b:        ~5.5 GB  — minimum LLM (CPU + small GPU tiers)
#
# Larger 27B variants are pulled at first startup based on detected VRAM.
# This keeps the image ~6 GB while ensuring any GPU ≥ 10 GB is usable
# immediately.
RUN mkdir -p /root/.ollama && \
    (ollama serve > /dev/null 2>&1 & echo $! > /tmp/ollama-build.pid) && \
    for i in $(seq 1 30); do \
        curl -s --max-time 2 http://127.0.0.1:11434/api/version > /dev/null 2>&1 && break; \
        sleep 1; \
    done && \
    ollama pull nomic-embed-text:latest && \
    ollama pull qwen3.5:9b && \
    OLLAMA_PID=$(cat /tmp/ollama-build.pid) && \
    kill $OLLAMA_PID && \
    for i in $(seq 1 10); do \
        kill -0 $OLLAMA_PID 2>/dev/null || break; \
        sleep 1; \
    done && \
    sync && \
    echo "Pre-baked models:" && ollama list 2>/dev/null || ls /root/.ollama/models/manifests/registry.ollama.ai/library/ 2>/dev/null

# ── Runtime environment defaults ─────────────────────────────────────────────
# OLLAMA_MODEL_PREF and OLLAMA_MODEL_TOKEN_LIMIT are intentionally NOT set
# here — they are determined at runtime by run.sh based on GPU detection.
# Set TOTEM_MODEL_OVERRIDE / TOTEM_CONTEXT_OVERRIDE to force specific values.
ENV NODE_ENV=production \
    TOTEM_STORAGE_DIR=/app/totem-storage \
    OLLAMA_HOST=0.0.0.0 \
    OLLAMA_MODELS=/root/.ollama \
    SERVER_PORT=8686 \
    COLLECTOR_PORT=8888 \
    LLM_PROVIDER=ollama \
    OLLAMA_BASE_PATH=http://127.0.0.1:11434 \
    OLLAMA_KEEP_ALIVE_TIMEOUT=3600 \
    OLLAMA_RESPONSE_TIMEOUT=3600000 \
    EMBEDDING_ENGINE=ollama \
    EMBEDDING_BASE_PATH=http://127.0.0.1:11434 \
    EMBEDDING_MODEL_PREF=nomic-embed-text:latest \
    EMBEDDING_MODEL_MAX_CHUNK_LENGTH=8192 \
    VECTOR_DB=lancedb

# ── Pre-create storage dir + .env ────────────────────────────────────────────
# lib/setup.js generates a .env on first run IF it doesn't already exist.
# Its default has EMBEDDING_ENGINE=native — which would OVERRIDE our Ollama
# settings because lib/config.js#getEnv() gives the .env file HIGHER priority
# than process.env.
#
# By pre-creating the .env here, we:
#   • Ensure EMBEDDING_ENGINE=ollama (not native)
#   • Provide valid secrets so the app works without first-run generation
#   • Leave OLLAMA_MODEL_PREF / OLLAMA_MODEL_TOKEN_LIMIT unset so that the
#     runtime values from run.sh (based on GPU detection) are used
RUN mkdir -p /app/totem-storage && \
    SECRET_KEY=$(openssl rand -hex 32) && \
    SECRET_SALT=$(openssl rand -hex 32) && \
    SECRET_JWT=$(openssl rand -hex 24) && \
    cat > /app/totem-storage/.env << ENVFILE
# Totem LLM — Docker container configuration
# Generated at image build time. Model settings (OLLAMA_MODEL_PREF, OLLAMA_MODEL_TOKEN_LIMIT)
# are injected at runtime by run.sh based on GPU detection.

STORAGE_DIR="/app/totem-storage"
SERVER_PORT=8686
COLLECTOR_PORT=8888

# Security secrets (auto-generated at build time)
JWT_SECRET="${SECRET_JWT}"
SIG_KEY="${SECRET_KEY}"
SIG_SALT="${SECRET_SALT}"

# LLM Provider — Ollama (in-container)
LLM_PROVIDER=ollama
OLLAMA_BASE_PATH=http://127.0.0.1:11434
OLLAMA_KEEP_ALIVE_TIMEOUT=3600
OLLAMA_RESPONSE_TIMEOUT=3600000
# OLLAMA_MODEL_PREF=          ← set at runtime by run.sh
# OLLAMA_MODEL_TOKEN_LIMIT=   ← set at runtime by run.sh

# Embedding Engine — Ollama (in-container)
EMBEDDING_ENGINE=ollama
EMBEDDING_BASE_PATH=http://127.0.0.1:11434
EMBEDDING_MODEL_PREF=nomic-embed-text:latest
EMBEDDING_MODEL_MAX_CHUNK_LENGTH=8192

# Vector database (zero-setup file-based default)
VECTOR_DB=lancedb

# Telemetry
DISABLE_TELEMETRY=true
ENVFILE

# ── Startup script ───────────────────────────────────────────────────────────
COPY docker/run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh

# ── Healthcheck ──────────────────────────────────────────────────────────────
COPY docker/docker-healthcheck.sh /usr/local/bin/docker-healthcheck.sh
RUN chmod +x /usr/local/bin/docker-healthcheck.sh
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s \
    CMD /usr/local/bin/docker-healthcheck.sh || exit 1

# ── Ports ────────────────────────────────────────────────────────────────────
# 8686:  Totem LLM UI + API (Runpod HTTP proxy exposes this)
# 11434: Ollama API (optional external access for model management)
EXPOSE 8686 11434

WORKDIR /app

# ── Entrypoint ───────────────────────────────────────────────────────────────
ENTRYPOINT ["/usr/local/bin/run.sh"]
