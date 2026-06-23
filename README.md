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
| **Local & Cloud** | Choose local models via Ollama or use cloud providers (OpenRouter). |
| **Easy Setup** | One-line install with automatic dependency resolution. |

---

## 📋 About

Totem LLM is a sovereign AI solution, aimed at optimizing for consumer hardware and ensuring data privacy. It is designed to run efficiently on consumer-grade hardware, such as laptops and desktops, without the need for cloud-based processing. This allows users to have full control over their data and AI interactions, without relying on third-party services.

While local AI is the core focus, Totem LLM supports both local and cloud-based LLM providers, giving users the flexibility to choose based on their needs and preferences. The system is built with a modular architecture, allowing for easy integration of new features and providers over time.

## ⚙️ Requirements

Before installing Totem LLM, first install the below prerequisites:

- **[Node.js](https://nodejs.org/)** v18 or later
- **[Ollama](https://ollama.com/)** (recommended for local models) *OR*
- **[OpenRouter](https://openrouter.ai/)** API key (for cloud models)

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

**First run:** Creates `~/totem-llm/` directory, migrates database, then launches services.

**Access:** Open [http://localhost:8686](http://localhost:8686) in your browser.

### 3️⃣ Optional: Install as Desktop App

In the browser UI, click the **install icon** in the address bar (or use your browser menu) to add Totem LLM to your desktop. This is a link to the web GUI, but with its own window and taskbar/dock icon for easy access.

## Model Selection

Once first installed, we recommend using qwen3.5:2b as a base model. This is a small model that is excellent to start with. It can help answer questions and provide guidance on if you can use a bigger model. 

If qwen3.5:2b does not work well on your machine, it is recommened to move to OpenRouter. While a smaller model will work, there is a performance drop off.

### Windows and Linux Model Download:

```
ollama pull qwen3.5:2b
```

### Mac Model Download:
```
ollama pull qwen3.5:2b-mlx
```

> Note: The `-mlx` suffix indicates the version optimized for Apple Silicon (M1/M2) Macs. If you are on an Intel-based Mac, use the standard `qwen3.5:2b` model.
---

## 📚 Command Reference

```bash
totem-llm start                 # Start server and collector
totem-llm --no-collector       # Start server only (skip document ingestion)
totem-llm --port=8080          # Use custom server port
totem-llm setup                # Run first-time setup without starting
totem-llm --help               # Show all available commands
```

### Environment Variables

```bash
# Override default storage location (default: ~/totem-llm)
export TOTEM_STORAGE_DIR=/your/custom/path
totem-llm start
```

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

