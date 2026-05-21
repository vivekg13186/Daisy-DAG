# Future Requests

Ideas, feasibility analysis, and implementation notes. Updated as new requests come in.

---

## FR-001 — First-Login Onboarding Tour

**Request:** When a user logs in for the first time, show a popup/tour guiding them through key setup steps — e.g. where to set the Anthropic API key.

### Feasibility: High

Straightforward to implement. No schema changes needed if we use `localStorage`; one boolean DB column (`users.onboarded`) if we want it to persist across devices/browsers.

### Analysis

**What needs to happen:**
1. Detect first login — either `localStorage.getItem('daisy_onboarded')` (simplest, per-browser) or a `users.onboarded` boolean column set via a `/auth/me PATCH` call (cross-device).
2. After successful login, if not onboarded, show a step-by-step dialog.
3. Mark onboarded on dismiss/complete so it never shows again.

**Tour content candidates:**
- Step 1 — "Set your AI key": Admin → Workspace Settings → AI Provider. Backend already exposes `GET /ai/status` → `{ configured, provider, model }`. The tour can check this and highlight the missing key visually.
- Step 2 — "Create your first workflow": point to the `+ New flow` button on HomePage.
- Step 3 — "Run a sample": import from `backend/samples/hello-world.json`.
- Step 4 — "Invite teammates": point to Admin → Users.

**Touch points in codebase:**
- `frontend/src/stores/auth.js` — `auth.boot()` resolves after login; this is the right place to check the flag and emit an event/store value.
- `frontend/src/pages/HomePage.vue` — natural landing page after login; mount the tour dialog here.
- `backend/src/api/auth.js` — could add `onboarded` field to the `/auth/me` response and a PATCH endpoint to mark it done.
- `backend/migrations/` — one new migration adding `onboarded BOOLEAN DEFAULT FALSE` to `users`.

**Recommended approach:** localStorage flag first (zero backend changes, ships fast). Promote to DB column later if cross-device sync becomes a requirement.

---

## FR-002 — 3-Legged OAuth for AI Providers (instead of raw API keys)

**Request:** Instead of users pasting Anthropic / OpenAI API keys, let them authorize via a standard OAuth flow (3-legged) so Daisy never sees the raw key.

### Feasibility: Low (Anthropic) / Medium (OpenAI) — but with caveats

### Analysis

**Anthropic:**
Anthropic does **not** offer a public 3-legged OAuth flow. Their API is key-based only. There is no `https://api.anthropic.com/oauth/authorize` endpoint. Workarounds would require proxying through a custom Anthropic-controlled app that does not exist as a public offering. **Not currently possible.**

**OpenAI:**
OpenAI has an OAuth integration via their "GPT Actions" / "ChatGPT plugins" flow, but that is scoped to ChatGPT itself, not arbitrary third-party apps calling the completions API. The completions/chat API still requires an API key or a service-account token — there is no standard OAuth token exchange that yields a bearer token for `api.openai.com/v1/chat/completions`. **Not currently possible via public API.**

**What 3-legged OAuth *would* require from the provider:**
- An authorization server endpoint (e.g. `GET /oauth/authorize`)
- A token exchange endpoint (`POST /oauth/token`)
- Scoped tokens that the completions API accepts as bearer tokens
- Token refresh support

Neither provider offers this for API access today.

**Practical alternatives worth considering instead:**

| Alternative | What it solves | Effort |
|-------------|---------------|--------|
| **Daisy-hosted proxy** | Admin sets one org-level key server-side; users never enter a key — they just use Daisy. Already partially supported: `ANTHROPIC_API_KEY` env var is workspace-level. | Already exists for self-hosted deployments |
| **AWS Bedrock / Azure OpenAI** | Enterprise deployments that use IAM roles or Azure AD for auth instead of raw keys. Daisy's AI provider abstraction (`AI_PROVIDER`, `AI_BASE_URL`) already supports OpenAI-compatible endpoints, so Azure OpenAI works today with just env vars. | Low — config only |
| **Per-user encrypted key storage** | User pastes key once via UI; Daisy stores it KMS-encrypted (envelope encryption is already in the codebase — see `013_configs_envelope.sql`). User never has to paste it again; key is not in plaintext in DB. | Medium — wire up the existing KMS envelope path to per-user AI keys |

