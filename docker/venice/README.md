# Totem LLM — Venice AI Image (Phase 1)

A lean, **no-GPU** Docker image that runs [Totem LLM](https://github.com/fred-terzi/totem-llm)
with **Venice AI** as the sole LLM provider. No Ollama, no local model weights.

> **Status: Phase 1 of the hosted totem infrastructure.**
> Full plan: `planning/hosted-totem-infra.md` (gitignored — not in this repo).
> This is the base image only. The desktop, orchestrator, and key-hiding UX come in later phases.

## What this image is / isn't

| | |
|---|---|
| ✅ Runs totem-llm (server + collector + pre-built frontend) | |
| ✅ LLM locked to **Venice AI** | |
| ✅ Embeddings via local **native** engine (Xenova/all-MiniLM-L6-v2) | |
| ✅ Vector store: **LanceDB** (file-based, zero setup) | |
| ✅ Python 3, Git, ffmpeg, tesseract-ocr included | |
| ✅ ~1.4 GB (vs ~9 GB for the GPU image) | |
| ❌ No Ollama, no GPU, no local LLM inference | |
| ❌ No desktop yet (Phase 2) | |

## Quick start

```bash
# From the repo root (build context is the repo root):
export VENICE_API_KEY=sk-your-venice-key

docker build -f docker/venice/Dockerfile -t totem-venice:latest .
docker run -d --name totem-venice \
  -p 8686:8686 \
  -v totem-data:/app/totem-storage \
  -e VENICE_API_KEY="$VENICE_API_KEY" \
  totem-venice:latest

# Then open http://localhost:8686
```

Or with the included compose file:

```bash
export VENICE_API_KEY=sk-your-venice-key
docker compose -f docker/venice/docker-compose.yml up --build
```

## Running on a different port

Two different "8686"s are in play, and they don't have to collide:

- **Container-internal port** (the *right* side of `-p`, the `SERVER_PORT` inside the container) — always `8686`. This stays fixed so the app, healthcheck, and any internal wiring never need to change.
- **Host port** (the *left* side of `-p`) — the port **you** reach on your own machine. This is the one you change when something else (e.g. a local dev instance) is already using `8686`.

Pick any free host port, e.g. `18686`, and map it to the container's `8686`:

```bash
# docker run — host 18686 → container 8686
docker run -d --name totem-venice \
  -p 18686:8686 \
  -v totem-data:/app/totem-storage \
  -e VENICE_API_KEY="$VENICE_API_KEY" \
  totem-venice:latest

# Then open http://localhost:18686   (NOT :8686)
```

With the compose file, override the mapping without editing the file:

```bash
# Option A: one-off override on the command line
docker compose -f docker/venice/docker-compose.yml up --build \
  --port totem.8686=18686

# Then open http://localhost:18686
```

```yaml
# Option B: a separate compose override file (docker-venice-local.yml)
#   services:
#     totem:
#       ports:
#         - "18686:8686"
#   then run:
#     docker compose -f docker/venice/docker-compose.yml \
#       -f docker-venice-local.yml up --build
```

> **Note for the hosted deployment:** the orchestrator (Phase 3) hands each user
> container its **own** host port (`9001`, `9002`, …) while they all keep `8686`
> internally. The reverse proxy then routes `totem.example/<user>` → that host
> port. The internal port never changes per user — only the host-side mapping does.

## The "completely hidden" key

This is the security model for the hosted deployment:

- `VENICE_API_KEY` is **never** written into the image or the container's
  `/app/totem-storage/.env` file. It exists **only** in the container's
  environment layer, injected at creation time (`docker run -e`).
- The baked `.env` (see `.env.template`) locks `LLM_PROVIDER=venice`,
  `EMBEDDING_ENGINE=native`, `VECTOR_DB=lancedb` — the user cannot switch
  provider — and contains **no key** (only generated JWT/SIG secrets).
- The provider (`server/utils/AiProviders/venice/index.js`) reads the key from
  `process.env.VENICE_API_KEY` at request time.
- If the key is missing, `run.sh` fails fast with a clear message instead of
  letting the app boot and 500 on the first chat.

> Full UI-level hiding (masking the key in the settings panel, preventing
> provider switch in the frontend) is **Phase 4**.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `VENICE_API_KEY` | *(required)* | Injected at creation; **never stored in a file** |
| `VENICE_MODEL_PREF` | `zai-org-glm-5-1` | Any [Venice model slug](https://venice.ai/docs) |
| `VENICE_MAX_TOKENS` | `1024` | Max output tokens |
| `SERVER_PORT` | `8686` | UI + API |
| `COLLECTOR_PORT` | `8888` | Internal only — don't expose to the internet |
| `TOTEM_STORAGE_DIR` | `/app/totem-storage` | Mount a volume here to persist data |

## Build notes

- Base: `node:18-slim`. Installs the published `totem-llm` npm package
  (frontend pre-built, Prisma client generated via postinstall).
- `.env` is created from `.env.template` with `sed` replacing the secret
  placeholders (heredocs don't work in a Dockerfile `RUN` under dash).
  `.dockerignore` whitelists `.env.template` so it reaches the build context.
- Healthcheck reuses `docker/docker-healthcheck.sh` (checks `/api/ping`).
