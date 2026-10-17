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

`yarn setup` is idempotent. It copies `.env.example` → `.env` only if target doesn't exist. It also generates the Prisma client and runs migrations against `server/storage/totem-llm.db`.

> **DB filename migration (Totem rebrand):** pre-existing AnythingLLM installs store their SQLite DB as `~/totem-llm/anythingllm.db` (or `$STORAGE_DIR/anythingllm.db`). On startup, `lib/migrateDbName.js#migrateDatabaseFilename()` renames it to the new default `totem-llm.db` before Prisma migrations run. If both files exist, the existing `totem-llm.db` is kept and the legacy file is preserved as a timestamped backup (`anythingllm.db.bak-<ts>`) — no data loss, but the user must merge manually.

## Env Files

- **Development**: `server/.env.development` loaded by `dotenv` in `server/index.js:1` (when `NODE_ENV=development`). The root `.env.example` is copied to both `server/.env` and `server/.env.development` by `scripts/setup-envs.mjs`.
- **Production**: `~/totem-llm/.env` generated on first launch by `lib/setup.js`. This file contains auto-generated JWT/SIG secrets. Never commit it.
- **Key env vars**: `STORAGE_DIR` (defaults to `~/totem-llm/`), `COLLECTOR_PORT` (default 8888), `SERVER_PORT` (default 8686). Storage subdirs auto-created: `documents/`, `vector-cache/`, `models/`, `direct-uploads/`, `generated-files/`, `comkey/`, `tmp/`, `assets/`, `totemllm-fs/` (per-user agent sandbox — see Agent System → Per-user filesystem sandbox).

## Database — Prisma ORM

Prisma client 5.3.1. SQLite default; PostgreSQL supported via `DATABASE_URL`. Schema at `server/prisma/schema.prisma` with **20 models**:

