// "Ask AI" assistant — proxies chat completions to Anthropic or any
// OpenAI-compatible API. The system prompt is built from the live plugin
// registry so the model always sees the current actions + their schemas.
//
// Endpoints:
//   GET  /ai/status        → { configured, provider, model }
//   POST /ai/chat          → body: { messages: [{role, content}] }
//                            res:  { message: { role: "assistant", content } }
//
//   POST /ai/agent/chat    → body: { messages, graphId?, currentGraph? }
//                            res:  {
//                              message: { role: "assistant", content },
//                              proposedGraph?:    <DSL object>,                  // set when update_graph fired
//                              workflowsCreated?: [{ id, name }],                // append-only, every create_workflow this turn
//                              triggerCreated?:   { id, name, type },            // set when create_trigger fired
//                              agentCreated?:     { id, title },                 // set when create_agent fired
//                              pluginRequest?:    { prompt, summary, transport },// set when request_plugin fired
//                              traces:            [{ tool, input, summary }],   // ordered tool calls
//                            }
//
// Two modes, distinguished by whether the caller is in the editor or on
// the centralised Ask-Agent surface:
//
//   • Editor mode  (`currentGraph` supplied, optionally `graphId`):
//     `update_graph` mutates the editor draft. The user clicks Save.
//     `create_trigger` requires a saved `graphId`.
//
//   • Global mode  (no `currentGraph`, no `graphId`):
//     The agent saves artifacts itself, in order. Use `create_workflow`
//     to persist a workflow (sets `ctx.graphId` for follow-up
//     `create_trigger` calls), `create_agent` for personas. Don't dump
//     JSON in chat asking the user to save — call the tool.
//
// Tools:
//   • get_current_graph()              → editor draft (editor mode only)
//   • update_graph(dsl)                → editor mode: validates DSL into
//                                        `proposedGraph` for the editor.
//                                        Don't use in global mode.
//   • create_workflow(dsl)             → global mode: INSERT into graphs,
//                                        sets ctx.graphId so a follow-up
//                                        create_trigger attaches to it.
//   • list_triggers()                  → triggers attached to graphId (or all)
//   • create_trigger({name,type,config}) → INSERT into triggers; needs
//                                        ctx.graphId (set by create_workflow
//                                        or by the editor mode).
//   • list_configs()                   → name + type for every stored config
//   • list_agents()                    → every AI agent persona defined here
//   • create_agent({title,prompt,configName,description?}) → INSERT into agents
//   • request_plugin({prompt,summary?,transport?}) → set ctx.pluginRequest.
//                                        Doesn't generate the plugin — flags
//                                        the conversation so the frontend
//                                        can offer a hand-off card to the
//                                        Plugins admin page's dedicated
//                                        generator (which the model can't
//                                        call directly because it's admin-
//                                        only and the bundle needs operator
//                                        review).

import { Router } from "express";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { registry } from "../plugins/registry.js";
import { parseDag } from "../dsl/parser.js";
import { pool } from "../db/pool.js";
import { triggerRegistry } from "../triggers/registry.js";
import { syncTrigger } from "../triggers/manager.js";
import { ValidationError, HttpError } from "../utils/errors.js";
import { requireUser, requireRole } from "../middleware/auth.js";
import { limiters } from "../middleware/rateLimit.js";
import {
  getWorkspaceAiConfig,
  setWorkspaceAiSettings,
  clearWorkspaceAiSettings,
} from "../workspaces/aiSettings.js";

const router = Router();

// All AI endpoints require an authenticated caller. The "Ask AI"
// helper writes to triggers / proposes graphs scoped to the caller's
// workspace, so the caller's role and workspace_id flow through into
// each tool implementation via the `ctx` object passed to runAgentLoop.
router.use(requireUser);

router.get("/status", requireRole("admin", "editor", "viewer"), async (req, res, next) => {
  try {
    const aiCfg = await getWorkspaceAiConfig(req.user.workspaceId);
    const k     = aiCfg.apiKey;
    const expectedPrefix = aiCfg.provider === "anthropic" ? "sk-ant-" : "sk-";
    const warnings = [];

    if (aiCfg.source === "env") {
      // Env-var diagnostics (whitespace stripping etc.) only apply when the
      // key came from the environment, not when it was saved through the UI.
      if (k && k.length !== config.ai.rawKeyLen) {
        warnings.push(`stripped ${config.ai.rawKeyLen - k.length} whitespace/quote char(s) from the env value`);
      }
    }
    if (k && !k.startsWith(expectedPrefix)) {
      warnings.push(`provider=${aiCfg.provider} but key does not start with "${expectedPrefix}"`);
    }
    if (k && k.length < 20) {
      warnings.push(`key looks too short (${k.length} chars)`);
    }

    res.json({
      configured: Boolean(k),
      provider:   aiCfg.provider,
      model:      aiCfg.model,
      baseUrl:    aiCfg.baseUrl,
      source:     aiCfg.source,
      keyPreview: k ? `${k.slice(0, 8)}…${k.slice(-4)} (${k.length} chars)` : null,
      warnings,
    });
  } catch (e) { next(e); }
});

