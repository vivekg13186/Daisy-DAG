# Playwright UI test suite

Three layers — **smoke** (this one, ~2 min), **features** (~15 min, coming in Layer 2), **regression** (nightly, coming in Layer 3).

## First run

```bash
# From the DAG Engine repo root, boot the isolated test stack
# (Postgres + Redis + API + worker on non-default ports, tmpfs DB).
cd tests
npm install
npm run stack:up

# Run smoke. Playwright auto-launches the Vite dev server pointed
# at the test API; reuses an existing one on rerun.
npm run test:smoke
```

After the run:
- `npm run report` opens the HTML report.
- `npm run stack:down` tears the stack down (the data is in tmpfs so this is instant).

## What Layer 1 covers

| # | Spec | What it proves |
|---|---|---|
| 01 | `app-boots` | The SPA bundle loads, the LoginPage hydrates. |
| 02 | `login` | `/auth/login` works, admin lands on `/home`. |
| 03 | `create-workflow` | The FlowDesigner mounts for an existing workflow id. |
| 04 | `run-workflow` | The full execution pipeline (API → BullMQ → worker → plugin) finishes successfully. |
| 05 | `agent-call` | One agent call against the mock LLM responder produces a `success` execution. |
| 06 | `plugin-list` | `/plugins` surfaces all 44 builtins + the 15 legacy ones are gone. |

If any of these fail, *no Layer 2 or 3 test will run*. Smoke is the gate.

## How the mock LLM works

`helpers/llm-mock.js` boots a tiny HTTP server on `localhost:9123` that answers both OpenAI's `/chat/completions` and Anthropic's `/messages` with canned JSON. Tests that need an agent call create an `ai.provider` config pointing at `http://host.docker.internal:9123/v1` as the `baseUrl`. The API+worker (running inside docker) reach the mock through that host name.

## Adding new tests

1. **Fixtures via the API**, not by clicking through the UI. Add helpers to `helpers/api.js` if you need a new endpoint.
2. **Page Objects in `pages/`** — never put raw selectors in spec files. If a button gets renamed, only one POM file should change.
3. **One Layer per directory**:
   - `smoke/` — must finish in <30s per spec
   - `features/` — happy path + 1-2 edge cases per feature
   - `regression/` — cross-flow, multi-browser, visual diff, soak tests

## Layer 2 (next)

Run when you're ready to expand: see the parent project plan. Roughly 50 specs covering auth / workflows / agents / RAG / guardrails / evals / templates / model routes / admin / observability / plugins. ~15 min wall-clock when sharded across 4 workers.
