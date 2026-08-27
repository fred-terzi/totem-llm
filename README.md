<div align="center">

# Totem LLM

<p align="center">
  <img src="images/totem_logo.png" alt="Description of image" width="100">
</p>


### Your Mind Leads

[![Node.js](https://img.shields.io/badge/Node.js-v18+-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](https://github.com/fred-terzi/totem-llm)


**A sovereign AI solution for consumer hardware. Keep your data private, run locally, stay in control.**

</div>

---

## 🚀 Key Features

| Feature | Description |
|---------|-------------|
| **Privacy First** | All data stays on your machine. |
| **Consumer Hardware** | Optimized for consumer-grade devices. |
| **Local & Cloud** | Bring your own LLM provider — local runtimes or cloud APIs. |
| **Easy Setup** | One-line install with automatic dependency resolution. |

---

## 📋 About

Totem LLM is a sovereign AI solution, aimed at optimizing for consumer hardware and ensuring data privacy. It is designed to run efficiently on consumer-grade hardware, such as laptops and desktops, without the need for cloud-based processing. This allows users to have full control over their data and AI interactions, without relying on third-party services.

While local AI is the core focus, Totem LLM supports both local and cloud-based LLM providers, giving users the flexibility to choose based on their needs and preferences. The system is built with a modular architecture, allowing for easy integration of new features and providers over time.

## ⚙️ Requirements

Before installing Totem LLM, you only need:

- **[Node.js](https://nodejs.org/)** v18 or later

You'll also want an LLM provider to talk to — see [LLM Providers](#-llm-providers) below. Local runtimes like Ollama are free and keep everything on your machine; cloud providers only require an API key. You can configure a provider after first launch from the settings UI if you prefer not to set one up beforehand.

---

## 🎯 Quick Start

### 1️⃣ Install the Package

Open your terminal and run:

```bash
npm install -g totem-llm
```

This automatically downloads Totem LLM and installs all dependencies (server, collector, frontend).

### 2️⃣ Start Totem LLM

```bash
totem-llm start
```

**First run:** Creates `~/totem-llm/` directory, generates secure configuration, migrates database, then launches services.

**Access:** Open [http://localhost:8686](http://localhost:8686) in your browser.

### 3️⃣ Connect an LLM Provider

Once the app is running, select a provider from **Settings → LLM Providers**. Supported providers include local runtimes (Ollama, LM Studio) and cloud APIs (OpenRouter, OpenAI, Anthropic), as well as any endpoint that speaks the generic OpenAI format. See [LLM Providers](#-llm-providers).

### 4️⃣ Optional: Install as Desktop App

In the browser UI, click the **install icon** in the address bar (or use your browser menu) to add Totem LLM to your desktop. This is a link to the web GUI, but with its own window and taskbar/dock icon for easy access.

---

## 🧠 LLM Providers

Totem LLM works with a range of local and cloud LLM providers, configurable from the settings UI:

| Provider | Type | Notes |
|----------|------|-------|
| **[Ollama](https://ollama.com/)** | Local | Run open-weight models on your own machine. Pull any model you like (e.g., `ollama pull llama3.2`). |
| **[LM Studio](https://lmstudio.ai/)** | Local | GUI for running local models; exposes an OpenAI-compatible server that Totem connects to. |
| **[OpenRouter](https://openrouter.ai/)** | Cloud | Single API key for access to hundreds of hosted models. |
| **[OpenAI](https://platform.openai.com/)** | Cloud | GPT-4o, o-series, and other OpenAI models via your own API key. |
| **[Anthropic](https://www.anthropic.com/)** | Cloud | Claude models via your own API key. |
| **Generic OpenAI format** | Any | Point at any endpoint that implements the OpenAI chat completions API — self-hosted gateways, proxies, or other providers. |

More providers are available in the settings UI if you need them. Local options keep all processing (and your data) on your machine; cloud options trade privacy for access to larger models.

---

## 📚 Command Reference

```bash
totem-llm start                 # Start server and collector
totem-llm --no-collector       # Start server only (skip document ingestion)
totem-llm --port=8080          # Use custom server port
totem-llm setup                # Run first-time setup without starting
totem-llm --version            # Print version and exit
totem-llm --help               # Show all available commands
```

### Environment Variables

```bash
# Override default storage location (default: ~/totem-llm)
export TOTEM_STORAGE_DIR=/your/custom/path
totem-llm start
```

All configuration (secrets, ports, settings) is stored in `~/totem-llm/.env` and can be edited there.

---

## 🛠️ Troubleshooting

| Issue | Solution |
|-------|----------|
| **npm not found** (Windows) | Run `npm.cmd` instead of `npm` |
| **totem-llm command not found** | Run `npx.cmd totem-llm start` or add npm global bin to PATH |
| **PowerShell script execution error** | Run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` once, then retry |
| **Alternative on Windows** | Use **Command Prompt** (`cmd.exe`) instead of PowerShell |


## 🙏 Acknowledgments

Totem LLM is built on the foundation of **[AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)** by Mintplex Labs. We are deeply grateful for their excellent work.

---

## 📄 License

Totem LLM is released under the **MIT License** — see [LICENSE](LICENSE) for details.

## 📞 Support

- 🐛 **Report Issues** → [GitHub Issues](https://github.com/fred-terzi/totem-llm/issues)
- 💬 **Discussions** → [GitHub Discussions](https://github.com/fred-terzi/totem-llm/discussions)

---
