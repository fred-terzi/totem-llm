# Totem LLM - Your Private AI

Totem LLM is a sovereign AI solution, aimed at optimizing for consumer hardware and ensuring data privacy. It is designed to run efficiently on consumer-grade hardware, such as laptops and desktops, without the need for cloud-based processing. This allows users to have full control over their data and AI interactions, without relying on third-party services.

## Install Quick Start Package

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Ollama](https://ollama.com/) (recommended) or an [OpenRouter](https://openrouter.ai/) API key

### 1. Install the package

```bash
npm install -g totem-llm
```

This downloads Totem LLM and installs all server and collector dependencies automatically.

### 2. Start Totem LLM

```bash
totem-llm start
```

On first run this performs one-time setup (creates `~/.totem-llm/`, migrates the database) then launches the server and document collector. Open [http://localhost:3001](http://localhost:3001) to access the UI.

### Options

```
totem-llm --no-collector    Start without the document collector
totem-llm --port=8080       Override the server port (default: 3001)
totem-llm setup             Run first-time setup without starting
totem-llm --help            Show all options
```

> **Storage**: All data is kept in `~/.totem-llm/` by default. Override with `TOTEM_STORAGE_DIR=/your/path totem-llm start`.

> **Windows (PowerShell)**: If you see `cannot be loaded because running scripts is disabled`, run this once in PowerShell then retry:
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```
> Alternatively, use **Command Prompt** (`cmd.exe`) where `totem-llm.cmd` runs without any policy change.

---

## Quick Start (Build from Source)

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Yarn](https://yarnpkg.com/) v1.x (`npm install -g yarn`)
- [Ollama](https://ollama.com/) (recommended local LLM provider) or an [OpenRouter](https://openrouter.ai/) API key
- Linux build machine - current build relies on `cp` command with `--reflink` option for efficient file copying. Building on non-Linux platforms may require additional setup (e.g. WSL on Windows).

### 1. Clone the repository

```bash
git clone https://github.com/fred-terzi/totem-llm.git
cd totem-llm
```

### 2. Install dependencies and initialise the database

```bash
yarn setup
```

This installs dependencies for all three packages (`server`, `collector`, `frontend`), copies the example `.env` files, generates the Prisma client, and runs database migrations.

### 3. Configure environment variables

Open `server/.env.development` and set at minimum:

```env
STORAGE_DIR="/absolute/path/to/your/storage"
```

All other settings (LLM provider, embedding model, etc.) can be changed later through the UI.

### 4. Start in development mode

```bash
yarn dev:all
```

This starts the server (port `3001`), collector (port `8888`), and frontend dev server (port `5173`) concurrently. Open [http://localhost:5173](http://localhost:5173) to access the UI.

> Alternatively, run each service in its own terminal: `yarn dev:server`, `yarn dev:collector`, `yarn dev:frontend`.

## Thanks

Massive thank you and appreciation to AnythingLLM. Totem LLM is a fork of AnythingLLM, and we are grateful for the foundation they have provided. We will continue to build on their work and contribute back to the community.

https://github.com/Mintplex-Labs/anything-llm