**Recommendation:** The KMS envelope option is the most viable near-term improvement — it reuses infrastructure that already exists in the codebase and removes the "key stored in plaintext" concern without requiring provider-side OAuth support that doesn't exist.

---

---

## FR-003 — Prevent Save / Run with Missing Required Inputs

**Request:** Currently users can save and run a flow even when required plugin inputs are unfilled. The error only surfaces at runtime: *"Save failed: node "slack_post" missing required input "text" • nodes.slack_post.inputs.text required for action "slack.post""*. Instead, warn (or block) before save/run.

### Feasibility: High — server-side validation already exists, need to surface it earlier

### Analysis

**Where validation happens today:**
- `Graphs.validate(dsl)` is called on the backend (`POST /graphs/validate`) inside `onSave()` in `FlowDesigner.vue:388`. It checks required inputs per plugin and returns structured errors.
- But the errors are caught and re-thrown as a flat string (`formatValidationErr`), then shown as a single toast notification — easy to miss.

**What needs to change:**
1. **Better error display on save** — instead of a toast that disappears, show a persistent inline banner listing each node and its missing fields. The structured `details` array is already in the response (array of `{ path, message }`).
2. **Pre-run validation** — `onRunClick` currently only checks `dirty` and prompts to save. It should also call `Graphs.validate(dsl)` before opening the `RunDialog`, so a flow with missing required inputs can't be queued.
3. **Canvas visual feedback** — highlight nodes with validation errors (red border on the node card) so the user knows exactly which nodes to fix without reading the error text. This requires passing the error list down to `CanvasTab` → `PluginNode`.

**Touch points:**
- `frontend/src/pages/FlowDesigner.vue` — `onSave()` (better error display), `onRunClick()` (pre-run validation)
- `frontend/src/components/flow/nodes/PluginNode.vue` — add an error/warning badge when its node name appears in the validation error list
- `frontend/src/components/flow/CanvasTab.vue` — accept a `validationErrors` prop and pass it down to each node

---

## FR-004 — Config / Credential Inputs as Dropdowns (not free-text)

**Request:** Plugin inputs that represent a stored configuration (e.g. `slack_config` on the `slack.post` plugin) should render as a **dropdown** populated with the configs the Admin has set up, rather than a free-text field.

### Feasibility: High — config list endpoint + input metadata already exist

### Analysis

**How configs work today:**
- Admin creates config sets under `Admin → Configs` (key-value stores, optionally KMS-encrypted).
- In a workflow node, the user manually types the config name into a text field.
- There is no connection between the field and the available configs — no validation, no autocomplete.

**What the plugin manifest needs:**
The manifest's `inputSchema` has no `format` that signals "this is a config reference". One of:
1. Add a new format string, e.g. `"format": "config-ref"`, to the manifest schema for fields that expect a config name.
2. OR: rely on a naming convention — any input field named `*_config` or `*Config` is treated as a config reference.

Option 1 is cleaner and already has precedent — the codebase uses `"format": "textarea"` to render multi-line inputs (the AJV warnings in the logs confirm this is the extension point already in use).

**How the dropdown would work:**
1. `PropertyEditor.vue` / `PluginPropertyPanel.vue` detects `format: "config-ref"` on an input field.
2. It calls `GET /configs` (endpoint already exists, `Configs.list()` in `client.js`) and renders a `<q-select>` populated with config names.
3. User picks a config from the dropdown — the value written to the node's inputs is the config name string, unchanged from today, so no DSL or backend changes are needed.

**Touch points:**
- Plugin manifests — add `"format": "config-ref"` to relevant inputs (e.g. `slack.post`, `sql.*`, `email.send`)
- `frontend/src/components/flow/nodes/PluginPropertyPanel.vue` (or wherever individual input fields are rendered) — add a `config-ref` case that renders a `<q-select>` with live data from `Configs.list()`
- No backend changes needed

---

*Add new requests below with the next FR-### number.*
