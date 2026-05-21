# Daisy Workflow — Claude Context

> Architecture & design reference for Claude. Last updated: 2026-05-21.

---

## What is Daisy Workflow?

Daisy is an **AI-orchestration platform** built around a visual DAG editor and a typed DSL.
It lets users compose, run, and monitor directed acyclic graphs (DAGs) of plugin actions — locally or in containers.

**Version:** 0.1.0  
**Repo origin:** github.com/vivekg13186/Daisy-workflow

---

## High-Level Architecture (2026-05-21)

```
Browser (Vue 3 + Quasar)
    │  REST + WebSocket
    ▼
Express API (Node.js, ESM)   ←──  Auth middleware (JWT / OIDC / SAML)
    │                                  │
    ├─► DAG Engine (executor.js)        │
    │       │ FEEL expression eval      │
    │       ▼                           │
    │   Plugin Registry ──► in-process plugins (builtin/)
    │                   └─► HTTP-transport plugins (containers)
    │
    ├─► BullMQ Worker (worker.js) — async job queue via Redis
    │
    ├─► PostgreSQL — workflow state, executions, node_states, configs, …
    └─► Redis — job queue, rate limits, cache
```

---

## Repository Layout

| Path | Purpose |
|------|---------|
| `backend/` | Node.js Express API + engine + worker |
| `backend/src/server.js` | Entry point — mounts all routers, starts HTTP |
| `backend/src/worker.js` | BullMQ worker entry — processes execution jobs |
| `backend/src/config.js` | Centralised env-var config (AI keys, DB, Redis, SMTP) |
| `backend/src/engine/executor.js` | Core DAG executor — runs nodes, handles retries, parallel branches, WAITING state |
| `backend/src/engine/scheduler.js` | Builds the DAG (topological order, parallel groups) |
| `backend/src/engine/limits.js` | Node timeout + retry logic |
| `backend/src/dsl/` | FEEL expression evaluator (`${expr}` placeholders in flows) |
| `backend/src/plugins/` | Plugin registry, catalog, builtin plugins, HTTP plugin transport |
| `backend/src/api/` | Express routers (one file per resource) |
| `backend/src/auth/` | JWT, OIDC, SAML, API keys, permissions |
| `backend/src/db/` | PostgreSQL pool + migration runner |
| `backend/migrations/` | Sequential SQL migrations (001–034 as of 2026-05-21) |
| `frontend/` | Vue 3 + Quasar SPA |
| `frontend/src/pages/` | Full-page views (FlowDesigner, InstanceViewer, AgentDesigner, …) |
| `frontend/src/components/` | Shared components (GraphView, PropertyEditor, RunDialog, …) |
| `frontend/src/stores/` | Pinia stores (auth, theme) |
| `docker/` | Dockerfiles for backend + frontend |
| `docker-compose.yml` | Core stack (postgres, redis, backend, frontend) |
| `docker-compose.plugins.yml` | External plugin containers |
| `docker-compose.tls.yml` | TLS edge (nginx/Caddy) |
| `docker-compose.backup.yml` | Scheduled Postgres backups |
| `observability/` | Grafana + Tempo stack |
| `tests/` | Integration tests |
| `test/` | Backend unit tests (node:test) |

---

## Backend — Key Modules (2026-05-21)

### Engine (`backend/src/engine/`)

- **executor.js** — `execute(parsed, opts)` runs the DAG. Emits events per node (`node:start`, `node:done`, `node:error`). Handles:
  - Parallel branches (indegree tracking)
  - Retry with configurable max-retries + backoff
  - `WAITING_MARKER` — pauses a branch until a human/external system POSTs to `/executions/:id/nodes/:name/respond`
  - Batch fan-out
  - Node-level timeouts
- **scheduler.js** — `buildDag(nodes, edges)` produces topological execution order
- **limits.js** — `resolveNodeTimeoutMs`, `resolveMaxRetries`, `withTimeout`, `assertIterationCap`

### DSL (`backend/src/dsl/`)

- `${expr}` placeholders evaluated via **FEEL** (feelin library)
- Fast path for bare data paths (0-indexed); FEEL for compound expressions
- JS-isms (`&&`, `||`, `==`) auto-translated to FEEL equivalents
- `FEEL_HELPERS` exports `toJson()` / `parseJson()` into every eval context