// ── GET /ai/settings — return current workspace AI settings (key masked) ──────
router.get("/settings", requireRole("admin"), async (req, res, next) => {
  try {
    const aiCfg = await getWorkspaceAiConfig(req.user.workspaceId);
    res.json({
      source:     aiCfg.source,
      provider:   aiCfg.provider,
      model:      aiCfg.model,
      baseUrl:    aiCfg.baseUrl,
      configured: Boolean(aiCfg.apiKey),
      keyPreview: aiCfg.apiKey
        ? `${aiCfg.apiKey.slice(0, 8)}…${aiCfg.apiKey.slice(-4)} (${aiCfg.apiKey.length} chars)`
        : null,
      // Return separately what is overridden in the DB so the form can pre-fill.
      dbOverrides: await _getDbOverrides(req.user.workspaceId),
    });
  } catch (e) { next(e); }
});

// ── PUT /ai/settings — save API key + optional overrides (admin only) ─────────
router.put("/settings", requireRole("admin"), async (req, res, next) => {
  try {
    const { provider, apiKey, model, baseUrl } = req.body || {};
    if (!apiKey?.trim() && !provider && !model && !baseUrl) {
      throw new ValidationError("Provide at least one field to update (apiKey, provider, model, or baseUrl)");
    }
    await setWorkspaceAiSettings(req.user.workspaceId, {
      provider: provider?.trim() || undefined,
      apiKey:   apiKey?.trim()   || undefined,
      model:    model?.trim()    || undefined,
      baseUrl:  baseUrl?.trim()  || undefined,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── DELETE /ai/settings — remove DB-stored settings, revert to env vars ───────
router.delete("/settings", requireRole("admin"), async (req, res, next) => {
  try {
    await clearWorkspaceAiSettings(req.user.workspaceId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Read the raw (non-decrypted) overrides stored in the DB for the settings form. */
async function _getDbOverrides(workspaceId) {
  const row = await pool.query(
    "SELECT ai_settings FROM workspaces WHERE id = $1",
    [workspaceId],
  ).then(r => r.rows[0]);
  const s = row?.ai_settings || {};
  return {
    provider:   s.provider  || null,
    model:      s.model     || null,
    baseUrl:    s.base_url  || null,
    hasApiKey:  Boolean(s.api_key_enc),
  };
}

// ──────────────────────────────────────────────────────────────────────
// /chat — the legacy single-shot endpoint. Still wired up so older clients
// (and the JSON-tab "Ask AI" button) keep working.
// ──────────────────────────────────────────────────────────────────────
router.post("/chat", limiters.ai, requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError("`messages` array required");
    }
    const aiCfg = await getWorkspaceAiConfig(req.user.workspaceId);
    if (!aiCfg.apiKey) {
      throw new HttpError(503, "AI_NOT_CONFIGURED",
        "AI is not configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the backend env, or save a key in Admin → Workspace.");
    }

    const cleanMessages = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20);
    if (cleanMessages.length === 0) throw new ValidationError("no valid messages");

    const system = buildSystemPrompt({ agentMode: false });
    const text = await callPlainLlm(system, cleanMessages, aiCfg);
    res.json({ message: { role: "assistant", content: text } });
  } catch (e) { next(e); }
});

// ──────────────────────────────────────────────────────────────────────
// /agent/chat — tool-use loop. Each call returns the assistant's final
// text reply plus any side-effects that fired during the loop (proposed
// graph, created trigger, ordered trace of every tool call).
// ──────────────────────────────────────────────────────────────────────
router.post("/agent/chat", limiters.ai, requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const { messages, graphId, currentGraph } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError("`messages` array required");
    }
    const aiCfg = await getWorkspaceAiConfig(req.user.workspaceId);
    if (!aiCfg.apiKey) {
      throw new HttpError(503, "AI_NOT_CONFIGURED",
        "AI is not configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the backend env, or save a key in Admin → Workspace.");
    }

    const cleanMessages = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-30);
    if (cleanMessages.length === 0) throw new ValidationError("no valid messages");

    const ctx = {
      graphId:          graphId || null,
      currentGraph:     currentGraph || null,    // mutated by update_graph
      proposedGraph:    null,
      // Global Ask-Agent can save several workflows in one turn (e.g.
      // "Inbox triage" + "Query Handler"), so we collect a list instead
      // of a single slot.
      workflowsCreated: [],
      triggerCreated:   null,
      agentCreated:     null,
      pluginRequest:    null,
      // Mode hint surfaced to the system prompt and the tool guards:
      //   "editor" — the request came from a workflow editor; update_graph
      //              mutates the draft and the user clicks Save.
      //   "global" — the centralised Ask-Agent on the home page; the
      //              agent saves artifacts itself with create_workflow /
      //              create_agent / create_trigger.
      mode:             currentGraph ? "editor" : "global",
      traces:           [],
      // Workspace surface so list_triggers / list_configs / list_agents /
      // create_workflow / create_trigger / create_agent are scoped to the
      // caller. Without this the AI agent could see / create resources
      // across workspace boundaries.
      workspaceId:      req.user.workspaceId,
      role:             req.user.role,
      // Forwarded into create_* tools so the resulting row carries the
      // caller as its updated_by for audit.
      userId:           req.user.id,
    };

    const system = buildSystemPrompt({ agentMode: true, ctx });
    const finalText = await runAgentLoop({ system, messages: cleanMessages, ctx, aiCfg });

    res.json({
      message:          { role: "assistant", content: finalText },
      proposedGraph:    ctx.proposedGraph,
      workflowsCreated: ctx.workflowsCreated,
      triggerCreated:   ctx.triggerCreated,
      agentCreated:     ctx.agentCreated,
      pluginRequest:    ctx.pluginRequest,
      traces:           ctx.traces,
    });
  } catch (e) { next(e); }
});

// ---------- system prompt ----------

function buildSystemPrompt({ agentMode = false, ctx = null } = {}) {
  const plugins = registry.list();
  const pluginDocs = plugins.map(p => {
    const inputProps  = listProps(p.inputSchema);
    const outputProps = listProps(p.outputSchema);
    return `### ${p.name}
${p.description || "(no description)"}
Inputs: ${inputProps || "(none)"}
Outputs: ${outputProps || "(none)"}${p.primaryOutput ? `
primaryOutput: ${p.primaryOutput}` : ""}`;
  }).join("\n\n");

  const triggerDocs = triggerRegistry.list().map(t => {
    const cs = listProps(t.configSchema);
    return `### trigger:${t.type}
${t.description || ""}
Config: ${cs || "(none)"}`;
  }).join("\n\n");

  const dslRef = `# DSL reference (JSON)

\`\`\`json
{
  "name": "<flow name>",
  "description": "<free text>",
  "data": { "someKey": "someValue" },
  "nodes": [
    {
      "name": "<unique node name>",
      "action": "<plugin id>",
      "description": "<optional>",
      "inputs":     { "key1": "literal", "key2": "\${var}" },
      "outputs":    { "pluginField": "ctxVar" },
      "executeIf":  "\${expr}",
      "retry":      3,
      "retryDelay": "500ms",
      "onError":    "terminate",
      "batchOver":  "\${array}",
      "outputVar":  "<ctx var name>"
    }
  ],
  "edges": [ { "from": "<nodeName>", "to": "<nodeName>" } ]
}
\`\`\`

Field notes:
- \`description\` is optional everywhere.
- \`inputs\` is a flat object — keys are plugin input names, values are literals or \${expr} references.
- \`outputs\` maps plugin output paths (dot paths OK, e.g. "body.id") to ctx variable names.
- \`executeIf\` skips a node when false; descendants reachable only through it cascade to skipped.
- \`retry\` defaults to 0; \`retryDelay\` accepts ms or "500ms"/"2s" duration strings.
- \`onError\` is "terminate" (default) or "continue".
- \`batchOver\` fans out: runs once per item; \${item} and \${index} are exposed.
- \`outputVar\`: the engine writes the plugin's primary output to ctx[outputVar] after each run.
- Do NOT include a \`version\` field — it is no longer part of the schema.

## Expression rules
- \${url} resolves from data block + run input.
- \${nodes.<nodeName>.output.<path>} reads a previous node's full output.
- Expressions are FEEL (Friendly Enough Expression Language). Comparison is \`=\` (not \`==\`); logical ops are \`and\` / \`or\` / \`not\`. JS-style \`==\` / \`&&\` / \`||\` are translated automatically for back-compat.
- \`config.<configName>.<field>\` reads a stored configuration's field.

# Available action plugins

${pluginDocs}

# Available trigger types

${triggerDocs}`;

  if (!agentMode) {
    return `You are an AI assistant for the **DAG Workflow Engine** — a JSON-driven DAG runner. Help the user understand the DSL, choose plugins, and write workflow snippets.

${dslRef}

# Output guidelines
- When you generate a workflow, output it inside a fenced \`\`\`json block — the UI offers a "Use this JSON" button.
- Reference only plugins listed above.
- Keep prose answers short; lead with the example.`;
  }

  // Agent-mode prompt. Two operating modes; the system prompt swaps the
  // "how you work" section accordingly so the model doesn't ask the user
  // to "save the workflow first" in global mode (where there's no editor).
  const mode = ctx?.mode || (ctx?.currentGraph ? "editor" : "global");

  const ctxBlurb = mode === "editor"
    ? `Mode: **editor**. The user is currently editing a workflow named "${ctx.currentGraph?.name || "(unnamed)"}" with ${ctx.currentGraph?.nodes?.length || 0} node(s)${ctx.graphId ? ` (saved as id ${ctx.graphId})` : " (not yet saved)"}. Mutate the draft with update_graph; the user clicks Save.`
    : `Mode: **global**. No workflow editor is open — you are the home-page Ask Agent. You can produce workflows, agents, and triggers in one conversation and **save them yourself in order** using the create_* tools. Never tell the user "save the workflow first then I'll continue" — that's the editor flow. In global mode you handle the saves.`;

  const toolsSection = mode === "editor"
    ? `You drive the editor through tools:
- **get_current_graph** — read what's already on the canvas before changing it.
- **update_graph** — replace the working draft with a new DSL. The user must still click Save afterwards; never describe a workflow as "saved".
- **list_configs** — only call this when you need a config the user mentioned (credentials, broker, provider). Don't enumerate configs the user didn't ask about. Reference configs by name in plugin inputs (\`"config": "<name>"\`); never invent a config name.
- **list_triggers** — check existing triggers attached to this workflow before proposing a new one.
- **create_trigger** — only after the workflow is saved (it needs a graphId). If the user wants a trigger and the workflow isn't saved yet, tell them to save first.
- **list_agents** — see existing AI agent personas defined in this workspace, so workflows can reference one through the \`agent\` plugin.
- **create_agent** — define a new AI agent persona. Titles are unique per workspace; the agent plugin looks them up by title (\`agent: "<title>"\`).`
    : `You drive the whole pipeline yourself — there is no editor to defer to. The tools to use:
- **create_workflow** — saves a new workflow to the DB and returns its id. After this call, follow-up \`create_trigger\` will attach to the just-saved workflow. Call this once per workflow the user described.
- **create_agent** — saves a new AI agent persona by title + system prompt + the name of an existing \`ai.provider\` config.
- **create_trigger** — saves a trigger that fires the last-created workflow (\`schedule\` / \`webhook\` / \`email\` / \`mqtt\`). Always run **after** create_workflow for the same workflow.
- **list_agents** — call before \`create_agent\` to avoid duplicating an existing title.
- **list_triggers** — only call if the user asked you to attach to / review an existing trigger.
- **list_configs** — only call when the user's request needs a config (credentials, broker, mail server, ai.provider) that you haven't seen them name yet. Don't list configs proactively.
- **request_plugin** — when the user asks you to *build a new plugin* (not a workflow that uses existing plugins). Call this with a short summary of what the plugin should do and a refined version of the user's prompt; the frontend will show a hand-off card that opens the Plugin Generator on the Plugins admin page with the prompt pre-filled. **Never refuse a plugin request as "out of scope" — call request_plugin.** You are also free to combine: e.g. for "build a Slack plugin and a workflow that uses it", call request_plugin to hand off the plugin generation, then continue saving the dependent workflow with create_workflow that references the planned plugin's action name.
- **update_graph** / **get_current_graph** — editor-only. Don't use these here.`;

  const rulesSection = mode === "editor"
    ? `1. **Ask before guessing.** If the request is ambiguous (which config? which schedule? which fields?), ask one focused question before calling any tool.
2. **Iterate, don't restart.** When the user says "add X" or "tweak Y", call \`get_current_graph\` first and emit a complete-but-minimally-changed graph through \`update_graph\`.
3. **Explain what you did.** After tool calls, briefly summarise what changed. Don't paste the full JSON unless the user asks.
4. **Triggers.** Before \`create_trigger\`, call \`list_triggers\` and offer to reuse an existing one if the type/config matches. After creating, mention the trigger's name and that it's now active.
5. **Configs are read-only here.** You can't create configs — only triggers and agents. Only call \`list_configs\` when the request involves credentials/broker/provider and you don't already know the name. If a needed config doesn't exist, tell the user to add one through Home → Configurations.
6. **Agents.** For "an agent that does X" requests: \`list_agents\` (avoid duplicates) → if you need an \`ai.provider\` config name you don't have, \`list_configs\` → \`create_agent\`.
7. **DSL correctness.** Every \`update_graph\` call must produce a graph that validates: unique node names matching \`^[A-Za-z_][A-Za-z0-9_.-]*$\`, every edge endpoint references an existing node, no cycles, plugin inputs match the schemas above. The server validates and you'll get an error back if it fails — fix and retry.`
    : `1. **Save in order, end-to-end.** When the user describes a multi-piece task ("read emails, classify them, fire a follow-up workflow") build the dependency order in your head, then call the tools in that order: any **plugins** the workflow needs that don't exist yet (\`request_plugin\` — see rule 8), any **agents** the workflows depend on (\`create_agent\`), then each **workflow** (\`create_workflow\`), then the **triggers** for each (\`create_trigger\`). Don't stop halfway and ask the user to save manually — that's the editor flow, not yours. Just keep calling tools until everything is in place.
2. **Don't dump JSON and stop.** If you have a workflow ready, call \`create_workflow\` with it. Never reply with a JSON workflow in chat as a substitute for saving it; the user is relying on you to persist it.
3. **Only ask about a config when one is missing.** Don't enumerate configs the user didn't mention. If you're about to make an agent/trigger/workflow that needs a credential (LLM provider, SMTP server, MQTT broker, DB) you haven't been told the name of, *then* call \`list_configs\` and either pick the obvious match or ask the user which one to use. If no suitable config exists, name what's missing and tell the user to add it through Home → Configurations, then continue with the parts you can save.
4. **Ask before guessing only when the answer would change the artifact.** Schedules, intent labels, the exact subject/body fields to extract — yes. Cosmetic details — just pick a sensible default.
5. **Reuse what's already there.** Before \`create_agent\`, call \`list_agents\`; if a fitting one exists, reference it instead of creating a duplicate. Same for triggers: before attaching a schedule to a brand-new workflow, you're fine to skip \`list_triggers\` — it's a fresh row — but if the user mentions an existing one, look first.
6. **After saving, recap briefly.** One paragraph: which workflows/agents/triggers were created, the trigger schedule, and how the pieces fit together. Quote names in backticks. Don't paste the workflow JSON.
7. **DSL correctness.** Every \`create_workflow\` call must produce a graph that validates: unique node names matching \`^[A-Za-z_][A-Za-z0-9_.-]*$\`, every edge endpoint references an existing node, no cycles, plugin inputs match the schemas above. If the server rejects it, fix the issue and retry — don't ask the user.
8. **Plugins are not out of scope — hand off, don't refuse.** If the user asks you to *build a new plugin* (a brand-new action type, e.g. "build a Slack plugin", "create a plugin that posts to Discord"), **never reply "I can't create plugins"** — call \`request_plugin\` with a refined prompt for the dedicated Plugin Generator that lives on the Plugins admin page. The frontend will render a hand-off card the user can click to jump there with the prompt pre-filled. After calling, briefly mention that you've prepared the hand-off and (if relevant) note any workflow you'll still build once the plugin is installed. If the user is asking for a *workflow that uses an existing plugin*, that's not request_plugin — just call create_workflow as usual using the existing plugin's id.`;

  return `You are the **AI Workflow Designer** for the DAG Engine. The user describes what they want; you build it.

${ctxBlurb}

# How you work

${toolsSection}

# Conversation rules

${rulesSection}

${dslRef}

# Style

- Concise. Bullet a change list when it's complex; otherwise one short paragraph.
- Quote node / trigger / config / agent names in backticks.
- Don't restate the user's request before answering.`;
}

function listProps(schema) {
  if (!schema || !schema.properties) return "";
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties)
    .map(([k, v]) => {
      const req = required.has(k) ? "*" : "";
      const t = v?.type || (v?.enum ? `enum(${v.enum.join("|")})` : "any");
      return `${k}${req}: ${t}`;
    })
    .join(", ");
}

