# ──────────────────────────────────────────────────────────────────────────────
# Totem LLM — Hosted Multi-User Platform
#
# Builds from source with the "hosted" feature profile baked in at build time:
#   • Multi-user mode        ON
#   • Agent mode             ON  (web scraping, browsing, CoinGecko MCP)
#   • MCP servers            ON
#   • Memories               ON
#   • Terminal access        OFF
#   • Filesystem agent       OFF
#   • LLM providers          Venice only
#   • Model router           ON
#   • Scheduled jobs         ON
#
# No Ollama, no GPU, no local models. All LLM calls go to Venice via the
# master key in the server .env.
#
# Build:
#   docker build -f docker/hosted/Dockerfile -t totem-hosted .
#
# Run:
#   docker compose -f docker/hosted/docker-compose.yml up --build
# ──────────────────────────────────────────────────────────────────────────────

FROM node:18-slim AS base

# ── System dependencies ──────────────────────────────────────────────────────
# Required for:
#   • Chromium/Puppeteer  — web-scraping agent plugin
#   • ffmpeg              — audio transcription
#   • tesseract-ocr       — OCR for PDF/image parsing
#   • basic utilities
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

# ── Runtime environment ──────────────────────────────────────────────────────
ENV NODE_ENV=production \
    TOTEM_BUILD_PROFILE=hosted \
    TOTEM_STORAGE_DIR=/app/totem-storage \
    SERVER_PORT=8686 \
    COLLECTOR_PORT=8888 \
    LLM_PROVIDER=venice \
    VECTOR_DB=lancedb \
    DISABLE_TELEMETRY=true

# ── Copy source ──────────────────────────────────────────────────────────────
WORKDIR /app
COPY . .

# ── Install all dependencies ─────────────────────────────────────────────────
RUN cd server    && yarn install --no-audit --no-fund && \
    cd ../collector && yarn install --no-audit --no-fund && \
    cd ../frontend  && yarn install --no-audit --no-fund

# ── Build frontend with hosted profile ───────────────────────────────────────
# TOTEM_BUILD_PROFILE=hosted is read by totem.features.cjs → resolveFeatures()
# and baked into the bundle as __TOTEM_FEATURES__ via Vite's `define`.
# This is a BUILD-TIME decision — the resulting JS bundle has the flags
# compiled in. Terminal access and filesystem agent UI will not render.
RUN cd frontend && yarn build

# ── Copy frontend dist to server/public ──────────────────────────────────────
# The server serves static files from server/public/ in production.
RUN rm -rf server/public && cp -R frontend/dist server/public

# ── Generate Prisma client (platform-specific) ───────────────────────────────
RUN cd server && npx prisma generate --schema=./prisma/schema.prisma

# ── Pre-create storage dir + .env ────────────────────────────────────────────
# lib/setup.js generates a .env on first run IF it doesn't already exist.
# We pre-create it here to:
#   • Ensure LLM_PROVIDER=venice (not ollama or native)
#   • Provide valid secrets so the app works without first-run generation
#   • Set storage dir to a consistent path
RUN mkdir -p /app/totem-storage && \
    SECRET_KEY=$(openssl rand -hex 32) && \
    SECRET_SALT=$(openssl rand -hex 32) && \
    SECRET_JWT=$(openssl rand -hex 24) && \
    cat > /app/totem-storage/.env << ENVFILE
# Totem LLM — Hosted platform configuration
# Generated at image build time.

STORAGE_DIR="/app/totem-storage"
SERVER_PORT=8686
COLLECTOR_PORT=8888

# Security secrets (auto-generated at build time)
JWT_SECRET="${SECRET_JWT}"
SIG_KEY="${SECRET_KEY}"
SIG_SALT="${SECRET_SALT}"

# LLM Provider — Venice (injected via env at runtime)
LLM_PROVIDER=venice
# VENICE_API_KEY=              ← set at runtime via docker-compose or docker run -e

# Embedding — Venice
EMBEDDING_ENGINE=venice
# EMBEDDING_MODEL_PREF=        ← set at runtime

# Vector database (file-based, zero-config)
VECTOR_DB=lancedb

# Telemetry
DISABLE_TELEMETRY=true
ENVFILE

# ── Ports ────────────────────────────────────────────────────────────────────
# 8686: Totem LLM UI + API
# 8888: Collector (internal only, not exposed)
EXPOSE 8686

# ── Entrypoint ───────────────────────────────────────────────────────────────
# totem-llm (lib/launcher.js) spawns server + collector as child processes,
# handles graceful shutdown, and prints the startup banner.
CMD ["node", "bin/totem-llm.js"]