### Plugins (`backend/src/plugins/`)

- **registry.js** — central plugin registry, resolves plugin by name
- **catalog.js** — marketplace catalog (fetched + cached 5 min), supports `PLUGIN_CATALOG_URL` / `PLUGIN_CATALOG_FILE` env overrides
- **builtin/** — in-process plugins (http, transform, email, SQL, MQTT, object-store, healthcheck, agent, …)
- **agent/** — agent plugin (calls LLM with tool-use)

### Auth (`backend/src/auth/`)

- JWT (access + refresh tokens), OIDC, SAML, API keys, RBAC v2, JIT grants, service accounts

### AI / Agent (`backend/src/`)

- AI provider abstraction — `anthropic` or any OpenAI-compatible API
- Config: `AI_PROVIDER`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`
- Default model: `claude-haiku-4-5-20251001` (Anthropic) / `gpt-4o-mini` (OpenAI)
- Features gated on AI key: Prompt tab, agent plugin, "Diagnose failure", plugin generator

### API Routes (`backend/src/api/`)

One file per resource: agents, ai, audit, auth, compliance, configs, crossProjectGrants, customRoles, evals, executions, graphs, guardrails, jitGrants, knowledgeBases, memory, modelRoutes, plugins, projectPlugins, projects, promptTemplates, quotas, resourceGrants, samlConfigs, serviceAccounts, triggers, users, webhooks, workflowMetrics, workspaces, batch

---

## Frontend — Key Modules (2026-05-21)

**Stack:** Vue 3, Quasar 2, Vue-Flow (DAG canvas), CodeMirror 6, Axios, Pinia, Vite

### Pages

| Page | Route purpose |
|------|--------------|
| `FlowDesigner.vue` | Visual DAG editor — drag, connect, configure nodes |
| `InstanceViewer.vue` | Read-only execution view — graph coloured by node status |
| `AgentDesigner.vue` | Build agent definitions |
| `TriggerDesigner.vue` | Cron/webhook/MQTT/email triggers |
| `ConfigDesigner.vue` | Key-value config sets with typed + KMS-encrypted values |
| `PluginsPage.vue` | Browse + install plugins from catalog |
| `HomePage.vue` | Dashboard / workflow list |
| `AdminPage.vue` | User/workspace admin |
| `KnowledgeBasesPage.vue` | RAG knowledge bases |
| `GuardrailsPage.vue` | LLM guardrail rules |
| `EvalsPage.vue` | Prompt evals |

### Components

- **GraphView.vue** — Vue-Flow canvas wrapper
- **PropertyEditor.vue** — Node config panel
- **RunDialog.vue** — Execution launch dialog
- **OrchestratorChat.vue** — Chat interface for AI assistant

---

## Database (PostgreSQL) — Migration History (2026-05-21)

| # | File | What it adds |
|---|------|-------------|
| 001 | init.sql | Core tables: workflows, executions, node_states |
| 002 | execution_inputs.sql | Execution input storage |
| 003 | drop_node_logs.sql | Removes legacy node logs |
| 004 | triggers.sql | Trigger definitions |
| 005–006 | configs*.sql | Config sets + typed values |
| 007 | dsl_json.sql | DSL stored as JSON |
| 008 | no_versions.sql | Removes versioning |
| 009 | agents.sql | Agent definitions |
| 010–011 | node_states*.sql | Node state attempts |
| 012 | memories.sql | Agent memory |
| 013 | configs_envelope.sql | KMS envelope encryption for configs |
| 014 | auth.sql | Auth tables |
| 015–016 | audit*.sql | Audit columns + log table |
| 017 | diagnoses.sql | Failure diagnoses |
| 018–019 | plugins*.sql | Plugin registry + versions |
| 020 | execution_tags.sql | Execution tagging |
| 021 | projects.sql | Multi-project/workspace |
| 022 | rbac_v2_extras.sql | RBAC v2 |
| 023 | audit_actor_kind.sql | Actor kind in audit |
| 024 | saml.sql | SAML SSO |
| 025 | agent_token_events.sql | Agent token usage tracking |
| 026–027 | knowledge_bases*.sql | RAG knowledge bases |
| 028 | guardrails.sql | LLM guardrails |
| 029 | prompts_and_evals.sql | Prompt templates + evals |
| 030 | model_routes.sql | AI model routing rules |
| 031 | compliance.sql | Compliance settings |
| 032 | plugin_categories.sql | Plugin category metadata |
| 033 | workflow_observability.sql | Workflow metrics |
| 034 | purge_legacy_plugins.sql | Clean up legacy plugins |

---

## Infrastructure & Deployment (2026-05-21)

### Services

| Service | Image | Port |
|---------|-------|------|
| `dag_postgres` | postgres:16-alpine | 5432 |
| `dag_redis` | redis:7-alpine | 6379 |
| `dag_backend` | local build or Docker Hub | 3000 |
| `dag_frontend` | local build or Docker Hub | 5173 (→ nginx:80) |

### Key env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `DATABASE_URL` | postgres://dag:dag@localhost:5432/dag_engine | Postgres |
| `REDIS_URL` | redis://localhost:6379 | Redis + BullMQ |
| `JWT_SECRET` | change-me | JWT signing |
| `ANTHROPIC_API_KEY` | — | Enables AI features (Anthropic) |
| `OPENAI_API_KEY` | — | Enables AI features (OpenAI-compatible) |
| `AI_PROVIDER` | auto-detected from keys | `anthropic` or `openai` |
| `AI_MODEL` | claude-haiku-4-5-20251001 / gpt-4o-mini | Model override |
| `SMTP_HOST` | — | Email plugin SMTP |
| `FILE_ROOT` | — | Sandbox root for file plugins |
| `WORKER_CONCURRENCY` | 4 | BullMQ worker concurrency |

### Running locally (dev, no Docker) — verified 2026-05-21

**Prerequisites (macOS/Homebrew):**
- PostgreSQL 16 (`brew install postgresql@16`) — must be running on port 5432
- Redis (`brew install redis`) — must be running on port 6379
- pgvector built for pg16 (NOT the Homebrew formula — it only ships pg17/pg18 dylibs).
  Build manually:
  ```bash
  git clone --branch v0.8.2 https://github.com/pgvector/pgvector.git /tmp/pgvector-pg16
  cd /tmp/pgvector-pg16
  PG_CONFIG=$(brew --prefix postgresql@16)/bin/pg_config make && make install
  ```
- Grant `dag` role superuser so it can `CREATE EXTENSION vector`:
  ```bash
  psql postgres -c "ALTER USER dag SUPERUSER;"
  ```

**One-time DB setup:**
```bash
psql postgres -c "CREATE ROLE dag WITH LOGIN PASSWORD 'dag';"
psql postgres -c "CREATE DATABASE dag_engine OWNER dag;"
cd backend && npm install && npm run migrate
node src/cli/createAdmin.js --email admin@daisy.local --password password123
```

**jsdom note:** `jsdom` is an unlisted dependency of `backend/src/rag/extract.js`.
Must install `jsdom@20` (not latest — v21+ has ESM compat issues with Node 21):
```bash
cd backend && npm install jsdom@20
```

**Start dev servers:**
```bash
# Terminal 1 — backend (watch mode, port 3000)
cd backend && npm run dev

# Terminal 2 — frontend (Vite, port 5173)
cd frontend && npm install && npm run dev
```

**Verify:**
- Backend health: http://localhost:3000/readyz  → `{"ok":true,...}`
- Frontend UI: http://localhost:5173  → login with admin@daisy.local / password123

### Running via Docker Compose (full stack)

```bash
docker compose --profile full up -d
docker compose exec backend npm run migrate
docker compose exec backend npm run create-admin
# Open http://localhost:5173
```

---

## Current Branch (2026-05-21)

`feature/docs-and-setup` — created from `main` to add docs and run the project locally.

---

## Notes / Open Items

- `JWT_SECRET` defaults to `change-me` — must be changed in any non-local deployment.
- `FILE_ROOT` should be set in shared/multi-user deployments to sandbox plugin file access.
- Plugin catalog is cached 5 min in memory; `?refresh=1` query param bypasses cache.