// ──────────────────────────────────────────────────────────────────────
// Tool registry — definitions + handlers shared by both providers.
// ──────────────────────────────────────────────────────────────────────

const TOOL_DEFS = [
  {
    name: "get_current_graph",
    description:
      "Read the working draft of the workflow currently open in the editor. " +
      "Returns the DSL object (or null if the canvas is empty). " +
      "Always call this before modifying — the user may have edited the canvas since the last update_graph.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "update_graph",
    description:
      "EDITOR MODE ONLY. Replace the editor's working draft with a new DSL. The DSL is validated " +
      "server-side; an invalid DSL returns an `errors` list and the editor is NOT touched. " +
      "The user must still click Save in the toolbar to persist. In global Ask-Agent mode use " +
      "create_workflow instead — there is no editor draft to mutate.",
    input_schema: {
      type: "object",
      required: ["dsl"],
      properties: {
        dsl: {
          type: "object",
          description:
            "Full DAG DSL. Must include `name` and a non-empty `nodes` array. Do NOT include a `version` field.",
        },
      },
    },
  },
  {
    name: "create_workflow",
    description:
      "GLOBAL MODE. Save a brand-new workflow directly to the database. After this call, " +
      "`create_trigger` will attach to the just-saved workflow (the new id becomes the active graphId " +
      "for this conversation). Use this in the centralised Ask-Agent surface where there is no editor " +
      "to mutate. Returns { id, name } on success. Fails if a workflow of the same name already exists.",
    input_schema: {
      type: "object",
      required: ["dsl"],
      properties: {
        dsl: {
          type: "object",
          description:
            "Full DAG DSL. Must include `name` and a non-empty `nodes` array. Do NOT include a `version` field.",
        },
      },
    },
  },
  {
    name: "list_triggers",
    description:
      "List triggers attached to the currently-open workflow (or all triggers, " +
      "if the workflow hasn't been saved yet). Each result includes id, name, type, config, enabled.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_trigger",
    description:
      "Create a new trigger that fires the currently-open workflow. " +
      "Requires the workflow to be saved already (graphId must be present). " +
      "type must be one of the available trigger types (schedule / webhook / email / mqtt). " +
      "config must validate against that type's schema.",
    input_schema: {
      type: "object",
      required: ["name", "type", "config"],
      properties: {
        name:   { type: "string", description: "Display name for the trigger." },
        type:   { type: "string", description: "Trigger type id (schedule / webhook / email / mqtt)." },
        config: { type: "object", description: "Driver-specific configuration." },
      },
    },
  },
  {
    name: "list_configs",
    description:
      "List existing stored configurations (database / mail.smtp / mail.imap / mqtt / ai.provider / generic) by name + type. " +
      "Use this to verify a config name exists before referencing it from plugin inputs. Secret fields are NOT returned.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_agents",
    description:
      "List AI agent personas already defined in this workspace. Each result has title, configName, description, " +
      "and a prompt preview. Workflows reference these by title via the `agent` plugin (`agent: \"<title>\"`).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_agent",
    description:
      "Create a new named AI agent persona. The agent pairs a system prompt with a stored ai.provider config; workflows " +
      "invoke it through the `agent` plugin by title. Titles must be unique per workspace and match " +
      "^[A-Za-z0-9 _.\\-]+$. configName must already exist (see list_configs) and be of type ai.provider — " +
      "if no ai.provider config exists, tell the user to add one through Home → Configurations first.",
    input_schema: {
      type: "object",
      required: ["title", "prompt", "configName"],
      properties: {
        title:       { type: "string", description: "Unique display title. Letters, digits, spaces, _ . - only." },
        prompt:      { type: "string", description: "System prompt for the agent." },
        configName:  { type: "string", description: "Name of an existing ai.provider config." },
        description: { type: "string", description: "Optional short description shown in the agents list." },
      },
    },
  },
  {
    name: "request_plugin",
    description:
      "Flag the conversation so the user is offered a hand-off to the Plugin Generator on the Plugins admin page. " +
      "Use this whenever the user asks to BUILD a new plugin (a new action type) — not when they ask for a workflow " +
      "that uses an existing plugin. You don't actually generate the plugin here; you just record a refined prompt " +
      "for the dedicated generator. The frontend renders a card with an Open Plugin Generator button that opens the " +
      "Plugins page with the prompt prefilled. NEVER refuse plugin requests as out-of-scope — call this tool.",
    input_schema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt:    { type: "string", description: "A focused prompt for the Plugin Generator: what the plugin does, inputs, outputs, side-effects. Rewrite the user's request into the clearest possible spec." },
        summary:   { type: "string", description: "One-line summary to show on the hand-off card." },
        transport: { type: "string", enum: ["http", "stdio"], description: "Preferred transport. Defaults to 'http' if omitted." },
      },
    },
  },
];

