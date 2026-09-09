# Totem LLM

**Self-hosted AI chat with local LLM inference. One click. No API keys. Your data stays on your GPU.**

## What you get

- **Chat UI** — multi-workspace knowledge base chat with RAG (upload PDFs, DOCX, audio/video → auto-chunked + embedded)
- **Local LLM** — Ollama-powered inference, auto-selects the best model for your GPU
- **Agent Mode** — tool-use agent (terminal, filesystem, web-scraping, file creation)
- **OpenAI-Compatible API** — drop-in replacement at `/api/api/openai/v1/chat/completions`
- **Multi-User** — role-based auth, invite codes, per-workspace access

## Quick Start

1. **Deploy** — pick your GPU, click Deploy, wait ~30s
2. **Set your password** — the only required onboarding step
3. **Chat** — or upload documents for RAG, or grab an API key

## GPU Sizing

| VRAM | Auto-selected model | Speed |
|---|---|---|
| 12 GB | qwen3.5:9b | ~20 tok/s |
| 16 GB | qwen3.8:27b (Q4) | ~10 tok/s |
| 32 GB | qwen3.8:27b (Q6) | ~14 tok/s |
| 80+ GB | qwen3.8:32b (Q8) | ~18 tok/s |

Override with env: `OLLAMA_MODEL_PREF=llama3.1:70b`

## Key Config

| Env Var | Purpose |
|---|---|
| `OLLAMA_MODEL_PREF` | Force a specific model |
| `OLLAMA_NUM_PARALLEL` | Concurrent LLM slots (default 1) |
| `AUTH_TOKEN` | Pre-set admin password (skip onboarding) |
| `TOTEM_STORAGE_DIR` | Data directory — **mount a RunPod volume here for persistence** |

## Important

- **Persistence:** Mount a RunPod Volume at `/app/totem-storage` or all data (workspaces, docs, chats) is lost on pod destroy.
- **Ports:** 8686 (main app), 11434 (Ollama API)
- **Image:** `fredterzi/totem-llm:latest` (~9 GB, pre-baked with qwen3.5:9b + nomic-embed-text)

## API Example

```python
from openai import OpenAI
client = OpenAI(
    base_url="https://<your-pod>.runpod.net/api/api/openai/v1",
    api_key="your-totem-api-key",
)
resp = client.chat.completions.create(
    model="qwen3.5:9b",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

---

**Source:** [github.com/fred-terzi/totem-llm](https://github.com/fred-terzi/totem-llm) · Fork of [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)
