<div align="center">

# 🌲 Totem LLM

### Your Private AI

[![Node.js](https://img.shields.io/badge/Node.js-v18+-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](https://github.com/fred-terzi/totem-llm)
[![GitHub Stars](https://img.shields.io/github/stars/fred-terzi/totem-llm?style=social)](https://github.com/fred-terzi/totem-llm)

**A sovereign AI solution for consumer hardware. Keep your data private, run locally, stay in control.**

</div>

---

## 🚀 Key Features

| Feature | Description |
|---------|-------------|
| 🔒 **Privacy First** | All data stays on your machine. No cloud calls. Full control. |
| ⚡ **Consumer Hardware** | Optimized for laptops and desktops. No GPU required for basic use. |
| 🧠 **Local & Cloud** | Choose local models via Ollama or use cloud providers (OpenRouter, etc.). |
| 📦 **Easy Setup** | One-line install with automatic dependency resolution. |
| 🔌 **Modular Design** | Extensible architecture for custom integrations and providers. |

---

## 📋 About

Totem LLM is a sovereign AI solution, aimed at optimizing for consumer hardware and ensuring data privacy. It is designed to run efficiently on consumer-grade hardware, such as laptops and desktops, without the need for cloud-based processing. This allows users to have full control over their data and AI interactions, without relying on third-party services.

While local AI is the core focus, Totem LLM supports both local and cloud-based LLM providers, giving users the flexibility to choose based on their needs and preferences. The system is built with a modular architecture, allowing for easy integration of new features and providers over time.

## ⚙️ Requirements

Before installing, ensure you have:

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

In the browser UI, click the **install icon** in the address bar (or use your browser menu) to add Totem LLM as a standalone desktop application.

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

## Install Quick Start Package

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Ollama](https://ollama.com/) (recommended) or an [OpenRouter](https://openrouter.ai/) API key

### 1. Install the package

Search for `terminal` in your applications and open it. Then run:

```bash
npm install -g totem-llm
```

This downloads Totem LLM and installs all server and collector dependencies automatically.

### 2. Start Totem LLM

```bash
totem-llm start
```

On first run this performs one-time setup (creates `~/totem-llm/`, migrates the database) then launches the server and document collector. Open [http://localhost:8686](http://localhost:8686) to access the UI.

### 3. Install to Desktop (optional)

In the browser, click the install icon in the address bar (or use the browser menu) to install Totem LLM as a desktop application. This creates a standalone app with its own window and taskbar/dock icon.

### Options

```
totem-llm --no-collector    Start without the document collector
totem-llm --port=8080       Override the server port (default: 8686)
totem-llm setup             Run first-time setup without starting
totem-llm --help            Show all options
```

> **Storage**: All data is kept in `~/totem-llm/` by default. Override with `TOTEM_STORAGE_DIR=/your/path totem-llm start`.

### Troubleshooting

**npm not found after node.js install**: 

Common on windows, you may need to run `npm.cmd` instead of just `npm`

**totem-llm command not found after install**:

Run `npx.cmd totem-llm start` instead of `totem-llm start`, or add the npm global bin directory to your PATH.

> **Windows (PowerShell)**: If you see `cannot be loaded because running scripts is disabled`, run this once in PowerShell then retry:
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```
> Alternatively, use **Command Prompt** (`cmd.exe`) where `totem-llm.cmd` runs without any policy change.

---

## 🔧 Build from Source

For developers who want to contribute or customize Totem LLM.

### Prerequisites

- **[Node.js](https://nodejs.org/)** v18 or later
- **[Yarn](https://yarnpkg.com/)** v1.x (`npm install -g yarn`)
- **[Ollama](https://ollama.com/)** (recommended) or **[OpenRouter](https://openrouter.ai/)** API key
- **Linux build machine** — builds rely on `cp --reflink` for efficient file copying (WSL on Windows supported)

### Setup Steps

#### 1. Clone Repository

```bash
git clone https://github.com/fred-terzi/totem-llm.git
cd totem-llm
```

#### 2. Install & Initialize

```bash
yarn setup
```

Installs all dependencies, copies example `.env` files, generates Prisma client, and runs database migrations.

#### 3. Configure Environment

Edit `server/.env.development`:

```env
STORAGE_DIR="/absolute/path/to/your/storage"
```

All other settings (LLM provider, embedding model, etc.) can be configured later through the UI.

#### 4. Start Development Mode

```bash
yarn dev:all
```

This starts three concurrent services:
- **Server** → http://localhost:8686
- **Collector** → http://localhost:8888
- **Frontend dev** → http://localhost:5173 (recommended for development)

**Alternative:** Run each service separately in different terminal tabs:
```bash
yarn dev:server
yarn dev:collector
yarn dev:frontend
```

---

## 🙏 Acknowledgments

Totem LLM is built on the foundation of **[AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)** by Mintplex Labs. We are deeply grateful for their excellent work and continue to build on their vision while maintaining full data privacy for our users.

---

## 📄 License

Totem LLM is released under the **MIT License** — see [LICENSE](LICENSE) for details.

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📞 Support

- 🐛 **Report Issues** → [GitHub Issues](https://github.com/fred-terzi/totem-llm/issues)
- 💬 **Discussions** → [GitHub Discussions](https://github.com/fred-terzi/totem-llm/discussions)
- 📖 **Security** → See [SECURITY.md](SECURITY.md)

---

<div align="center">

**Made with ❤️ for privacy and open-source AI**

</div>
