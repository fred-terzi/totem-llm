# Totem LLM — Docker

Totem LLM ships as a single Docker container that includes both the app (via the `totem-llm` npm package) and Ollama (for local LLM + embedding inference with GPU acceleration).

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Container                                               │
│                                                         │
│  ┌───────────────┐         ┌────────────────────────┐  │
│  │  Totem LLM    │  calls  │      Ollama            │  │
│  │  (node:18)    │────────►│  (GPU inference)       │  │
│  │  :8686        │  :11434 │  auto-detects CUDA     │  │
│  └───────────────┘         └────────────────────────┘  │
│                                                         │
│  run.sh (entrypoint):                                   │
│    1. Detects GPU via nvidia-smi                        │
│    2. Selects model + quant + context from tier table   │
│    3. Pulls model if not already on disk                │
│    4. Starts Ollama (background)                        │
│    5. Launches totem-llm (foreground, PID 1)            │
└─────────────────────────────────────────────────────────┘
```

## Model Selection

The container automatically selects the best model based on available GPU VRAM:

| VRAM (total) | Model | Quant | Context | Typical GPU |
|---|---|---|---|---|
| CPU only | `qwen3.5:9b` | Q4_K_M | 4 096 | — |
| 1 – 15 GB | `qwen3.5:9b` | Q4_K_M | 8 192 | T4, RTX 3060 |
| 16 – 23 GB | `qwen3.5:9b-q8_0` | Q8_0 | 16 384 | T4, L4, A10G |
| 24 – 31 GB | `qwen3.8:27b-mtp-q4_K_M` | Q4_K_M | 8 192 | A10G, L4 |
| 32 – 39 GB | `qwen3.8:27b-mtp-q4_K_M` | Q4_K_M | 32 768 | A100 40 GB |
| 40 – 79 GB | `qwen3.8:27b-mtp-q8_0` | Q8_0 | 32 768 | A100 80 GB |
| 80+ GB | `qwen3.8:27b-mtp-q8_0` | Q8_0 | 131 072 | 2×H100, B200 |

**Embedding model** (all tiers): `nomic-embed-text` (274 MB)

> Multi-GPU: VRAM is summed across all visible GPUs. Ollama splits layers automatically.

## Quick Start (Local)

```bash
# Build the image (from repo root)
docker build --platform linux/amd64 -f docker/Dockerfile -t totem-llm:latest .

# Run with GPU access
docker run -d --rm \
    --name totem \
    --gpus all \
    -p 8686:8686 \
    -p 11434:11434 \
    -v totem-data:/app/totem-storage \
    -v ollama-models:/root/.ollama \
    totem-llm:latest

# Or without GPU (CPU mode)
docker run -d --rm \
    --name totem \
    -p 8686:8686 \
    -v totem-data:/app/totem-storage \
    -v ollama-models:/root/.ollama \
    totem-llm:latest
```

Then open http://localhost:8686

## Docker Compose (Local)

```bash
docker compose -f docker/docker-compose.yml up --build
```

## Runpod Template

For deploying as a Runpod pod template, see [RUNPOD.md](./RUNPOD.md).

## Environment Variables

### Runtime (set via `docker run -e` or Runpod template config)

| Variable | Default | Description |
|---|---|---|
| `TOTEM_MODEL_OVERRIDE` | _(auto)_ | Force a specific Ollama model tag (skips GPU detection) |
| `TOTEM_CONTEXT_OVERRIDE` | _(auto)_ | Force context window in tokens (used with `TOTEM_MODEL_OVERRIDE`) |
| `AUTH_TOKEN` | _(none)_ | Set a password for the app (required for remote access) |
| `SERVER_PORT` | `8686` | Port for the Totem UI/API |
| `COLLECTOR_PORT` | `8888` | Port for the Collector service |
| `OLLAMA_KEEP_ALIVE_TIMEOUT` | `3600` | Seconds before Ollama unloads idle models |
| `OLLAMA_RESPONSE_TIMEOUT` | `3600000` | Max ms to wait for an Ollama response |
| `AGENT_MAX_TOOL_CALLS` | _(none)_ | Max tool calls per agent response |

### Internal (managed by run.sh — do not override)

| Variable | Value |
|---|---|
| `LLM_PROVIDER` | `ollama` |
| `OLLAMA_BASE_PATH` | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL_PREF` | GPU-detected model tag |
| `OLLAMA_MODEL_TOKEN_LIMIT` | GPU-detected context window |
| `EMBEDDING_ENGINE` | `ollama` |
| `EMBEDDING_BASE_PATH` | `http://127.0.0.1:11434` |
| `EMBEDDING_MODEL_PREF` | `nomic-embed-text:latest` |
| `VECTOR_DB` | `lancedb` |
| `TOTEM_STORAGE_DIR` | `/app/totem-storage` |

## Volumes

| Mount Path | Contents | Persistence |
|---|---|---|
| `/app/totem-storage` | SQLite DB, documents, vector cache, logs, secrets | **Required** for data persistence |
| `/root/.ollama` | Ollama model weights (5–45 GB) | Optional (pre-baked models survive without it; runtime-pulled models need it) |

## Pulling Additional Models

Once the container is running, you can pull any Ollama model:

```bash
docker exec -it totem ollama pull llama3.1:8b
docker exec -it totem ollama list
```

Then select it from the Totem UI → Workspace Settings → LLM Selection.

## Troubleshooting

### "No NVIDIA GPU detected"

The container runs in CPU mode. This happens when:
- Running without `--gpus all` flag
- Runpod pod has no GPU allocated
- `nvidia-smi` is not in the container's PATH

### Model not loading

Check Ollama logs:
```bash
docker logs totem 2>&1 | grep -i ollama
cat /tmp/ollama.log  # inside container
```

### Out of memory / OOM

The selected model may be too large for the available VRAM. Force a smaller model:
```bash
docker run ... -e TOTEM_MODEL_OVERRIDE=qwen3.5:9b -e TOTEM_CONTEXT_OVERRIDE=8192 ...
```

### Slow first response

The first inference after model load compiles CUDA kernels. Subsequent responses are faster. This is normal.
