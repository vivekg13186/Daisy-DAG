// guardrail.check — run the configured guardrail detectors over an
// arbitrary string, outside of an agent call.
//
// Three common uses:
//   • Classify a user's input before deciding whether to route it to
//     a public agent or escalate to a human (e.g. block jailbreak
//     attempts in mode=warn, then executeIf on `blocked == true`).
//   • Scrub PII from a payload before persisting it to an external
//     system (set mode=redact and use `text` as the cleaned value).
//   • Probe arbitrary content (rag.retrieve results, web.scrape output)
//     for unsafe terms before feeding them to the model.
//
// Policy resolution mirrors the agent plugin: the project default
// is loaded, optionally merged with an agent-level override (when
// `agent` is set), and then applied to the supplied text.
//
// Inputs:
//   text:         string to scan
//   side:         "input" (default) | "output" — drives which apply_to
//                 setting on the policy fires
//   agent:        optional — when set, the agent's guardrails_override
//                 is merged on top of the project policy (so the same
//                 policy stack as an agent call is used)
//   detectors:    optional override array, e.g. ["pii", "jailbreak"] —
//                 only those detectors run for this call
//
// Output:
//   {
//     text:       possibly redacted text,
//     blocked:    true when a block-mode detector fired (errors are
//                 surfaced as a structured result rather than a thrown
//                 error so the caller can branch),
//     violations: [{ detector, mode, action_taken, details }, …],
//   }

import { pool } from "../../db/pool.js";
import {
  loadProjectPolicy,
  mergePolicy,
  applyGuardrails,
  GuardrailBlockedError,
  DEFAULT_POLICY,
} from "../../guardrails/apply.js";

export default {
  name: "guardrail.check",
  category: "ai",
  description:
    "Run the project's guardrail policy over arbitrary text and " +
    "return a possibly-redacted result + the list of violations. " +
    "Useful for pre-screening user input or post-processing tool " +
    "output before feeding it elsewhere. Pass `agent` to use that " +
    "agent's per-agent override stack.",

  inputSchema: {
    type: "object",
    required: ["text"],
    properties: {
      text: {
        type: "string", format: "textarea", title: "Text",
        description: "String to scan. Usually a `${var}` reference.",
      },
      side: {
        type: "string", enum: ["input", "output"], default: "input",
        title: "Side",
        description:
          "input → fires when policy.apply_to is 'input' or 'both'. " +
          "output → fires when policy.apply_to is 'output' or 'both'.",
      },
      agent: {
        type: "string", title: "Agent (optional)",
        description:
          "Title of a stored agent. When set, the agent's " +
          "guardrails_override is merged on top of the project policy.",
      },
      detectors: {
        type: "array",
        items: { type: "string", enum: ["pii", "jailbreak", "toxicity"] },
        title: "Detector override",
        description:
          "Optional. Only these detectors run for this call (still " +
          "subject to the resolved policy's enabled flag).",
      },
    },
  },

  primaryOutput: "blocked",

  outputSchema: {
    type: "object",
    required: ["text", "blocked", "violations"],
    properties: {
      text:    { type: "string", description: "Possibly redacted text." },
      blocked: { type: "boolean" },
      violations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            detector:     { type: "string" },
            mode:         { type: "string" },
            action_taken: { type: "string" },
            details:      { type: "object" },
          },
        },
      },
    },
  },

  async execute(input, ctx) {
    const text = String(input.text ?? "");
    const side = input.side === "output" ? "output" : "input";
    const workspaceId = ctx?.execution?.workspaceId || null;
    const projectId   = ctx?.execution?.projectId   || null;

    let agentRow = null;
    if (input.agent) {
      // Pull the agent's override blob if a name was supplied. We
      // skip loadAgent (it requires a config) and just read the row.
      const { rows } = await pool.query(
        `SELECT id, title, guardrails_override FROM agents WHERE title = $1`,
        [input.agent],
      );
      if (rows.length === 0) {
        throw new Error(
          `guardrail.check: agent "${input.agent}" not found (skip the agent input to use the project-default policy).`,
        );
      }
      agentRow = rows[0];
    }

    const projectPolicy = await loadProjectPolicy(projectId);
    let policy = mergePolicy(projectPolicy, agentRow?.guardrails_override || null);

    // Apply the optional detector subset by zeroing out any detector
    // not on the list. We do it by cloning + flipping enabled=false on
    // detectors that aren't requested. This keeps mergePolicy + the
    // applyGuardrails contract untouched.
    if (Array.isArray(input.detectors) && input.detectors.length) {
      const allow = new Set(input.detectors);
      const next = { apply_to: policy.apply_to, config: {} };
      for (const name of Object.keys(policy.config || {})) {
        const src = policy.config[name] || DEFAULT_POLICY.config[name];
        next.config[name] = allow.has(name) ? src : { ...src, enabled: false };
      }
      policy = next;
    }

    const guardrailCtx = {
      workspaceId,
      projectId,
      executionId: ctx?.execution?.id || null,
      node:        ctx?.node?.name || null,
      agentId:     agentRow?.id || null,
      agentTitle:  agentRow?.title || null,
    };

    try {
      const { text: outText, violations } = await applyGuardrails({
        text, side, policy, ctx: guardrailCtx,
      });
      return { text: outText, blocked: false, violations };
    } catch (e) {
      if (e instanceof GuardrailBlockedError) {
        // Surface block-mode firings as a structured result. The
        // workflow author chose `guardrail.check` (not the inline
        // path inside the agent plugin) precisely because they want
        // to branch on the outcome rather than fail the node.
        return {
          text,
          blocked: true,
          violations: [{
            detector:     e.detector,
            mode:         "block",
            action_taken: "blocked",
            details:      e.details || {},
          }],
        };
      }
      throw e;
    }
  },
};
