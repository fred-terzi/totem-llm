# Totem LLM — Agent Instructions

## What This Repo Is

Totem LLM, a self-hosted AI chat app. Fork of [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm). Three independent Node.js services (+ React frontend) managed by a thin CLI wrapper in `lib/` → packaged as npm module `totem-llm`.

## Service Topology

```
┌─────────────┐     HTTP + SSE      ┌──────────────┐
│  Frontend   │◄──────────────────►│   Server      │
│  (Vite/3000)│                    │  (Express/8686)│──SQLite (Prisma)
│  React     │                    │               │
└─────────────┘                   └──────┬─────────┘
                                        │ HTTP POST (/process, /parse, /extension)
                                        │ Integrity-signed payloads via comKey PEM
                                    ┌───▼──────────┐
                                    │  Collector    │
                                    │   (8888)      │
                                    └───────────────┘
```

- **Frontend** (port 3000): Vite + React, proxies `/api → server:8686` in dev. Built output → `server/public/`.
- **Server** (port 8686): Express API. Owns auth, Prisma DB, chat orchestration, agent execution, WebSocket for streaming agent sessions. Runs local Collector process.
- **Collector** (port 8888): Stateless document ingestion + RAG embedding pipeline. Handles file parsing, text extraction, chunking, and vector storage.
- **lib/**: Production launcher — spawns server + collector as child processes via `spawn()`, handles graceful shutdown, prints startup banner with QR code for local access.

## Repo Layout

| Directory | Role | Module System |
|---|---|---|
| Root `package.json` | CLI entry point (`bin/totem-llm.js`), orchestrator scripts, Jest config | ESM |
| `server/` | Express API server — endpoints, Prisma models, middleware | CJS (CommonJS) |
| `collector/` | Document ingestion + RAG pipeline service | CJS |
| `frontend/` | React + Vite frontend | ESM |
| `lib/` | CLI glue: setup, launcher, config helpers | ESM |
| `config/` | Build-time feature flags (`totem.features.json`) | — |
| `scripts/` | Setup, postinstall, build orchestrators | ESM (.mjs) |

### Key Files by Service

**Server entry**: `server/index.js` — loads `.env`, creates storage dirs, mounts ~27 endpoint routers under `/api`, serves static frontend in prod. Body limit: 3GB. CORS: `origin: true`. HTTPS via `bootSSL` if `ENABLE_HTTPS`.

**Collector entry**: `collector/index.js` — Express with 5 routes (all POST, integrity-verified via `verifyPayloadIntegrity` middleware):
- `/process` — process uploaded file → chunks + embeddings
- `/parse` — extract raw text from file
- `/extension` — browser extension content processing
- `/raw-text` — ingest raw strings directly
- `/wipe-storage` — clear collector temp files

**Lib launcher**: `lib/launcher.js` — spawns server + collector as child processes, pipes logs with `[server]`/`[collector]` prefixes, writes session log. `lib/setup.js` — first-run configuration wizard (generates secrets, sets up DB if needed).

## Dev Setup (Order Matters)

```bash
# One-time setup — MUST run before anything else.
# Installs deps in all sub-packages, copies .env.example → .env files, runs Prisma generate + migrate + seed.
yarn setup

# Start dev servers (pick one):
yarn dev:all          # All three services concurrently (recommended)
# OR separate terminals:
yarn dev:server       # Express on :8686 (nodemon, hot-reloads)
yarn dev:collector    # Collector on :8888 (nodemon, hot-reloads)
yarn dev:frontend     # Vite on :3000 (proxies /api → server :8686)
```

`yarn setup` is idempotent. It copies `.env.example` → `.env` only if target doesn't exist. It also generates the Prisma client and runs migrations against `server/storage/anythingllm.db`.

## Env Files

- **Development**: `server/.env.development` loaded by `dotenv` in `server/index.js:1` (when `NODE_ENV=development`). The root `.env.example` is copied to both `server/.env` and `server/.env.development` by `scripts/setup-envs.mjs`.
- **Production**: `~/totem-llm/.env` generated on first launch by `lib/setup.js`. This file contains auto-generated JWT/SIG secrets. Never commit it.
- **Key env vars**: `STORAGE_DIR` (defaults to `~/totem-llm/`), `COLLECTOR_PORT` (default 8888), `SERVER_PORT` (default 8686). Storage subdirs auto-created: `documents/`, `vector-cache/`, `models/`, `direct-uploads/`, `generated-files/`, `comkey/`, `tmp/`, `assets/`.

## Database — Prisma ORM

Prisma client 5.3.1. SQLite default; PostgreSQL supported via `DATABASE_URL`. Schema at `server/prisma/schema.prisma` with **20 models**:

| Model | Purpose |
|---|---|
| `users` | Auth, roles (admin/default), suspended, daily message limits, profile pic |
| `workspaces` | Knowledge base containers — system prompt, model selection, similarity thresholds, chat mode (`chat`,`agent`,`query`) |
| `workspace_threads` | Chat sessions within a workspace |
| `workspace_chats` | Individual turns in workspace chats (includes feedbackScore) |
| `workspace_documents` | Uploaded docs linked to workspaces (pinned, watched, metadata JSON) |
| `workspace_parsed_files` | Files created/parsed by agents inside workspace threads |
| `workspace_users` | Many-to-many: user ↔ workspace membership (multi-user mode) |
| `workspace_suggested_messages` | Auto-suggested prompts per workspace |
| `workspace_agent_invocations` | Agent execution tracking (prompt, closed status) |
| `document_vectors` | Maps docId → vectorId in external vector DBs |
| `api_keys` | Developer API keys for programmatic access |
| `agent_skill_whitelist` | Controls which agent plugins a user/workspace can run |
| `scheduled_jobs` | Cron jobs with tool selection, status tracking via `scheduled_job_runs` |
| `memories` | User-scoped or workspace-scoped persistent memory (LLM-managed) |
| `model_routers` + `model_router_rules` | Rule-based model routing — fallback LLM + conditional rules by token count, cost, temperature etc. |
| `system_settings` | Runtime config: multi-user mode toggle, default models, auth settings |
| `embed_configs` + `embed_chats` | Embeddable widget configs with domain allowlists and rate limits |
| `document_sync_queues` + `document_sync_executions` | Periodic re-sync of watched documents |
| `cache_data` | Key-value cache with TTL (`expiresAt`) |
| `event_logs` | Audit trail: event type + JSON metadata + userId |
| `browser_extension_api_keys` | Browser extension auth tokens |
| `temporary_auth_tokens` | Short-lived tokens for passwordless flows |
| `password_reset_tokens`, `recovery_codes` | Account recovery |
| `system_prompt_variables` | User-defined prompt variables (system/user/dynamic types) |
| `desktop_mobile_devices` | Mobile↔Desktop pairing tokens |
| `external_communication_connectors` | Gmail/Outlook webhook configs |
| `slash_command_presets` + `prompt_history` | Prompt history and slash commands |

**Data Models layer**: `server/models/*.js` — one file per Prisma model with static class methods for common queries (CRUD helpers, lookups, validation). Used by endpoint handlers instead of raw Prisma calls.

### DB Commands

```bash
yarn prisma:setup          # generate + migrate + seed
yarn prisma:generate       # regenerate client after schema changes
yarn prisma:migrate        # apply migrations
yarn prisma:reset          # clear SQLite + re-migrate
```

## Server API — Endpoint Map

All routes mounted under `/api`. Each file exports a function that appends to the Express router.

| File | Prefix/Paths | Purpose |
|---|---|---|
| `system.js` | Health, status, config, onboarding checks | Read-only system state |
| `workspaces.js` | CRUD for workspaces + settings | Workspace lifecycle |
| `workspaceThreads.js` | Thread management per workspace | Chat sessions |
| `chat.js` | `POST /chat-to-workspace`, SSE streaming | Core chat endpoint — LLM call, RAG retrieval, agent execution |
| `document.js` | Upload, delete, sync documents | Document management per workspace |
| `admin.js` | User management, system settings, event logs | Admin panel API |
| `modelRouter.js` | Router + rule CRUD | Model routing configuration |
| `embedManagement.js` | Widget config CRUD + token generation | Embedding widget setup |
| `agentWebsocket.js` | WebSocket upgrade for agent sessions | Real-time agent tool execution stream |
| `agentSkillWhitelist.js` | Plugin enable/disable per user | Agent permission control |
| `agentFileServer.js` | Serve/receive files from agents | File I/O during agent sessions |
| `experimental.js` | Live sync, imported agent plugins | Experimental/alpha features |
| `invite.js` | Invite codes for multi-user join flows | User onboarding |
| `mcpServers.js` | MCP (Model Context Protocol) server configs | External tool integrations |
| `mobile.js` | Mobile app pairing + chat | Teams mobile companion |
| `telegram.js` | Telegram long-poll webhook proxy | Telegram bot bridge |
| `scheduledJobs.js` | Cron job CRUD + manual trigger | Scheduled agent tasks |
| `memory.js` | Memory CRUD | Persistent user/workspace memory |
| `features.js` | Feature flag toggle read/write | Runtime feature control |

### API sub-routers (developer-facing)

Under `/api/api/`:
- **OpenAI-compatible** (`/api/api/openai/*`) — full OpenAI chat completions + embeddings compatibility layer
- **Admin** (`/api/api/admin/*`) — programmatic admin operations
- **Auth** (`/api/api/auth/*`) — token exchange for API key auth
- **Workspace** (`/api/api/workspace/*`) — workspace queries via API key
- **Document** (`/api/api/document/*`) — document ops via API key
- **User Management** (`/api/api/user-management/*`) — user CRUD via API keys

Under `/api/embed/`: Public embed widget endpoints (no server auth, uses embed config tokens).

## Core Architecture Concepts

### Workspaces = Knowledge Bases
A workspace is a self-contained knowledge base with:
- **System prompt** (`openAiPrompt` in DB) — injected as system message
- **Documents** — uploaded files vectorized into external vector stores
- **Chat mode**: `chat` (conversational), `agent` (tool-use enabled), `query` (document-focused Q&A)
- **Model routing** — optional `model_routers` for conditional LLM selection (e.g., cheap model for short queries, powerful for complex ones)
- **Similarity threshold** + **topN** — RAG retrieval parameters

### Chat Flow (`server/utils/chats/`)
1. Client POSTs to `/api/chat-to-workspace` with prompt + workspace slug
2. Server resolves workspace → pulls documents via vector DB query (topN, similarityThreshold)
3. Builds message array: system prompt + context + chat history + user prompt
4. Routes LLM call through selected provider via `server/utils/AiProviders/`
5. Streams response via SSE to client (or WebSocket for agent mode)
6. Saves turn to `workspace_chats`

### Agent System (`server/utils/agents/aibitat/`)
The "Aibitat" framework — a custom multi-step agent execution engine:
- **Plugin system** (~35+ plugins): filesystem, gmail, google-calendar, outlook, sql-agent, web-scraping, create-files (docx/pptx/xlsx/pdf), websocket, memory, router-classifier, summarize, CLI, rechart
- **Provider abstraction**: Each LLM provider has an agent wrapper in `aibitat/providers/` that handles tool-calling format adaptation (Anthropic uses tool_use, OpenAI uses function_calling patterns)
- **Execution**: Agent session runs server-side, streams tool calls + results via WebSocket to frontend for real-time visibility
- **Agent invocation lifecycle**: `workspace_agent_invocations` tracks each run; closed flag marks completion
- **Skill whitelisting**: `agent_skill_whitelist` controls which plugins are accessible per user

### Agent Flows (`server/utils/agentFlows/`)
Declarative workflows — ordered sequences of steps (llm-instruction, web-scraping, api-call) executable as scheduled jobs. Stored in `scheduled_jobs`.

### Embedding Pipeline
- **Server → Collector**: Files sent to collector via HTTP POST with integrity signature (encryption manager generates comKey for HMAC verification). Timeout: 15 min per file.
- **Collector processes**: Parse content → text extraction → chunking (`TextSplitter`) → embedding vector generation via selected `VectorDbProvider`
- **Vector DB providers** (8 backends): Chroma, Astra, LanceDB, Milvus, pgvector, Pinecone, Qdrant, Weaviate, Zilliz (+ ChromaCloud)
- **Embedding engines** (~13 backends): native/local, Ollama, OpenAI, Azure, Anthropic, Gemini, LMStudio, LocalAI, VoyageAI, liteLLM, genericOpenAi, mistral, cohere

### Authentication Flow
`server/utils/middleware/validatedRequest.js`:
- **Multi-user mode** (enabled via `system_settings` table): JWT-based login with bcrypt password verification. Roles: admin / default. API keys and session tokens for stateless auth.
- **Single-user mode**: Password stored as `AUTH_TOKEN` env var, JWT payload encrypted with PEM key (`EncryptionManager`). Bypassed in dev or when no AUTH_TOKEN is set.
- **API keys**: Stateless `api_keys` table — bearer token validation via `validApiKey` middleware.

## Collector Service Details

Stateless microservice. Server starts it on boot (via child_process.spawn) and keeps it alive; collector exit = warning, not fatal. All 5 endpoints require `verifyPayloadIntegrity` (HMAC signature using shared comKey).

Processing pipelines:
- **processSingleFile** — universal file processor with extension-based routing (pdf, docx, xlsx, pptx, epub, audio/video for transcription, markdown, code files)
- **processLink** — URL fetching + HTML → text extraction (readability.js)
- **processRawText** — direct string ingestion for chat history or LLM output archival
- **Extension handler** — browser extension injects page content

### Tests

Run with Jest from the repo root. Config: `jest.config.cjs`. Test files live in `__tests__/` subdirectories across packages:

```bash
# All tests (from root):
yarn test

# Single file:
npx jest path/to/file.test.js

# By pattern:
npx jest --testPathPattern="server/__tests__/utils/helpers"
```

Coverage threshold is low (~10%) — adding `__tests__/` to coverage ignore in `jest.config.cjs` means test files themselves aren't counted.

### Lint / Format

```bash
# Auto-fix (runs eslint --fix in all three packages):
yarn lint

# CI check only (no fix):
yarn lint:ci
```

ESLint uses **hermes-eslint** parser with Flow annotations (`ftFlow` plugin). Rules are mostly warnings — not errors. `eslint.config.js` at root imports plugins from `server/node_modules/`, so server deps must be installed first. Prettier is integrated via `eslint-plugin-prettier`.

**Build order before committing**: `yarn lint` → `yarn test` (lint mutates files, then verify tests pass).

## Frontend Build

Vite (`frontend/vite.config.js`). Feature flags are baked in at build time from `config/totem.features.json` via the `TOTEM_BUILD_PROFILE` env var. The public API is exposed as `__TOTEM_FEATURES__` constant. Change profile with:

```bash
TOTEM_BUILD_PROFILE=source yarn dev:frontend
```

Frontend entry point alias: `@` → `frontend/src/`. Build output goes to `server/public/` with fixed filenames `index.js` and `index.css` (required for SSE in prod).

### Frontend Structure
- **Pages**: `Admin`, `GeneralSettings`, `Invite`, `Login`, `Main`, `OnboardingFlow`, `WorkspaceChat`, `WorkspaceSettings`
- **Components**: `WorkspaceChat` (core chat UI), `Sidebar` (workspace nav + threads), `Modals` (settings dialogs), `LLMSelection`, `VectorDBSelection`, `EmbeddingSelection`, `SpeechToText`, `TextToSpeech`
- **Contexts**: Auth, Theme, PWA, Logo, Pfp, EmbeddingProgress

## Swagger Docs

Auto-generated on server start/restart by nodemon event hook in `server/nodemon.json`. Init script: `server/swagger/init.js`. Access at `/api/docs`.

## Branching Strategy

- **`dev-totem`** — active development branch (working tree for features, fixes, chores)
- **`main-totem`** — release branch; all releases merge into this
- PRs are opened from `dev-totem` → `main-totem`
- **ALWAYS `git fetch && git pull origin main-totem` before diffing branches or comparing** — stale remote tracking refs on `main-totem` will make merged commits appear "ahead" again (this caused PR #14 confusion).

## Versioning & Release Process

- Use the **npm-versioning skill** (`software-development/npm-versioning/SKILL.md`) for every release.
- The workflow: `standard-version --dry-run` → confirm bump type → `npx standard-version` → push tags → open/merge PR.
- Never skip the version bump when creating a PR that reaches main-totem.

## Node Version

Pinned to **v18.18.0** via `.nvmrc`. Server and collector require `>=18.12.1`.

## Conventional Commits

PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/en/). Examples from `pull_request_template.md`:
- `feat(scope): adding foo API`
- `fix(scope): issue with foo API`
- `docs: adding foo API documentation`

## Key Gotchas

- **Server is CJS, root/lib/frontend are ESM** — do not mix `import`/`require` across boundaries. Root packages use `"type": "module"`, server does not.
- **No `yarn.lock` tracked in git** — it's in `.gitignore`. Dependencies are resolved fresh on setup.
- **Postinstall script** (`scripts/postinstall.mjs`) installs sub-package deps and generates Prisma client when installed via `npm install -g`. Skipped in CI and local dev.
- **Storage dir** defaults to `~/totem-llm/` at runtime. Override with `TOTEM_STORAGE_DIR`. This is where secrets, DB, vector cache, and logs live — not inside the repo.
- **Collector crash ≠ server crash**: Collector exiting only produces a warning; server keeps running. Server exit triggers full shutdown.
- **SSE for chat, WebSocket for agents**: Chat-to-workspace uses HTTP SSE streaming. Agent tool execution streams over dedicated WebSocket connection (`agentWebsocket.js`). Both require different frontend handling.
- **Body limit is 3GB** across all services — allows large document uploads but means body-parser buffers huge payloads into memory.
- **No relation on `workspace_agent_invocations.thread_id`**: Intentional — SQLite migration would lock the entire `workspace_threads` table, causing cascading timeouts. Same pattern on `workspace_chats.thread_id`.

## Security Notes

- **CORS**: Configured with `origin: true` (accepts any origin). Acceptable for self-hosted use but review before exposing externally.
- **Auth middleware** (`server/utils/middleware/validatedRequest.js`): JWT validation in production; bypassed in development mode or when no `AUTH_TOKEN` is set.
- **Secrets auto-generated** on first launch (JWT_SECRET, SIG_KEY, SIG_SALT) — stored in storage dir `.env`, never committed.
- **EncryptionManager**: PEM-key based encryption for sensitive JWT payloads. Key persisted at `STORAGE_DIR/comkey/`.

## Feature Flags

Built-time feature flags loaded from:
- **Dev**: `config/totem.features.json` via Vite env var `TOTEM_BUILD_PROFILE`
- **Prod**: Copied to `~/totem-llm/.totem.features.json` during setup
- Exposed as global `__TOTEM_FEATURES__` in frontend