async function runTool(name, input, ctx) {
  switch (name) {
    case "get_current_graph": return toolGetCurrentGraph(ctx);
    case "update_graph":      return toolUpdateGraph(input, ctx);
    case "create_workflow":   return toolCreateWorkflow(input, ctx);
    case "list_triggers":     return toolListTriggers(ctx);
    case "create_trigger":    return toolCreateTrigger(input, ctx);
    case "list_configs":      return toolListConfigs(ctx);
    case "list_agents":       return toolListAgents(ctx);
    case "create_agent":      return toolCreateAgent(input, ctx);
    case "request_plugin":    return toolRequestPlugin(input, ctx);
    default: return { ok: false, error: `unknown tool: ${name}` };
  }
}

function toolGetCurrentGraph(ctx) {
  if (!ctx.currentGraph) return { ok: true, graph: null, note: "Canvas is empty." };
  return { ok: true, graph: ctx.currentGraph };
}

function toolUpdateGraph(input, ctx) {
  if (!input || typeof input.dsl !== "object" || !input.dsl) {
    return { ok: false, error: "`dsl` must be an object" };
  }
  // parseDag accepts an object directly. It throws ValidationError on issues.
  try {
    const parsed = parseDag(input.dsl);
    ctx.proposedGraph = parsed;
    ctx.currentGraph  = parsed;   // subsequent get_current_graph reads see the update
    return {
      ok: true,
      summary: `Validated. ${parsed.nodes.length} node(s), ${parsed.edges?.length || 0} edge(s). The editor will apply this DSL on the user side; the user must click Save to persist.`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message || "validation failed",
      details: e.details || undefined,
    };
  }
}

