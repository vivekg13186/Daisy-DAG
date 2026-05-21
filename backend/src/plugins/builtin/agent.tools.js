// agent.tools — LLM agent with function calling.
//
// Give the model a list of allowed plugins as "tools" and let it
// invoke them (potentially several rounds) to answer a user query.
// Each tool call runs through the engine's plugin registry — so any
// plugin already in Daisy is callable, with all its existing
// guardrails / quotas / cost rollup intact.
//
// Inputs:
//   agent:         title of a stored agent — supplies provider creds,
//                  guardrails override, telemetry binding. The agent's
//                  prompt is NOT ignored (unlike extract/classify) —
//                  it's kept as the system message so users can shape
//                  the persona / behaviour.
//   input:         user text
//   tools:         array of allowed plugin names — e.g.
//                    ["rag.retrieve", "sql.select", "object.store.read"]
//                  OR with overrides:
//                    [{ name: "sql.select", description: "...", schema: {...} }]
//   maxIterations: ceiling on tool-call rounds (default 6)
//   maxTokens:     per-turn output cap (default 2048)
//
// Output:
//   {
//     text:        final assistant response text,
//     toolTrail:   [{ name, args, output, error, iter }],  // every call we issued
//     iterations:  number of model turns we used,
//     stopReason:  why we stopped ("stop" | "max_iterations" | "tool_error_stop"),
//     usage:       { inputTokens, outputTokens }
//   }
//
// Provider support: openai, anthropic, azure-openai, gemini, ollama.
// Bedrock will follow once we add a Converse-toolConfig path.

import { loadAgent } from "../agent/util.js";
import { callWithTools } from "../agent/toolDispatch.js";
import { chargeTokens } from "../../engine/limits.js";
import {
  loadProjectPolicy,
  mergePolicy,
  applyGuardrails,
} from "../../guardrails/apply.js";
import { registry } from "../registry.js";
import { render as renderPrompt } from "../../prompts/render.js";

const DEFAULT_MAX_ITERATIONS = 6;
const HARD_MAX_ITERATIONS    = 20;