| Model | Purpose |
|---|---|
| `users` | Auth, roles (admin/default), suspended, daily message limits, profile pic, `wallet_address` (optional), `credits_balance` (int, microdollars) |
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
| `credit_transactions` | Billing ledger: `amount` (microdollars), `type` (`purchase`\|`debit`\|`refund`), `reference`, `model`, `input_tokens`, `output_tokens`. One row per top-up or usage charge. Relation → `users` (cascade) |
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
| `agentSkillWhitelist.js` | Plugin enable/disable per user + terminal-access availability check (`GET /agent-skills/terminal-access/is-available`) | Agent permission control |
| `agentFileServer.js` | Serve/receive files from agents | File I/O during agent sessions |
| `experimental.js` | Live sync, imported agent plugins | Experimental/alpha features |
| `invite.js` | Invite codes for multi-user join flows | User onboarding |
| `credits.js` | `GET /credits`; admin: `POST /credits/debit-test`, `POST /credits/grant-test` | Credit balance + ledger; admin debit/grant for testing |
| `wallet.js` | `GET /wallet/balance`; `POST /auth/wallet/nonce`, `POST /auth/wallet/verify` | **Distinct from billing credits** — on-chain $TOTEM token (Base) balance + SIWE (sign-in-with-Ethereum) wallet login. New wallet signups get the 100 000 µ$ welcome bonus + auto-created default workspace |
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
- **Plugin system** (~35+ plugins): filesystem, terminal-access, gmail, google-calendar, outlook, sql-agent, web-scraping, create-files (docx/pptx/xlsx/pdf), websocket, memory, router-classifier, summarize, CLI, rechart
- **Terminal access** (`plugins/terminal-access.js`): shell execution with layered safety — availability gate (dev/Docker/feature flag) → admin opt-in via `default_agent_skills` → per-command approval for dangerous patterns (`rm -rf /`, `dd of=/dev/…`, fork bombs, etc.) → process-group timeout kill + output truncation.
- **Per-user filesystem sandbox** (v0.19.0+): filesystem tools operate on a per-user directory at `$STORAGE_DIR/totemllm-fs/users/<userId>/` (multi-user) or `$STORAGE_DIR/totemllm-fs` (single-user, `userId == null`). Resolved per-call via `getFilesystemFor(userId)` in `server/utils/agents/aibitat/plugins/filesystem/lib.js`. `validatePath()` enforces isolation — cross-user access, symlink escapes, and path traversal are all denied. `module.exports` is the shared default instance (backwards compat); new code should use `getFilesystemFor(userId)`. See `totem_docs/per-user-filesystem/` for spec, threat model, and AC1–AC6.
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
- **Wallet login (SIWE)**: Primary login method — see [Wallet Login (SIWE)](#wallet-login-siwe) below.

### Wallet Login (SIWE)

Sign-In with Ethereum (SIWE) is the **primary login method**. Users sign a server-generated message with their EVM wallet; the server recovers the address from the signature and issues a JWT. **The address is never trusted from the client** — it is always derived via `ethers.verifyMessage()`, so the user cannot impersonate a different address.

**Two-step flow:**

1. `POST /auth/wallet/nonce` → server returns `{ nonce, message }`.
   - The nonce is a UUID stored in an **in-memory `Map`** with a **5-minute TTL** (expired entries cleaned up every 60 s). The nonce is **single-use** — deleted immediately on consumption, even if the signature is invalid.
   - The message is a SIWE-style string. Example:
   ```
   totem.example.com wants you to sign in with your Ethereum account:

   (your wallet address will be derived from the signature)

   Sign this message to authenticate with Totem LLM.
   This request will not trigger a blockchain transaction or cost any gas fees.

   URI: https://totem.example.com
   Version: 1
   Chain ID: 1
   Nonce: 550e8400-e29b-41d4-a716-446655440000
   Issued At: 2026-01-01T12:00:00.000Z
   ```
   > **Note:** `Chain ID: 1` in the message is informational only — `personal_sign` has no chain parameter, so the signature is valid on any EVM chain. The on-chain $TOTEM balance is read from **Base (8453)** independently.

2. `POST /auth/wallet/verify` with `{ signature, nonce }` → server:
   - Looks up the nonce (replays and expired nonces are rejected with 401)
   - Recovers the address: `ethers.verifyMessage(storedMessage, signature)`
   - Normalises to lowercase
   - **Existing user**: looks up by `wallet_address` → checks `suspended` (403 if suspended) → issues JWT (30 d default)
   - **New user**: creates a `users` row:
     - `username`: `wallet_<first 6 hex chars of address>`
     - `password`: `uuidv4() + uuidv4()` (64-char placeholder — no one knows it; wallet-only account)
     - `wallet_address`: the recovered address
     - `credits_balance`: **100 000 µ$** welcome bonus
     - `role`: `default`
     - Records a `credit_transactions` row (`type: "credit"`, `reference: signup_<address>`)
     - Auto-creates a **"My Workspace"** (non-fatal on failure — user can create one manually)
     - Logs `wallet_account_created` event
   - Logs `wallet_login_event` on every successful login
   - Returns `{ valid: true, user: User.filterFields(user), token: <JWT> }`
   - **Race-condition safe**: concurrent first-login attempts for the same address catch the Prisma `P2002` unique constraint error and re-fetch the existing user

**Frontend — two wallet paths** (both in the login modal, rendered above the password form):

| Path | Component | How it works |
|---|---|---|
| **Desktop (EIP-1193)** | `WalletConnectButton` (inline in `MultiUserAuth.jsx`) | `window.ethereum.request({ method: "eth_requestAccounts" })` → `System.walletNonce()` → `window.ethereum.request({ method: "personal_sign", params: [message, address] })` → `System.walletVerify({ signature, nonce })` → store JWT + user in `localStorage` → redirect to home. Works with MetaMask, Rainbow, and any wallet that injects `window.ethereum`. |
| **Mobile (Reown AppKit)** | `WalletConnectMobile.jsx` | Uses **Reown AppKit** (`@reown/appkit` + `@reown/appkit-adapter-ethers`, ethers v6) instead of hand-rolled WalletConnect. `createAppKit()` is called once at module scope; the component uses `useAppKit`/`useAppKitAccount`/`useAppKitProvider` hooks. Tap "Connect Mobile Wallet" → AppKit's wallet picker modal handles wallet discovery, deep links/universal links (incl. cold-start retries), QR fallback, and session persistence across page reloads. Once connected, SIWE runs over the AppKit-provided EIP-1193 provider: `System.walletNonce()` → `personal_sign` → `System.walletVerify()` → JWT → redirect. Replaces the earlier raw `@walletconnect/sign-client` two-tap flow, whose MetaMask cold-start deep-link drops and Android hand-back reloads made login unreliable. Requires `VITE_WC_PROJECT_ID`. EVM-only (Phantom/Solana not supported). |

> **Mobile wallet connection:** the mobile path uses **Reown AppKit**, which handles wallet discovery, deep linking, cold-start retries, and session persistence internally — do not hand-roll `@walletconnect/sign-client` deep-link flows for mobile login; they break on MetaMask cold launches and Android universal-link hand-backs.

**On-chain $TOTEM balance** (`GET /wallet/balance`):

Read-only. Reads the caller's $TOTEM ERC-20 balance on **Base** via a JSON-RPC `eth_call` (no transaction is created). Feature-gated by the `TOTEM_ADDRESS` env var — when unset the endpoint returns `204 No Content` and the UI hides the badge. The wallet address used is the one stored on the user's account at login time.

| Env var | Default | Purpose |
|---|---|---|
| `TOTEM_ADDRESS` | *(unset — feature off)* | ERC-20 contract address (enables the balance endpoint) |
| `TOTEM_RPC_URL` | `https://mainnet.base.org` | JSON-RPC endpoint |
| `TOTEM_CHAIN_ID` | `8453` | Base mainnet |
| `TOTEM_DECIMALS` | `18` | Token decimals |
| `TOTEM_SYMBOL` | `TOTEM` | Display symbol |
| `VITE_WC_PROJECT_ID` | *(unset — mobile wallet off)* | WalletConnect project ID (required for the mobile path) |

> **Frontend/Vite version note:** `@reown/appkit-utils` → `@base-org/account` ships `import … with { type: 'json' }` (import attributes) in its dist. esbuild <0.20 cannot parse this, so the frontend was upgraded **Vite 4 → Vite 5** (esbuild ≥0.21) when AppKit was adopted. Don't downgrade Vite below 5.

**Key files:**

| File | Role |
|---|---|
| `server/endpoints/wallet.js` | Nonce + verify + balance endpoints; in-memory nonce store |
| `server/utils/totemBalance.js` | $TOTEM config resolution, `eth_call` balance reader, amount formatting (pure — no server deps) |
| `frontend/src/components/Modals/Password/MultiUserAuth.jsx` | Login modal — desktop EIP-1193 wallet button + password form |
| `frontend/src/components/Modals/Password/WalletConnectMobile.jsx` | Mobile Reown AppKit flow (wallet picker modal + SIWE over EIP-1193 provider) |
| `frontend/src/models/system.js` | `System.walletNonce()`, `System.walletVerify()`, `System.totemBalance()` API methods |

### Credits & Billing

Token-priced usage billing. The internal unit is the **microdollar** (1 µ$ = $0.000001); the customer-facing unit is an opaque integer called **"credits"**. Microdollar values are `@internal` — **never** rendered in the UI or leaked to end users.

**Pricing** (`server/models/credits.js`, currently single-model `e2ee-glm-5-3-flash`; per-model rates are a `TODO`):

| Token type | Rate |
|---|---|
| Input  | 0.5 µ$ / token ($0.50 per 1M) |
| Output | 1.0 µ$ / token ($1.00 per 1M) |

Cost is **ceiling-rounded per token type** so a partial token never under-charges:

```
cost(µ$) = ceil(inputTokens × 0.5) + ceil(outputTokens × 1.0)
```

**Data layer** — `server/models/credits.js` (static methods over Prisma):

| Method | Purpose |
|---|---|
| `calculateCost(inputTokens, outputTokens)` | Compute cost in µ$ from rates (ceiling-rounded). |
| `getBalance(userId)` | Current balance in µ$. |
| `hasCredits(userId, minMicro, role)` | Pre-flight affordability check before a chat turn. |
| `debit(userId, amount, ref, usage?)` | Deduct from balance (capped at available, never negative); records full requested cost. |
| `debitUsage(userId, { inputTokens, outputTokens, model, reference })` | Convenience wrapper — computes cost via rates, then calls `debit`. |
| `credit(userId, amount, type, ref)` | Top-up, refund, or welcome bonus. |
| `getTransactions(userId, limit)` | Recent ledger rows. |
| `getUsageStats(userId)` | Lifetime totals: input/output tokens, cost (µ$), debit count. |
| `microToDisplay(micro)` | `@internal` — µ$ → `$…` string. **Never expose to end users.** |

**Welcome bonus**: new accounts (notably via wallet signup in `wallet.js`) receive **100 000 µ$** (≈ $0.10) at creation, recorded as a `credit_transactions` row.

**API** — `server/endpoints/credits.js`:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /credits` | session | `{ balance, transactions }` (last 20) for the signed-in user |
| `POST /credits/debit-test` | session, **admin** | Simulate a debit (testing) |
| `POST /credits/grant-test` | session, **admin** | Grant/adjust balance (testing) |

> **Gotcha:** `wallet.js` is a *separate* concern from billing credits — it reads the on-chain $TOTEM token balance (Base) and handles SIWE wallet login. Don't conflate `GET /wallet/balance` (crypto token) with `GET /credits` (billing ledger).

**Frontend** — `CreditContext` (`frontend/src/context/CreditContext.jsx`, hook `useCredits()`) + `CreditBadge` (`frontend/src/components/CreditBadge/index.jsx`):

- `CreditProvider` fetches `GET /credits` on mount (authenticated); exposes `{ credits, loading, error, refresh }`.
- Re-fetches on every completed assistant response via **`ASSISTANT_MESSAGE_COMPLETE_EVENT`** (the canonical end-of-turn signal, fired in both standard chat and agent/websocket flows) so the badge stays accurate as credits are spent.
- Concurrency-safe: an `inFlight` ref collapses bursts of refresh/usage events into a single in-flight request.
- Never throws to the consumer — network/auth failures resolve to `error: true` with the last-known (or null) balance, so the badge degrades gracefully.
- The badge renders the opaque integer only; the microdollar value never reaches the DOM.

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
TOTEM_BUILD_PROFILE=source yarn dev:all
```

> **Gotcha:** Without `TOTEM_BUILD_PROFILE`, the frontend bundle is built with the
> `npm` profile (feature flags are baked in at build time). Profile-specific UI —
> e.g. Terminal Access (`terminalAccess`) and Agent Mode, both L2 features enabled only in
> the `source` profile — will not appear even if the server would report them available.
> When switching profiles between dev sessions, restart Vite (and rebuild for prod) so
> `__TOTEM_FEATURES__` is regenerated.

Frontend entry point alias: `@` → `frontend/src/`. Build output goes to `server/public/` with fixed filenames `index.js` and `index.css` (required for SSE in prod).

### Frontend Structure
- **Pages**: `Admin`, `GeneralSettings`, `Invite`, `Login`, `Main`, `OnboardingFlow`, `WorkspaceChat`, `WorkspaceSettings`
- **Components**: `WorkspaceChat` (core chat UI), `Sidebar` (workspace nav + threads), `Modals` (settings dialogs), `LLMSelection`, `VectorDBSelection`, `EmbeddingSelection`, `SpeechToText`, `TextToSpeech`
- **Contexts**: Auth, Theme, PWA, Logo, Pfp, EmbeddingProgress, CreditContext (live credit balance; `useCredits()`)

## Swagger Docs

Auto-generated on server start/restart by nodemon event hook in `server/nodemon.json`. Init script: `server/swagger/init.js`. Access at `/api/docs`.

## Branching Strategy

- **`dev-totem`** — active development branch (working tree for features, fixes, chores)
- **`main-totem`** — release branch; all releases merge into this
- PRs are opened from `dev-totem` → `main-totem`
- **ALWAYS `git fetch && git pull origin main-totem` before diffing branches or comparing** — stale remote tracking refs on `main-totem` will make merged commits appear "ahead" again (this caused PR #14 confusion).

## Versioning & Release Process

- **`RELEASE.md`** (repo root) is the single source of truth for versioning and releases: standard-version workflow, semver bump rules, tag/publish steps. Follow it for every release.
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
- **Credits ≠ microdollars, and ≠ wallet token**: `server/models/credits.js` + `credit_transactions` work in **microdollars**; the frontend `CreditContext`/`CreditBadge` show an opaque integer. `microToDisplay()` is `@internal` — never render it to end users. `wallet.js` ($TOTEM on-chain token + SIWE login) is a *different* balance entirely.
- **Per-user filesystem** (v0.19.0+): the agent's filesystem tools are scoped to `$STORAGE_DIR/totemllm-fs/users/<userId>/`. In single-user mode (`userId == null`) they use the shared `$STORAGE_DIR/totemllm-fs` root. `getFilesystemFor()` is the only resolution point — do NOT `require` the default `module.exports` directly in new code (kept for backwards compat with existing require sites). The migration script (`yarn fs:migrate`, `scripts/migrate-fs-to-users.mjs`) copies old shared files into the correct user dirs — idempotent, run it when upgrading from pre-v0.19.0 builds.

## Security Notes

- **CORS**: Configured with `origin: true` (accepts any origin). Acceptable for self-hosted use but review before exposing externally.
- **Auth middleware** (`server/utils/middleware/validatedRequest.js`): JWT validation in production; bypassed in development mode or when no `AUTH_TOKEN` is set.
- **Secrets auto-generated** on first launch (JWT_SECRET, SIG_KEY, SIG_SALT) — stored in storage dir `.env`, never committed.
- **EncryptionManager**: PEM-key based encryption for sensitive JWT payloads. Key persisted at `STORAGE_DIR/comkey/`.

## Feature Flags

Built-time feature flags loaded from:
- **Dev**: `config/totem.features.json` via Vite env var `TOTEM_BUILD_PROFILE`
  (defaults to the `npm` profile — use `source` for full-feature local dev)
- **Prod**: Copied to `~/totem-llm/.totem.features.json` during setup
- Exposed as global `__TOTEM_FEATURES__` in frontend