// Global Ask-Agent path: persist the workflow ourselves rather than handing
// it back to an editor. Mirrors POST /graphs (api/graphs.js) — same parser,
// same column shape, same unique-name conflict handling. Side-effects:
//
//   • Inserts the row into graphs.
//   • Pins ctx.graphId to the new id, so a follow-up create_trigger
//     attaches a trigger to *this* workflow without the user having to
//     re-state which one.
//   • Appends to ctx.workflowsCreated for the response surface.
async function toolCreateWorkflow(input, ctx) {
  if (!input || typeof input.dsl !== "object" || !input.dsl) {
    return { ok: false, error: "`dsl` must be an object" };
  }
  let parsed;
  try { parsed = parseDag(input.dsl); }
  catch (e) {
    return {
      ok: false,
      error: e.message || "validation failed",
      details: e.details || undefined,
    };
  }

  const id = uuid();
  // graphs.dsl is TEXT — store the JSON serialisation so the inspector
  // can show the source the agent supplied. `parsed` is the normalised
  // form used by the runtime.
  const dslText = JSON.stringify(input.dsl);
  try {
    await pool.query(
      `INSERT INTO graphs (id, name, dsl, parsed, workspace_id, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, parsed.name, dslText, JSON.stringify(parsed), ctx.workspaceId, ctx.userId || null],
    );
  } catch (e) {
    if (e.code === "23505") {
      return {
        ok: false,
        error: `a workflow named "${parsed.name}" already exists. Pick a different name or ask the user how to handle it.`,
      };
    }
    return { ok: false, error: `database error: ${e.message}` };
  }

  // Pin the new workflow as the active one so subsequent create_trigger
  // calls in this same turn don't need the model to thread an id around.
  ctx.graphId      = id;
  ctx.currentGraph = parsed;
  ctx.workflowsCreated.push({ id, name: parsed.name });

  return {
    ok: true,
    summary:
      `Workflow "${parsed.name}" saved (${parsed.nodes.length} node(s), ` +
      `${parsed.edges?.length || 0} edge(s)). It is now the active workflow — ` +
      `subsequent create_trigger calls will attach to it.`,
    workflow: { id, name: parsed.name },
  };
}

async function toolListTriggers(ctx) {
  const params = [ctx.workspaceId];
  const where = ["workspace_id = $1"];
  if (ctx.graphId) { params.push(ctx.graphId); where.push(`graph_id=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT id, name, graph_id, type, config, enabled, fire_count, last_fired_at
       FROM triggers WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT 50`,
    params,
  );
  return {
    ok: true,
    scope: ctx.graphId ? "current-graph" : "all",
    triggers: rows.map(r => ({
      id: r.id, name: r.name, type: r.type,
      config: r.config, enabled: r.enabled,
      graphId: r.graph_id, fireCount: r.fire_count,
    })),
  };
}

async function toolCreateTrigger(input, ctx) {
  if (!ctx.graphId) {
    return {
      ok: false,
      error: "Cannot create a trigger before the workflow is saved. Tell the user to click Save in the toolbar, then ask them to retry.",
    };
  }
  const { name, type, config: triggerCfg } = input || {};
  if (!name || !type) return { ok: false, error: "name and type are required" };
  try {
    triggerRegistry.validateConfig(type, triggerCfg || {});
  } catch (e) {
    return { ok: false, error: `config did not validate: ${e.message}` };
  }
  // Verify the target graph belongs to the caller's workspace before
  // attaching a trigger to it.
  const { rows: gs } = await pool.query(
    "SELECT id FROM graphs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL",
    [ctx.graphId, ctx.workspaceId],
  );
  if (gs.length === 0) {
    return { ok: false, error: "graph not found in this workspace" };
  }
  const id = uuid();
  await pool.query(
    `INSERT INTO triggers (id, name, graph_id, type, config, enabled, workspace_id, updated_by)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7)`,
    [id, name, ctx.graphId, type, JSON.stringify(triggerCfg || {}), ctx.workspaceId, ctx.userId || null],
  );
  await syncTrigger(id);
  ctx.triggerCreated = { id, name, type };
  return {
    ok: true,
    summary: `Trigger "${name}" (${type}) created and enabled. It will start firing the workflow now.`,
    trigger: { id, name, type },
  };
}

async function toolListConfigs(ctx) {
  const { rows } = await pool.query(
    `SELECT name, type, description FROM configs WHERE workspace_id=$1 ORDER BY name`,
    [ctx.workspaceId],
  );
  return { ok: true, configs: rows };
}

async function toolListAgents(ctx) {
  const { rows } = await pool.query(
    `SELECT title, config_name, description, prompt
       FROM agents
      WHERE workspace_id=$1
      ORDER BY title`,
    [ctx.workspaceId],
  );
  return {
    ok: true,
    agents: rows.map(r => ({
      title:       r.title,
      configName:  r.config_name,
      description: r.description,
      // Truncate prompt so we don't blow up the model's context with long
      // system prompts when the LLM only needs a hint about what each
      // agent does. The full prompt is available via the Agents page UI.
      promptPreview: typeof r.prompt === "string"
        ? (r.prompt.length > 240 ? `${r.prompt.slice(0, 240)}…` : r.prompt)
        : "",
    })),
  };
}

// Agent titles are unique per workspace and become the lookup key for the
// `agent` plugin (`agent: "<title>"`). They must match this regex —
// keep it in sync with TITLE_RE in api/agents.js so the LLM gets the
// same friendly error the REST endpoint would produce.
const AGENT_TITLE_RE = /^[A-Za-z0-9 _.\-]+$/;

async function toolCreateAgent(input, ctx) {
  const { title, prompt, configName, description } = input || {};
  if (!title || !prompt || !configName) {
    return { ok: false, error: "title, prompt, and configName are required" };
  }
  if (typeof title !== "string" || !title.trim()) {
    return { ok: false, error: "title must be a non-empty string" };
  }
  if (!AGENT_TITLE_RE.test(title.trim())) {
    return {
      ok: false,
      error: "title may contain letters, digits, spaces, underscores, dots, and dashes only",
    };
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, error: "prompt must be a non-empty string" };
  }
  if (typeof configName !== "string" || !configName.trim()) {
    return { ok: false, error: "configName must be a non-empty string" };
  }

  // Validate the linked config exists in this workspace and is an ai.provider.
  const { rows: cfgRows } = await pool.query(
    "SELECT type FROM configs WHERE name=$1 AND workspace_id=$2",
    [configName, ctx.workspaceId],
  );
  if (cfgRows.length === 0) {
    return {
      ok: false,
      error: `config "${configName}" not found in this workspace. ` +
             `Call list_configs to find an existing ai.provider config, or tell the user to add one via Home → Configurations.`,
    };
  }
  if (cfgRows[0].type !== "ai.provider") {
    return {
      ok: false,
      error: `config "${configName}" is type "${cfgRows[0].type}", but agents require type ai.provider.`,
    };
  }

  const id = uuid();
  try {
    await pool.query(
      `INSERT INTO agents (id, title, prompt, config_name, description, workspace_id, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        title.trim(),
        prompt,
        configName,
        description || null,
        ctx.workspaceId,
        ctx.userId || null,
      ],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { ok: false, error: `an agent titled "${title}" already exists in this workspace` };
    }
    return { ok: false, error: `database error: ${e.message}` };
  }
  ctx.agentCreated = { id, title: title.trim() };
  return {
    ok: true,
    summary: `Agent "${title.trim()}" created (linked to config "${configName}"). Workflows can invoke it through the agent plugin: \`agent: "${title.trim()}"\`.`,
    agent: { id, title: title.trim(), configName },
  };
}

