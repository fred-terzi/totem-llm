# ──────────────────────────────────────────────────────────────────────────────
# Totem LLM — Venice AI Base Image (Phase 1)
#
# Purpose:
#   A lean, no-GPU Docker image that runs Totem LLM with Venice AI as the
#   sole LLM provider. No Ollama, no local model weights, no GPU.
#
# Key design decisions:
#   • LLM_PROVIDER=venice is locked in the pre-created .env — the user
#     (or operator) cannot switch to another provider at runtime.
#   • VENICE_API_KEY is NEVER baked into the image or the .env file.
#     It is injected at container creation time via:
#         docker run -e VENICE_API_KEY=...
#     This means the key lives in the container's environment layer,
#     not in any file the user can read.
#   • EMBEDDING_ENGINE=native uses a small local model (Xenova/all-MiniLM-L6-v2)
#     downloaded on first run. No external embedding API needed.
#   • VECTOR_DB=lancedb is a zero-setup, file-based vector store.
#
# Target:
#   • Hetzner VPS (CPU-only, no GPU)
#   • Local dev/testing via docker compose
#   • Per-user containers in the hosted totem infrastructure
#
# Image size: ~700 MB – 1.2 GB (vs ~9 GB for the GPU image)
# ──────────────────────────────────────────────────────────────────────────────

FROM node:18-slim AS base

# ── Build args ───────────────────────────────────────────────────────────────
ARG TOTEM_LLM_VERSION=latest

# ── System dependencies ──────────────────────────────────────────────────────
# Required for:
#   • Chromium/Puppeteer libs  — web-scraping agent plugin
#   • ffmpeg                   — audio/video transcription
#   • tesseract-ocr            — OCR for scanned documents
#   • python3 + pip            — general scripting, some npm native deps
#   • git                      — version control, some tooling
#   • curl, ca-certificates    — HTTPS API calls (Venice, HuggingFace)
#   • xdg-utils                — desktop integration
#
# NOT included (vs GPU image):
#   • Ollama (no local LLM inference)
#   • nvidia-smi / CUDA (no GPU)
RUN apt-get update --yes && \
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        curl ca-certificates gnupg zstd \
        python3 python3-pip \
        git \
        libasound2 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
        libexpat1 libfontconfig1 libglib2.0-0 libgtk-3-0 libnspr4 \
        libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
        libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
        libxrender1 libxss1 libxtst6 libnss3 \
        xdg-utils \
        ffmpeg tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# ── Install totem-llm globally ───────────────────────────────────────────────
# The npm package postinstall script (scripts/postinstall.mjs) handles:
#   • npm install --production in server/
#   • npm install --production in collector/
#   • npx prisma generate (platform-specific client)
# The frontend is pre-built in the npm tarball (prepublishOnly at publish).
#
# The Venice AI provider (server/utils/AiProviders/venice/) is included in
# the npm package. It reads VENICE_API_KEY from process.env at runtime.
RUN npm install -g "totem-llm@${TOTEM_LLM_VERSION}" --legacy-peer-deps --no-audit --no-fund

# ── Runtime environment defaults ─────────────────────────────────────────────
# LLM_PROVIDER=venice     — locked to Venice AI (no Ollama, no other provider)
# EMBEDDING_ENGINE=native — local embedding model (Xenova/all-MiniLM-L6-v2)
# VECTOR_DB=lancedb       — zero-setup file-based vector store
#
# NOTE: VENICE_API_KEY is intentionally NOT set here.
#       It is injected at container creation time via `docker run -e`.
#       This keeps the key out of the image and out of any .env file,
#       making it invisible to the end user.
#
# NOTE: VENICE_MODEL_PREF is intentionally NOT set here.
#       It can be set via Docker env at container creation time.
#       Defaults to the provider's built-in default (zai-org-glm-5-1).
ENV NODE_ENV=production \
    TOTEM_STORAGE_DIR=/app/totem-storage \
    SERVER_PORT=8686 \
    COLLECTOR_PORT=8888 \
    LLM_PROVIDER=venice \
    EMBEDDING_ENGINE=native \
    VECTOR_DB=lancedb \
    DISABLE_TELEMETRY=true

# ── Pre-create storage dir + .env ────────────────────────────────────────────
# lib/setup.js generates a .env on first run IF it doesn't already exist.
# By pre-creating it here we:
#   • Lock LLM_PROVIDER=venice (user cannot switch to Ollama or other)
#   • Lock EMBEDDING_ENGINE=native (no external embedding API needed)
#   • Lock VECTOR_DB=lancedb (zero-setup, file-based)
#   • Provide valid secrets so the app works without first-run generation
#   • Explicitly NOT include VENICE_API_KEY (comes from Docker env)
#
# The .env file has HIGHER priority than process.env in lib/config.js#getEnv().
# This is a feature: it locks the provider configuration. The Venice API key
# is NOT in the .env, so it reads from process.env (Docker env) — which is
# set by the orchestrator at container creation time.
#
# Approach: COPY a template file, then sed-replace the secret placeholders.
# (Heredocs don't work in Dockerfile RUN because /bin/sh is dash on slim.
#  Multi-line bash -c in a RUN instruction is not a valid Dockerfile instruction.)
COPY docker/venice/.env.template /tmp/.env.template
RUN mkdir -p /app/totem-storage && \
    SJ=$(openssl rand -hex 24) && \
    SK=$(openssl rand -hex 32) && \
    SS=$(openssl rand -hex 32) && \
    sed -e "s|__JWT_SECRET__|${SJ}|" -e "s|__SIG_KEY__|${SK}|" -e "s|__SIG_SALT__|${SS}|" /tmp/.env.template > /app/totem-storage/.env && \
    rm /tmp/.env.template && \
    echo "--- .env created (secrets replaced, key intentionally absent) ---" && \
    cat /app/totem-storage/.env

# ── Startup script ───────────────────────────────────────────────────────────
COPY docker/venice/run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh

# ── Healthcheck ──────────────────────────────────────────────────────────────
# Reuse the existing healthcheck script (checks /api/health)
COPY docker/docker-healthcheck.sh /usr/local/bin/docker-healthcheck.sh
RUN chmod +x /usr/local/bin/docker-healthcheck.sh
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s \
    CMD /usr/local/bin/docker-healthcheck.sh || exit 1

# ── Ports ────────────────────────────────────────────────────────────────────
# 8686: Totem LLM UI + API (the only port the user interacts with)
# 8888: Collector service (internal, should NOT be exposed to the internet)
EXPOSE 8686

WORKDIR /app

# ── Entrypoint ───────────────────────────────────────────────────────────────
ENTRYPOINT ["/usr/local/bin/run.sh"]
