// agent.extract — schema-guided structured extraction.
//
// Take a JSON Schema and a chunk of source text; return data matching
// the schema. On validation failure, retry up to `maxRetries` times,
// appending the validator's diagnostics back to the prompt so the
// model can correct itself.
//
// Common uses:
//   • Pull invoices/IDs/dates out of OCR'd PDFs
//   • Normalise free-text contact info into a clean contact object
//   • Convert support-ticket descriptions into structured incident rows
//
// Inputs:
//   agent:        title of a stored agent — gives us provider creds,
//                 guardrails override, telemetry binding. The agent's
//                 prompt is IGNORED; this plugin builds its own.
//   schema:       JSON Schema the output must satisfy
//   text:         source text to extract from
//   instruction:  optional plain-English hint ("extract only the
//                 buyer address; ignore seller details")
//   maxRetries:   how many self-correct attempts before giving up
//
// Output:
//   { data, valid, attempts, raw, usage, errors }
//     • data    — parsed JSON (matches schema when valid=true)
//     • valid   — true if Ajv accepted the final attempt
//     • errors  — Ajv's last-attempt errors (only when valid=false)
//     • attempts — array of { text, errors } so workflows can debug

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { loadAgent, tryParseJson } from "../agent/util.js";
import { runOneShot } from "../agent/structured.js";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export default {
  name: "agent.extract",
  category: "ai",
  description:
    "Extract a structured object matching a JSON Schema from source " +
    "text. Validates the result with Ajv and self-corrects on failure " +
    "(up to maxRetries). The bound agent supplies provider creds + " +
    "guardrails; its prompt is ignored — this plugin builds its own.",

  inputSchema: {
    type: "object",
    required: ["agent", "schema", "text"],
    properties: {
      agent: {
        type: "string",
        title: "Agent",
        minLength: 1,
        description:
          "Title of a stored agent (Home → Agents). Used for provider " +
          "creds + guardrails + cost tracking.",
      },
      schema: {
        title: "JSON Schema",
        description:
          "JSON Schema describing the shape of the desired output. " +
          "Usually a `${var}` reference to an object built upstream " +
          "or pasted inline.",
      },
      text: {
        type: "string",
        title: "Source text",
        format: "textarea",
        description: "Text to extract from. Usually a `${var}` reference.",
      },
      instruction: {
        type: "string",
        title: "Extra instruction",
        format: "textarea",
        description:
          "Optional plain-English nudge prepended to the system " +
          "prompt — useful for picking between multiple candidates in " +
          "the source.",
      },
      maxRetries: {
        type: "integer", minimum: 0, maximum: 5, default: 2,
        title: "Max self-correction retries",
      },
      maxTokens: {
        type: "integer", minimum: 1, maximum: 16000, default: 2048,
        title: "Max output tokens",
      },
    },
  },

  primaryOutput: "data",

  outputSchema: {
    type: "object",
    required: ["valid", "attempts"],
    properties: {
      data:     { description: "Parsed JSON object (matches `schema` when valid=true)." },
      valid:    { type: "boolean" },
      attempts: { type: "integer" },
      raw:      { type: "string" },
      usage:    { type: "object" },
      errors:   { type: ["array", "null"] },
    },
  },

  async execute(input, ctx, hooks) {
    const { agent, cfg } = await loadAgent(ctx, input.agent);

    const schema = parseSchemaInput(input.schema);
    let validate;
    try { validate = ajv.compile(schema); }
    catch (e) {
      throw new Error(`agent.extract: invalid JSON Schema — ${e.message}`);
    }

    const maxRetries = Math.max(0, Math.min(5, input.maxRetries ?? 2));
    const maxTokens  = input.maxTokens ?? 2048;
    const baseSystem = buildExtractSystem(schema, input.instruction);

    let attempts = 0;
    let lastText = "";
    let lastUsage = { inputTokens: 0, outputTokens: 0 };
    let lastErrors = null;
    let lastData  = null;
    let attemptLog = [];

    // First attempt + up to N retries. Each retry feeds the previous
    // diagnostic back into the prompt so the model knows what to fix.
    for (let i = 0; i <= maxRetries; i++) {
      attempts = i + 1;
      const system = i === 0
        ? baseSystem
        : `${baseSystem}\n\n` +
          `Your previous response did not match the schema. ` +
          `Re-emit a single JSON object that fixes these errors:\n` +
          ajvErrorList(lastErrors);
      const { text, usage } = await runOneShot({
        agent, cfg,
        systemPrompt:   system,
        userText:       String(input.text ?? ""),
        maxTokens,
        ctx, hooks,
        telemetryKind:  "extract",
      });
      lastText  = text;
      lastUsage = sumUsage(lastUsage, usage);

      const parsed = tryParseJson(text);
      if (parsed == null) {
        lastErrors = [{ instancePath: "", message: "response was not valid JSON" }];
        attemptLog.push({ text, errors: lastErrors });
        continue;
      }
      const ok = validate(parsed);
      lastData = parsed;
      lastErrors = ok ? null : validate.errors;
      attemptLog.push({ text, errors: lastErrors });
      if (ok) {
        return {
          data:     parsed,
          valid:    true,
          attempts,
          raw:      text,
          usage:    lastUsage,
          errors:   null,
        };
      }
    }
    // All attempts failed. Return the best-effort parsed object (may
    // be null if the last response wasn't JSON at all) so downstream
    // nodes can decide whether to fail or fall back.
    return {
      data:     lastData,
      valid:    false,
      attempts,
      raw:      lastText,
      usage:    lastUsage,
      errors:   lastErrors,
    };
  },
};

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function parseSchemaInput(s) {
  if (s == null) throw new Error("agent.extract: `schema` is required");
  if (typeof s === "object") return s;
  if (typeof s === "string") {
    try { return JSON.parse(s); }
    catch (e) {
      throw new Error(`agent.extract: \`schema\` is not valid JSON — ${e.message}`);
    }
  }
  throw new Error(`agent.extract: \`schema\` must be a JSON Schema object or a JSON string (got ${typeof s})`);
}

function buildExtractSystem(schema, instruction) {
  const schemaText = JSON.stringify(schema, null, 2);
  const extra = instruction ? `\n\nAdditional instruction:\n${instruction}` : "";
  return [
    "You are a structured-data extraction model.",
    "Read the user's source text and emit a SINGLE JSON value that satisfies",
    "the schema below. Output JSON only — no markdown, no commentary, no",
    "fenced code block. If a field can't be filled, use null.",
    "",
    "Schema:",
    "```json",
    schemaText,
    "```",
    extra,
  ].join("\n");
}

function ajvErrorList(errors) {
  if (!errors || !errors.length) return "(no errors)";
  return errors.slice(0, 10).map(e => `- ${e.instancePath || "<root>"}: ${e.message}`).join("\n");
}

function sumUsage(a, b) {
  return {
    inputTokens:  (a?.inputTokens  || 0) + (b?.inputTokens  || 0),
    outputTokens: (a?.outputTokens || 0) + (b?.outputTokens || 0),
  };
}