// "Hand-off" tool — the plugin generator on the Plugins admin page is the
// real worker. This tool just records the user's intent so the frontend
// can offer an Open Plugin Generator card with the prompt pre-filled.
// Deliberately doesn't call /plugins/agent/generate from here: (1) that
// endpoint is admin-only and we don't want to elevate this tool's auth
// surface; (2) the generator output needs operator review before install
// — building it into a chat would skip that review; (3) it returns a
// large file bundle that doesn't belong in chat history.
function toolRequestPlugin(input, ctx) {
  const { prompt, summary, transport } = input || {};
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, error: "prompt is required" };
  }
  const t = transport === "stdio" ? "stdio" : "http";
  ctx.pluginRequest = {
    prompt:    prompt.trim(),
    summary:   typeof summary === "string" ? summary.trim() : "",
    transport: t,
  };
  return {
    ok: true,
    summary: `Plugin request prepared (transport=${t}). The user will see a hand-off card to the Plugin Generator on the Plugins page.`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Provider abstraction. Two paths through the same agent loop, one per
// API shape. Both return the final assistant text and append to ctx.traces
// as tool calls fire.
// ──────────────────────────────────────────────────────────────────────

const MAX_TOOL_TURNS = 8;

async function runAgentLoop({ system, messages, ctx, aiCfg }) {
  if (aiCfg.provider === "anthropic") {
    return runAnthropicAgent({ system, messages, ctx, aiCfg });
  }
  return runOpenAIAgent({ system, messages, ctx, aiCfg });
}

// -------- plain (non-tool) calls used by /chat --------

async function callPlainLlm(system, messages, aiCfg) {
  if (aiCfg.provider === "anthropic") return callAnthropicPlain(system, messages, aiCfg);
  return callOpenAIPlain(system, messages, aiCfg);
}

async function callOpenAIPlain(system, messages, aiCfg) {
  const url = `${aiCfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${aiCfg.apiKey}`,
    },
    body: JSON.stringify({
      model: aiCfg.model,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: aiCfg.maxTokens,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new HttpError(res.status, "AI_ERROR", `OpenAI: ${res.status} ${txt.slice(0, 500)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callAnthropicPlain(system, messages, aiCfg) {
  const url = `${aiCfg.baseUrl.replace(/\/$/, "")}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": aiCfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: aiCfg.model,
      max_tokens: aiCfg.maxTokens,
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new HttpError(res.status, "AI_ERROR", anthropicErrHint(res.status, txt, aiCfg));
  }
  const data = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks.filter(b => b.type === "text").map(b => b.text).join("");
}

// -------- Anthropic agent loop --------

async function runAnthropicAgent({ system, messages, ctx, aiCfg }) {
  const url = `${aiCfg.baseUrl.replace(/\/$/, "")}/messages`;
  // Anthropic messages can carry mixed content blocks; build them from our
  // {role, content} pairs (content is plain text from the user-facing chat).
  const conversation = messages.map(m => ({
    role:    m.role,
    content: [{ type: "text", text: m.content }],
  }));

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": aiCfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       aiCfg.model,
        max_tokens:  aiCfg.maxTokens,
        system,
        tools:       TOOL_DEFS,
        messages:    conversation,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new HttpError(res.status, "AI_ERROR", anthropicErrHint(res.status, txt));
    }
    const data = await res.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];

    // Append the assistant message verbatim — Anthropic requires the full
    // content blocks (including tool_use ids) to be echoed when we send
    // back tool_result on the next turn.
    conversation.push({ role: "assistant", content: blocks });

    const toolUses = blocks.filter(b => b.type === "tool_use");
    if (toolUses.length === 0) {
      // Final answer — concatenate all text blocks.
      return blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    }

    // Run every tool call in this turn and feed results back together.
    const results = [];
    for (const tu of toolUses) {
      const result = await runTool(tu.name, tu.input || {}, ctx);
      ctx.traces.push({ tool: tu.name, input: tu.input || {}, summary: summariseResult(tu.name, result) });
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: !result?.ok,
      });
    }
    conversation.push({ role: "user", content: results });
  }

  // Bailed out because the model kept calling tools forever — return whatever
  // the last assistant text was, plus a note. (Rare; the cap is generous.)
  return "(I hit my tool-use limit before finishing. The last set of changes are applied; ask me to continue if more is needed.)";
}