export default {
  name: "agent.tools",
  category: "ai",
  description:
    "LLM agent with function calling. The model can invoke any of the " +
    "named Daisy plugins as tools and loop until it has enough info to " +
    "answer. Tool calls run through the normal plugin registry, so " +
    "guardrails / quotas / cost rollup all still apply. Provider " +
    "support: openai, anthropic, azure-openai, gemini, ollama.",

  inputSchema: {
    type: "object",
    required: ["agent", "input", "tools"],
    properties: {
      agent: {
        type: "string", minLength: 1, title: "Agent",
        description: "Title of a stored agent (Home → Agents).",
      },
      input: {
        type: "string", format: "textarea", title: "User input",
      },
      tools: {
        title: "Allowed tools",
        description:
          "Array of plugin names (e.g. \"sql.select\") OR objects " +
          "with { name, description?, schema? } to override the " +
          "registry's default description / inputSchema for this call.",
      },
      maxIterations: {
        type: "integer", minimum: 1, maximum: HARD_MAX_ITERATIONS,
        default: DEFAULT_MAX_ITERATIONS,
        title: "Max iterations",
        description: "Hard ceiling on tool-call rounds before forcing a final answer.",
      },
      maxTokens: {
        type: "integer", minimum: 1, maximum: 16000, default: 2048,
        title: "Max output tokens per turn",
      },
      vars: {
        type: "object",
        title: "Template variables",
        description:
          "Object of values for `${var}` placeholders when the agent " +
          "is bound to a prompt template.",
      },
    },
  },

  primaryOutput: "text",

  outputSchema: {
    type: "object",
    required: ["text", "iterations", "stopReason"],
    properties: {
      text:       { type: "string" },
      toolTrail: {
        type: "array",
        items: {
          type: "object",
          properties: {
            iter:   { type: "integer" },
            name:   { type: "string" },
            args:   { type: "object" },
            output: {},
            error:  { type: ["string", "null"] },
          },
        },
      },
      iterations: { type: "integer" },
      stopReason: { type: "string" },
      usage: {
        type: "object",
        properties: {
          inputTokens:  { type: "integer" },
          outputTokens: { type: "integer" },
        },
      },
    },
  },

  async execute(input, ctx, hooks) {
    const { agent, cfg } = await loadAgent(ctx, input.agent);

    // System prompt: respect the agent's prompt / template (unlike
    // extract/classify which generate their own). Append a one-liner
    // reminding the model about the tool list — helps weaker models.
    const baseSystem = agent.template_body
      ? renderPrompt(agent.template_body, { ...(input.vars || {}), input: input.input, agent: agent.title })
      : (agent.prompt || "");
    const tools = resolveTools(input.tools);
    const toolListSummary = tools.map(t => `- ${t.name}: ${t.description}`).join("\n");
    const systemPrompt = [
      baseSystem,
      "",
      "Tools you may call (pick at most one per turn; prefer not calling a tool when the answer is clear):",
      toolListSummary,
    ].join("\n").trim();

    const maxIterations = Math.min(HARD_MAX_ITERATIONS,
      Math.max(1, input.maxIterations ?? DEFAULT_MAX_ITERATIONS));
    const maxTokens = input.maxTokens ?? 2048;

    // ── Guardrails: input side (once, on the raw user input) ──────
    const workspaceId = ctx?.execution?.workspaceId;
    const projectId   = ctx?.execution?.projectId;
    const guardrailCtx = {
      workspaceId, projectId,
      executionId: ctx?.execution?.id || null,
      node:        ctx?.node?.name || null,
      agentId:     agent.id,
      agentTitle:  agent.title,
    };
    const projectPolicy = await loadProjectPolicy(projectId);
    const policy = mergePolicy(projectPolicy, agent.guardrails_override);
    let userText = String(input.input ?? "");
    {
      const r = await applyGuardrails({ text: userText, side: "input", policy, ctx: guardrailCtx });
      if (r.text !== userText) {
        userText = r.text;
        if (hooks?.stream?.log) {
          hooks.stream.log("warn",
            `guardrails redacted input (${r.violations.map(v => v.detector).join(", ")})`);
        }
      }
    }

    // ── Pre-call quota check (same as agent / structured plugins) ─
    if (projectId) {
      try {
        const { assertQuota } = await import("../../auth/quotas.js");
        await assertQuota(projectId, "tokens_per_month");
      } catch (e) {
        if (e.code === "QUOTA_EXCEEDED") throw e;
      }
    }

    // ── Tool-using loop ────────────────────────────────────────────
    const convo     = [{ role: "user", text: userText }];
    const toolTrail = [];
    let totalUsage  = { inputTokens: 0, outputTokens: 0 };
    let finalText   = "";
    let stopReason  = "max_iterations";

    for (let iter = 1; iter <= maxIterations; iter++) {
      const step = await callWithTools({
        cfg,
        system:    systemPrompt,
        convo,
        tools,
        maxTokens,
      });
      totalUsage = sumUsage(totalUsage, step.usage);
      chargeTokens(ctx, ctx?._parsed, (step.usage?.inputTokens || 0) + (step.usage?.outputTokens || 0));

      if (hooks?.stream?.log) {
        if (step.toolCalls.length) {
          hooks.stream.log("info",
            `iter ${iter}: ${step.toolCalls.length} tool call(s): ` +
            step.toolCalls.map(tc => tc.name).join(", "));
        } else if (step.text) {
          hooks.stream.log("info", `iter ${iter}: final answer (${step.text.length} chars)`);
        }
      }

      // No tool calls → the model is done. Persist the final answer.
      if (step.toolCalls.length === 0) {
        finalText = step.text;
        stopReason = step.stopReason === "length" ? "max_tokens" : "stop";
        break;
      }

      // Record the model's turn so the next round has the full history.
      convo.push({ role: "assistant", text: step.text, toolCalls: step.toolCalls });

      // Execute each requested tool through the engine's normal
      // invoke path. We run them sequentially (most flows benefit
      // from determinism; parallelism inside one turn is rare and
      // makes guardrail attribution noisy).
      const results = [];
      for (const tc of step.toolCalls) {
        let output = null, error = null;
        try {
          // Validate the call against the allow-list (model might
          // hallucinate a name that wasn't in `tools`).
          const allowed = tools.find(t => t.name === tc.name);
          if (!allowed) {
            error = `Tool "${tc.name}" is not in the allowed list for this call.`;
          } else {
            // Hand off to the plugin registry — same path the
            // executor uses for normal node execution. Per-call
            // ctx is the same workflow ctx so memory/configs are
            // visible to the tool.
            output = await registry.invoke(tc.name, tc.args || {}, ctx, hooks);
          }
        } catch (e) {
          error = e.message || String(e);
        }
        results.push({ id: tc.id, name: tc.name, args: tc.args, output, error });
        toolTrail.push({ iter, name: tc.name, args: tc.args, output, error });
      }
      convo.push({ role: "tool", results });

      // If every tool errored, force-stop so we don't burn iterations
      // looping on the same failure. Letting one bad call retry is
      // fine — only stop when the model can't make any progress.
      if (results.every(r => r.error)) {
        stopReason = "tool_error_stop";
        finalText = step.text || "";
        break;
      }
    }

    // ── Quota increment + telemetry (one row for the whole loop) ──
    if (projectId) {
      try {
        const { incrementUsage } = await import("../../auth/quotas.js");
        incrementUsage(projectId, "tokens_per_month",
          (totalUsage.inputTokens || 0) + (totalUsage.outputTokens || 0))
          .catch(() => {});
        const { recordAgentTokenEvent } = await import("../agent/usage.js");
        recordAgentTokenEvent({
          workspaceId, projectId,
          executionId:  ctx?.execution?.id || null,
          agentId:      agent.id,
          agentTitle:   agent.title,
          provider:     cfg.provider,
          model:        cfg.model,
          inputTokens:  totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          cacheHit:     false,
          latencyMs:    0,
          kind:         "tools",
        }).catch(() => {});
      } catch { /* telemetry-grade */ }
    }

    // ── Guardrails: output side (once, on the final text) ──────────
    {
      const r = await applyGuardrails({ text: finalText, side: "output", policy, ctx: guardrailCtx });
      if (r.text !== finalText) {
        finalText = r.text;
        if (hooks?.stream?.log) {
          hooks.stream.log("warn",
            `guardrails redacted output (${r.violations.map(v => v.detector).join(", ")})`);
        }
      }
    }

    return {
      text:       finalText,
      toolTrail,
      iterations: Math.min(toolTrail.length ? toolTrail[toolTrail.length - 1].iter + (stopReason === "stop" ? 0 : 0) : 1, maxIterations),
      stopReason,
      usage:      totalUsage,
    };
  },
};

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Normalise the `tools` input into the toolDispatch's ToolSpec shape,
 * pulling description + schema from each plugin's registry entry. The
 * caller can pass either a bare list of names or per-entry overrides.
 */
function resolveTools(rawTools) {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    throw new Error("agent.tools: `tools` must be a non-empty array of plugin names or {name, description, schema} objects");
  }
  const out = [];
  for (const t of rawTools) {
    const ref = typeof t === "string" ? { name: t } : (t || {});
    if (!ref.name) {
      throw new Error("agent.tools: each tool entry needs a `name`");
    }
    let plugin;
    try { plugin = registry.get(ref.name); }
    catch (e) {
      throw new Error(`agent.tools: tool "${ref.name}" — ${e.message}`);
    }
    out.push({
      name:        plugin.name,
      // Per-call overrides win — handy when the operator wants to
      // tighten a description for a specific use ("only search the
      // billing KB", say).
      description: ref.description || plugin.description || `Call ${plugin.name}`,
      schema:      ref.schema      || plugin.inputSchema || { type: "object" },
    });
  }
  return out;
}

function sumUsage(a, b) {
  return {
    inputTokens:  (a?.inputTokens  || 0) + (b?.inputTokens  || 0),
    outputTokens: (a?.outputTokens || 0) + (b?.outputTokens || 0),
  };
}
