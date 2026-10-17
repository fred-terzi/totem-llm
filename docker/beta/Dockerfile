# ──────────────────────────────────────────────────────────────────────────────
# Totem LLM — Beta (source) image
#
# Purpose:
#   A lightweight, single-container image that CLONES the source repo at
#   container-start (not build time) so we always test the latest
#   `dev-totem` branch before publishing to npm.
#
# Why runtime clone (vs. build-time)?
#   • The repo is small and `yarn setup` is idempotent.
#   • `yarn dev:all` gives us the dev-mode debug prints (nodemon hot-reload,
#     Vite HMR, unminified logs) that the published npm package does not.
#   • A single image serves any branch — just change the REPO_BRANCH env.
#
# Architecture inside the container:
#   ┌────────────────────────────────────────────────────────────────┐
#   │  cloudflared  ──►  Vite dev (13000) ──proxy──►  Express (28686) │
#   │                                                │                │
#   │                                                └──► Collector (28888)
#   └────────────────────────────────────────────────────────────────┘
#
# The Vite dev server is the entry point because it:
#   1. Serves the React UI with HMR
#   2. Proxies /api → Express (per vite.config.js)
#   3. Proxies WebSocket (ws: true) for agent streaming
#
# Build:
#   docker build -f docker/beta/Dockerfile -t totem-llm-beta .
#
# Run (via compose):
#   docker compose -f docker/beta/docker-compose.yml up --build
#
# Or direct:
#   docker run --name totem-llm-beta -p 13000:13000 \
#       -v totem-beta-work:/app -v totem-beta-data:/app/totem-storage \
#       totem-llm-beta
#
# The container's stdout includes:
#   • Setup / install progress
#   • The Cloudflare temp URL (highlighted)
#   • All of `yarn dev:all`'s debug output (server, collector, frontend)
# ──────────────────────────────────────────────────────────────────────────────

FROM node:24-slim AS base

# ── System dependencies ──────────────────────────────────────────────────────
# Same set as the other Dockerfiles (Chromium libs, ffmpeg, tesseract, git).
# We do NOT install Ollama — beta testing runs against whatever LLM provider
# is configured in the .env (or the user sets at runtime via env vars).
RUN apt-get update --yes && \
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        curl ca-certificates gnupg zstd git \
        libasound2 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
        libexpat1 libfontconfig1 libglib2.0-0 libgtk-3-0 libnspr4 \
        libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
        libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
        libxrender1 libxss1 libxtst6 libnss3 \
        xdg-utils ffmpeg tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# ── cloudflared (for the temp tunnel) ────────────────────────────────────────
# We install it in the image so the container is self-contained.
# `cloudflared tunnel --url <target>` (quick tunnel) requires no account and
# produces a random https://<sub>.trycloudflare.com URL that is valid until
# the container stops.
RUN curl -fsSL -o /usr/local/bin/cloudflared \
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" \
    && chmod +x /usr/local/bin/cloudflared \
    && cloudflared --version

# ── Yarn classic (via corepack, bundled with Node 18) ────────────────────────
# The repo's package.json uses yarn v1 (classic). corepack ships with node:18.
# We set `ignore-engines=true` as a Yarn config so every `yarn install`
# (root, server, collector, frontend) skips the Node version check — the
# root package.json devDeps (e.g. @babel/core@8) declare an engines range
# newer than the pinned Node 18 runtime, but they work fine at runtime
# for the subset of the code the dev:all flow actually touches.
RUN corepack enable && corepack prepare yarn@1.22.22 --activate \
    && yarn config set ignore-engines true --global \
    && yarn --version

# ── Runtime environment defaults ─────────────────────────────────────────────
# NODE_ENV=development  → server/index.js loads server/.env.development
#                         and bypasses auth (per validatedRequest.js)
# TOTEM_BUILD_PROFILE=source → Vite bakes the full-feature flag set into the
#                              bundle (terminal access, agent mode, etc.).
#                              See AGENTS.md "Frontend Build" section.
#
# Ports mirror the root package.json `dev:all` script:
#   SERVER_PORT=28686, COLLECTOR_PORT=28888, FRONTEND_PORT=13000
#
# REPO_* — overridable so you can point at a fork or a different branch.
ENV NODE_ENV=development \
    TOTEM_BUILD_PROFILE=source \
    TOTEM_STORAGE_DIR=/app/totem-storage \
    SERVER_PORT=28686 \
    COLLECTOR_PORT=28888 \
    FRONTEND_PORT=13000 \
    REPO_URL=https://github.com/fred-terzi/totem-llm.git \
    REPO_BRANCH=dev-totem \
    REPO_DIR=/app/repo \
    TUNNEL_TARGET=http://localhost:13000 \
    DISABLE_TELEMETRY=true

WORKDIR /app

# ── Entrypoint ───────────────────────────────────────────────────────────────
# run.sh performs: clone → checkout → yarn install + setup → start dev:all
# in the foreground, with cloudflared in the background. It also greps the
# cloudflared log for the temp URL and prints it prominently to stdout.
COPY docker/beta/run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh

# ── Ports ────────────────────────────────────────────────────────────────────
# 13000: Vite dev server (the user-facing entry point, also proxies /api)
# 28686: Express server (direct access for debugging)
# 28888: Collector (internal — server talks to it; exposed for debugging)
EXPOSE 13000 28686 28888

ENTRYPOINT ["/usr/local/bin/run.sh"]