// -------- OpenAI agent loop (works with any chat-completions-compatible
// provider that supports tool calls). --------

async function runOpenAIAgent({ system, messages, ctx, aiCfg }) {
  const url = `${aiCfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const conversation = [
    { role: "system", content: system },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];
  const tools = TOOL_DEFS.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type":  "application/json",
        "authorization": `Bearer ${aiCfg.apiKey}`,
      },
      body: JSON.stringify({
        model:       aiCfg.model,
        messages:    conversation,
        tools,
        tool_choice: "auto",
        max_tokens:  aiCfg.maxTokens,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new HttpError(res.status, "AI_ERROR", `OpenAI: ${res.status} ${txt.slice(0, 500)}`);
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new HttpError(502, "AI_ERROR", "OpenAI returned no message");

    conversation.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls || undefined,
    });

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) {
      return (msg.content || "").trim();
    }
    for (const c of calls) {
      const name = c.function?.name;
      let parsed = {};
      try { parsed = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; }
      catch { parsed = {}; }
      const result = await runTool(name, parsed, ctx);
      ctx.traces.push({ tool: name, input: parsed, summary: summariseResult(name, result) });
      conversation.push({
        role:         "tool",
        tool_call_id: c.id,
        content:      JSON.stringify(result),
      });
    }
  }
  return "(I hit my tool-use limit before finishing.)";
}

function summariseResult(name, result) {
  if (!result?.ok) return `error: ${result?.error || "unknown"}`;
  if (name === "update_graph")    return result.summary || "graph updated";
  if (name === "create_workflow") return result.summary || "workflow saved";
  if (name === "create_trigger")  return result.summary || "trigger created";
  if (name === "create_agent")    return result.summary || "agent created";
  if (name === "request_plugin")  return result.summary || "plugin hand-off prepared";
  if (name === "list_triggers")   return `${result.triggers?.length || 0} trigger(s)`;
  if (name === "list_configs")    return `${result.configs?.length || 0} config(s)`;
  if (name === "list_agents")     return `${result.agents?.length || 0} agent(s)`;
  if (name === "get_current_graph") return result.graph
    ? `current graph: ${result.graph.name} (${result.graph.nodes?.length || 0} nodes)`
    : "no graph";
  return "ok";
}

function anthropicErrHint(status, txt, aiCfg) {
  let hint = "";
  if (status === 401) {
    const k = aiCfg?.apiKey || config.ai.apiKey;
    const masked = k ? `${k.slice(0, 8)}…${k.slice(-4)} (${k.length} chars)` : "(none)";
    const prefixWrong = k && !k.startsWith("sk-ant-");
    hint = ` — server received key ${masked}.` +
      (prefixWrong ? " The key does not start with sk-ant-, which Anthropic requires." : "") +
      " Common causes: trailing whitespace, wrong key copied (OpenAI vs Anthropic), or revoked key. Check GET /ai/status.";
  }
  return `Anthropic: ${status} ${String(txt).slice(0, 500)}${hint}`;
}

export default router;
