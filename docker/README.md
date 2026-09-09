# Totem LLM — RunPod Template

**Self-hosted AI chat with local LLM inference. Zero configuration. One click.**

---

## What You Get

A fully running [Totem LLM](https://github.com/fred-terzi/totem-llm) instance with:

| Component | Details |
|---|---|
| **Chat UI** | Multi-workspace knowledge base chat (fork of AnythingLLM) |
| **Local LLM** | Ollama-powered inference — no API keys, no cloud, no data leaves your GPU |
| **RAG Pipeline** | Upload PDFs, DOCX, XLSX, PPTX, EPUB, audio/video → automatic chunking + embedding |
| **Agent Mode** | Tool-use agent with filesystem, terminal, web-scraping, file creation plugins |
| **OpenAI-Compatible API** | Drop-in replacement at `/api/api/openai/v1/chat/completions` |
| **Multi-User** | Role-based auth (admin/default), invite codes, per-workspace access |
| **Scheduled Jobs** | Cron-based agent workflows |
| **Embeddable Widget** | Domain-allowlisted chat widget for your website |

## Quick Start

### 1. Deploy

1. Go to [RunPod](https://www.runpod.io/console/templates)
2. Find **Totem LLM** (or import from `fredterzi/totem-llm:latest`)
3. Pick your GPU (see [GPU Sizing](#gpu-sizing) below)
4. Click **Deploy**
5. Wait ~30 seconds for the container to start
6. Open the public URL RunPod gives you

### 2. First-Run Onboarding

You'll see the Totem LLM onboarding flow:

1. **Set your admin password** — this is your only required step
2. **Choose your LLM** — auto-selected based on your GPU (or override)
3. **Create a workspace** — name it, set a system prompt, upload documents
4. **Chat** — that's it

### 3. Upload Documents (Optional)

Go to your workspace → **Add Content** → drag in files or paste URLs. Supported:

- PDF, DOCX, XLSX, PPTX, EPUB
- Markdown, HTML, plain text, code files
- Audio/Video (auto-transcribed)
- Web URLs (scraped → extracted → chunked)

Documents are chunked, embedded via `nomic-embed-text`, and stored in LanceDB. Chat responses cite sources from your documents.

---

## GPU Sizing

The container auto-detects your GPU and selects the best model that fits. You don't need to configure anything — but here's what to expect:

| GPU | VRAM | Auto-Selected Model | Speed (approx.) |
|---|---|---|---|
| RTX 3060 / T4 | 12 GB | `qwen3.5:9b` (Q8_0) | ~20 tok/s |
| RTX 4000 Ada / A4000 | 16 GB | `qwen3.8:27b-mtp-q4_K_M` (Q4_K_M) | ~8-12 tok/s |
| 2× A4000 | 32 GB | `qwen3.8:27b-mtp-q4_K_M` (Q6_K) | ~10-14 tok/s |
| A100 40GB | 40 GB | `qwen3.8:32b` (Q4_K_M) | ~12-16 tok/s |
| A100 80GB / H100 | 80+ GB | `qwen3.8:32b` (Q8_0) | ~15-20 tok/s |

> **Minimum recommended:** 16 GB VRAM (single GPU). 12 GB works but you're limited to 9B models.

### Overriding the Model

If you want a specific model, set this environment variable in your RunPod template config:

```
OLLAMA_MODEL_PREF=qwen3.8:27b-mtp-q4_K_M
```

Or any valid [Ollama model](https://ollama.com/library):

```
OLLAMA_MODEL_PREF=llama3.1:70b
OLLAMA_MODEL_PREF=mistral:24b
OLLAMA_MODEL_PREF=deepseek-r1:14b
```

The container will pull it on first start (subsequent starts use the cached copy).

---

## Ports & Endpoints

| Port | Service | Purpose |
|---|---|---|
| **8686** | Totem LLM | Web UI + REST API |
| **11434** | Ollama | Raw LLM inference API (if you need it) |

### Key API Endpoints

```bash
# Health check
GET https://<your-pod>/api/health

# OpenAI-compatible chat (use this in any OpenAI SDK)
POST https://<your-pod>/api/api/openai/v1/chat/completions
#   Authorization: Bearer <your-api-key>
#   Body: { "model": "qwen3.5:9b", "messages": [{"role":"user","content":"Hello"}] }

# Create API key
POST https://<your-pod>/api/api/auth/token
#   Body: { "email": "admin@totem.local", "password": "<your-password>" }
```

### Using with OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-pod-address.runpod.net/api/api/openai/v1",
    api_key="totem-api-key-from-dashboard",
)

response = client.chat.completions.create(
    model="qwen3.5:9b",
    messages=[{"role": "user", "content": "Explain quantum computing in one paragraph."}],
)
print(response.choices[0].message.content)
```

### Using with curl

```bash
curl https://<your-pod>/api/api/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <api-key>" \
  -d '{
    "model": "qwen3.5:9b",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

---

## Configuration (Environment Variables)

All optional — sensible defaults are baked in. Set these in your RunPod template's **Environment Variables** section:

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_MODEL_PREF` | *(auto-detected)* | Force a specific Ollama model |
| `OLLAMA_NUM_PARALLEL` | `1` | Concurrent LLM slots (raise to 4+ for multi-user) |
| `OLLAMA_CONTEXT_LENGTH` | `8192` | Context window size (raise to 32768 with 32+ GB VRAM) |
| `AUTH_TOKEN` | *(auto-generated)* | Pre-set admin password (skip onboarding) |
| `ENABLE_MULTI_USER` | `false` | Enable multi-user mode with per-user accounts |
| `SERVER_PORT` | `8686` | Change if RunPod requires a specific port |
| `TOTEM_STORAGE_DIR` | `/app/totem-storage` | Where DB, uploads, and secrets live (use a RunPod volume for persistence) |

### Persistence (Important)

By default, your data (workspaces, documents, chat history, settings) lives in the container filesystem and **will be lost when the pod is destroyed**.

To persist data:
1. Create a **RunPod Volume** (e.g. 50 GB SSD)
2. Mount it at `/app/totem-storage`
3. Set `TOTEM_STORAGE_DIR=/app/totem-storage` (already the default)

This preserves your SQLite DB, uploaded documents, vector cache, and generated files across pod restarts.

---

## Template Configuration (for the Template Author)

When creating the RunPod template, use these settings:

| Setting | Value |
|---|---|
| **Image** | `fredterzi/totem-llm:latest` |
| **Registry Auth** | None (public Docker Hub) |
| **Start Command** | *(leave blank — entrypoint handles everything)* |
| **Ports** | `8686` (primary), `11434` (optional, for direct Ollama access) |
| **Disk** | 100 GB (pre-baked model is ~6 GB; extra room for runtime pulls + user uploads) |
| **GPU** | A4000 / 3090 / 4090 / A100 / H100 (anything with 12+ GB VRAM) |
| **Volume** | 50 GB (for persistent storage) |

---

## Troubleshooting

### Container starts but page is blank

- Wait 60-90 seconds. First startup initializes the database and generates secrets.
- Check RunPod logs: look for `[totem] Server ready on port 8686`
- If you see `EADDRINUSE`, the port is already in use — remap in template config.

### Model takes too long to load

- 27B models on 16 GB VRAM will offload some layers to CPU. Expect 30-60s first-token.
- For faster inference, use a 32+ GB GPU or switch to a 9B model via `OLLAMA_MODEL_PREF=qwen3.5:9b`.

### "Model not found" error

The container auto-selects a model based on VRAM. If you're on a very small GPU (< 12 GB), it falls back to `qwen3.5:9b` which should always be available (pre-baked in the image). If you see a download progress bar, the model wasn't cached — this means either:
- You set `OLLAMA_MODEL_PREF` to a model not in the image (expected — it downloads on first use)
- The container was built without the model (check Docker Hub image size — should be ~9 GB)

### API returns 401

You need an API key. Create one in the web UI: **Settings → API Keys → Create**. Then use `Authorization: Bearer <key>` header.

### Out of memory / OOM kill

Your GPU doesn't have enough VRAM for the selected model + context. Fix:
```
OLLAMA_MODEL_PREF=qwen3.5:9b
OLLAMA_CONTEXT_LENGTH=4096
```

---

## What's Pre-Baked in the Image

| Model | Size | Purpose |
|---|---|---|
| `qwen3.5:9b` (Q4_K_M) | ~5.5 GB | Default LLM (CPU tier + 12-15 GB GPU) |
| `nomic-embed-text` | ~274 MB | Embedding model for RAG |

Other models (27B, 32B, etc.) are **pulled on demand** at runtime when your GPU tier requires them. First pull takes 2-5 minutes depending on model size and RunPod's network speed.

---

## Image Details

| | |
|---|---|
| **Registry** | `docker.io/fredterzi/totem-llm` |
| **Tags** | `latest` (rolling), `0.17.0` (pinned) |
| **Base** | `node:18-slim` + Ollama + system deps (tesseract, ffmpeg, GTK libs) |
| **Size** | ~9 GB (with pre-baked models) |
| **Entrypoint** | `/usr/local/bin/run.sh` — GPU detect → start Ollama → start server |
| **Healthcheck** | `/api/health` every 30s |
| **Node.js** | v18.18.0 |
| **LLM Runtime** | Ollama (CUDA, multi-GPU aware) |

---

## License & Attribution

Totem LLM is a fork of [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) by Mintplex Labs. This template is provided as-is for self-hosted, personal, or team use. Your data stays on your GPU — nothing is sent to any external service unless you configure external LLM providers.

**Source:** [github.com/fred-terzi/totem-llm](https://github.com/fred-terzi/totem-llm)
