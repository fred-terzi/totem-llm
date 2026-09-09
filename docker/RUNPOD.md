# Totem LLM — RunPod Template

Deploy Totem LLM as a one-click RunPod template. Users pick a GPU, click Deploy, and get a working AI assistant with the best model for their hardware — no configuration needed.

## Prerequisites

- A **Docker Hub** account with the image published: `fredterzi/totem-llm`
- A **RunPod** account (free tier works for testing)
- The npm package published: `npm view totem-llm version`

## One-Time Setup: Create the Template

### 1. Go to RunPod Templates

Navigate to: **https://www.runpod.io/console/templates**

Click **"Create Template"**.

### 2. Fill in the Template Details

| Field | Value |
|---|---|
| **Template Name** | `Totem LLM` |
| **Description** | `Self-hosted AI assistant with GPU-accelerated LLM inference. Auto-selects the best model for your GPU. Includes RAG, agent mode, and multi-model support.` |
| **Container Image** | `fredterzi/totem-llm:latest` |
| **Public** | ✅ Yes (so others can find it) |
| **Tags** | `ai`, `llm`, `chat`, `rag`, `ollama`, `qwen` |

### 3. Container Configuration

| Setting | Value | Notes |
|---|---|---|
| **Container Disk** | `80 GB` | Models can be 40+ GB for 70B-class. 80 GB is safe. |
| **SSH Access** | ✅ Enabled | Port 22 — built into the base image |
| **Expose HTTP Ports** | `8686` | Totem UI + API (the main port users access) |
| **Expose HTTP Ports** | `11434` | Ollama API (optional — for advanced users who want to use Ollama directly) |
| **Expose TCP Ports** | `22` | SSH (if not auto-added by the SSH toggle) |

### 4. Environment Variables (Optional Defaults)

You can set template-level env vars that apply to all deployments:

| Variable | Value | Purpose |
|---|---|---|
| `AUTH_TOKEN` | _(leave blank)_ | If set, users must enter this password to access the UI. Blank = no auth (single-user). |
| `OLLAMA_KEEP_ALIVE_TIMEOUT` | `86400` | Keep models loaded for 24 hours (default is 5 min — too aggressive for interactive use). |

> **Do NOT set** `OLLAMA_MODEL_PREF` or `OLLAMA_MODEL_TOKEN_LIMIT` here — the container auto-detects the GPU and picks the right model.

### 5. GPU Options (shown to the user at deploy time)

RunPod automatically shows all available GPU types. You can add notes:

| GPU | VRAM | Auto-selected Model | Best For |
|---|---|---|---|
| **T4** | 16 GB | `qwen3.5:9b-q8_0` (16K ctx) | Lightweight, fast startup |
| **L4** | 24 GB | `qwen3.5:9b-q8_0` (16K ctx) | Lightweight, faster than T4 |
| **A10G** | 24 GB | `qwen3.8:27b` (8K ctx) | Best value — 27B model |
| **A100 40GB** | 40 GB | `qwen3.8:27b` (32K ctx) | Large context, 27B |
| **A100 80GB** | 80 GB | `qwen3.8:27b-q8_0` (32K ctx) | Full precision, long context |
| **H100** | 80 GB | `qwen3.8:27b-q8_0` (128K ctx) | Maximum context window |

> The model is auto-selected at startup based on detected VRAM. Users can override in the UI (Workspace Settings → LLM Selection) or via env var.

### 6. Save and Test

After saving the template:

1. Click **"Deploy"**
2. Pick a GPU (T4 for cheapest testing)
3. Wait ~30-60 seconds for the pod to start
4. Open the **HTTP URL** shown in the pod details:
   ```
   https://[POD_ID]-8686.proxy.runpod.net
   ```
5. You should see the Totem LLM onboarding flow

### 7. Publish to Marketplace (Optional)

If you want others to discover it:

1. Go to **Templates → Your Template → Settings**
2. Toggle **"Publish to Marketplace"**
3. Add a screenshot of the UI
4. Write a short description:
   > "Totem LLM is a self-hosted AI assistant that runs entirely on your GPU. No API keys, no data leaves your pod. Features: RAG chat with document upload, agent mode with tool use, multi-workspace knowledge bases, and OpenAI-compatible API. The container auto-selects the best Qwen model for your GPU — from 9B on a T4 to full-precision 27B on an A100."

---

## User Experience (what your friends see)

```
1. Visit: https://www.runpod.io/templates/fredterzi/totem-llm
2. Click "Deploy"
3. Pick a GPU (or let RunPod pick cheapest available)
4. Wait 30-90 seconds
5. Get a URL: https://xxxxx-8686.proxy.runpod.net
6. Open it → create workspace → start chatting
```

No API keys. No config. No model downloads (pre-baked). GPU does the work.

---

## For the End User

### Accessing the UI

```
https://[POD_ID]-8686.proxy.runpod.net
```

### SSH into the Pod

```bash
# From RunPod console, copy the SSH command:
ssh root@[POD_IP] -p [MAPPED_PORT]
```

### Changing the Model

**From the UI:** Workspace Settings → LLM Selection → Provider: Ollama → Model: (pick any loaded model)

**From SSH:**
```bash
# See what's loaded
ollama list

# Pull a different model
ollama pull llama3.1:70b

# Then select it in the Totem UI
```

### API Access (OpenAI-compatible)

```bash
# Chat completion
curl https://[POD_ID]-8686.proxy.runpod.net/api/api/openai/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer [API_KEY]" \
  -d '{
    "model": "qwen3.8:27b",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Get an API key from: UI → Settings → API Keys
```

### Cost Estimates (RunPod on-demand pricing, approximate)

| GPU | $/hour | Model | Quality |
|---|---|---|---|
| T4 (16 GB) | ~$0.34 | qwen3.5:9b | Good for casual chat |
| A10G (24 GB) | ~$0.87 | qwen3.8:27b | Great for most use cases |
| A100 40GB | ~$1.89 | qwen3.8:27b (32K) | Long documents, RAG |
| A100 80GB | ~$3.29 | qwen3.8:27b-q8_0 | Full precision, max context |

> Prices vary by region and availability. RunPod also offers **Spot** GPUs at 50-70% discount.

---

## Troubleshooting (for template users)

### Pod won't start
- Check RunPod **Pod Logs** — look for OOM or image pull errors
- Ensure the image `fredterzi/totem-llm:latest` is public on Docker Hub

### Slow first response
- The model may still be loading into VRAM (27B takes ~10-20s to load)
- First token after load is slow (CUDA kernel compilation)
- Subsequent responses are fast

### "Model not found" error in UI
- The model may not have finished pulling at startup
- SSH in and check: `ollama list`
- Or wait a minute and refresh

### Out of Memory
- The auto-selected model may be too large for the actual free VRAM
- SSH in and check: `nvidia-smi`
- Force a smaller model: set env var `OLLAMA_MODEL_PREF=qwen3.5:9b` on the pod, then restart

---

## Template Versioning

When you release a new version:

```bash
# 1. Bump + tag (from RELEASE.md workflow)
npx standard-version --release-as minor
git push && git push --tags

# 2. Publish npm package
npm publish

# 3. GitHub Actions auto-builds Docker image → pushes to Docker Hub
#    (triggered by the v* tag push)

# 4. RunPod template already points at :latest → auto-updates
#    (existing pods keep the old image until restarted)
```

For pinned versions (e.g., for enterprise users who want stability):

```
fredterzi/totem-llm:0.16.1    # specific version
fredterzi/totem-llm:latest    # rolling (template default)
```

Users can change the image tag in their template settings to pin a version.
