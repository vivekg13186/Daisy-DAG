// Tool/function-calling adapters for agent.tools.
//
// Two provider shapes are wildly different, so each gets its own
// translator. The plugin (builtin/agent.tools.js) is provider-agnostic
// — it speaks ONLY in this module's neutral shape:
//
//   ToolSpec  = { name: string, description: string, schema: object }
//   Step      = {
//     text:       string,         // free-text the model emitted
//     toolCalls:  ToolCall[],     // tool requests the model wants run
//     usage:      { inputTokens, outputTokens },
//     stopReason: string,         // "stop" | "tool_use" | "length"
//   }
//   ToolCall  = { id: string, name: string, args: object }
//
// And the conversation between turns is carried in a neutral
// `convo` array (we build provider-shaped messages just before
// sending). Each turn appends:
//   { role: "assistant", text, toolCalls }
//   { role: "tool", results: [{ id, name, output, error }] }
//
// Provider support:
//   openai / azure-openai / ollama (anything OpenAI-compatible) →
//     native tools API
//   anthropic → native tools API (input_schema)
//   gemini    → function_declarations
//   bedrock   → uses Converse toolConfig — not in v1, friendly error
//
// Anyone calling this module who hands a provider we don't support
// yet gets a clear "tool use not supported on provider X" error so
// they can pick a different provider or fall back to plain agent.

import { sliceLast } from "./util.js";

const OPENAI_FAMILY = new Set(["openai", "azure-openai", "ollama"]);

/**
 * Single turn of a tool-using conversation.
 *
 *   await callWithTools({ cfg, system, convo, tools, maxTokens })
 *
 * Returns Step.
 */
export async function callWithTools({ cfg, system, convo, tools, maxTokens }) {
  const provider = cfg.provider;
  if (OPENAI_FAMILY.has(provider)) return openaiTurn({ cfg, system, convo, tools, maxTokens });
  if (provider === "anthropic")    return anthropicTurn({ cfg, system, convo, tools, maxTokens });
  if (provider === "gemini")       return geminiTurn({ cfg, system, convo, tools, maxTokens });
  throw new Error(
    `agent.tools: provider "${provider}" does not (yet) support tool use. ` +
    `Switch to openai, anthropic, azure-openai, ollama, or gemini, or use the plain agent plugin.`,
  );
}

// ────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions tools API (openai / azure-openai / ollama)
// ────────────────────────────────────────────────────────────────────

async function openaiTurn({ cfg, system, convo, tools, maxTokens }) {
  const baseUrl = cfg.provider === "azure-openai"
    ? `${cfg.baseUrl.replace(/\/$/, "")}/openai/deployments/${cfg.azureDeployment}`
    : (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = cfg.provider === "azure-openai"
    ? `${baseUrl}/chat/completions?api-version=${cfg.azureApiVersion || "2024-08-01-preview"}`
    : `${baseUrl}/chat/completions`;
  const headers = cfg.provider === "azure-openai"
    ? { "content-type": "application/json", "api-key": cfg.apiKey }
    : { "content-type": "application/json", "authorization": `Bearer ${cfg.apiKey}` };

  const messages = [{ role: "system", content: system }, ...openaiMessagesFromConvo(convo)];
  const body = {
    model:       cfg.model,
    max_tokens:  maxTokens,
    temperature: 0.3,
    messages,
    tools: tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.schema || { type: "object" } },
    })),
    tool_choice: "auto",
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent.tools (${cfg.provider}): ${res.status} ${sliceLast(txt, 500)}`);
  }
  const data = await res.json();
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  const toolCalls = (msg.tool_calls || []).map(tc => ({
    id:   tc.id,
    name: tc.function?.name || "",
    args: safeJsonParse(tc.function?.arguments) || {},
  }));
  return {
    text:       String(msg.content || ""),
    toolCalls,
    usage: {
      inputTokens:  data?.usage?.prompt_tokens     ?? 0,
      outputTokens: data?.usage?.completion_tokens ?? 0,
    },
    stopReason: choice?.finish_reason || "stop",
  };
}

function openaiMessagesFromConvo(convo) {
  const out = [];
  for (const m of convo) {
    if (m.role === "user")      out.push({ role: "user", content: String(m.text ?? "") });
    else if (m.role === "assistant") {
      const entry = { role: "assistant", content: m.text || null };
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
        entry.tool_calls = m.toolCalls.map(tc => ({
          id:       tc.id,
          type:     "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      out.push(entry);
    } else if (m.role === "tool") {
      // Emit one OpenAI "tool" message per result.
      for (const r of m.results) {
        out.push({
          role:           "tool",
          tool_call_id:   r.id,
          content:        r.error
            ? JSON.stringify({ error: r.error })
            : (typeof r.output === "string" ? r.output : JSON.stringify(r.output ?? null)),
        });
      }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Anthropic Messages tools API
// ────────────────────────────────────────────────────────────────────

async function anthropicTurn({ cfg, system, convo, tools, maxTokens }) {
  const baseUrl = (cfg.baseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const body = {
    model:      cfg.model,
    max_tokens: maxTokens,
    system,
    messages:   anthropicMessagesFromConvo(convo),
    tools:      tools.map(t => ({
      name:         t.name,
      description:  t.description,
      input_schema: t.schema || { type: "object" },
    })),
  };
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type":      "application/json",
      "x-api-key":         cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent.tools (anthropic): ${res.status} ${sliceLast(txt, 500)}`);
  }
  const data = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter(b => b.type === "text").map(b => b.text).join("");
  const toolCalls = blocks
    .filter(b => b.type === "tool_use")
    .map(b => ({ id: b.id, name: b.name, args: b.input || {} }));
  return {
    text,
    toolCalls,
    usage: {
      inputTokens:  data?.usage?.input_tokens  ?? 0,
      outputTokens: data?.usage?.output_tokens ?? 0,
    },
    stopReason: data?.stop_reason || "stop",     // "end_turn" | "tool_use" | "max_tokens"
  };
}

function anthropicMessagesFromConvo(convo) {
  const out = [];
  for (const m of convo) {
    if (m.role === "user") {
      out.push({ role: "user", content: String(m.text ?? "") });
    } else if (m.role === "assistant") {
      // Anthropic re-sends the assistant turn as content-blocks so the
      // model knows what tool_use ids it referenced last round.
      const blocks = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const tc of (m.toolCalls || [])) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args || {} });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : "" });
    } else if (m.role === "tool") {
      // All tool results in one user message — Anthropic's convention.
      const content = m.results.map(r => ({
        type:         "tool_result",
        tool_use_id:  r.id,
        is_error:     !!r.error,
        content:      r.error
          ? String(r.error)
          : (typeof r.output === "string" ? r.output : JSON.stringify(r.output ?? null)),
      }));
      out.push({ role: "user", content });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Gemini (generativelanguage.googleapis.com) function calling
// ────────────────────────────────────────────────────────────────────

async function geminiTurn({ cfg, system, convo, tools, maxTokens }) {
  const baseUrl = (cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const url = `${baseUrl}/models/${cfg.model}:generateContent?key=${cfg.apiKey}`;
  const body = {
    systemInstruction: { role: "user", parts: [{ text: system }] },
    contents:          geminiContentsFromConvo(convo),
    tools: [{
      functionDeclarations: tools.map(t => ({
        name:        t.name,
        description: t.description,
        parameters:  geminiCleanSchema(t.schema || { type: "object" }),
      })),
    }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`agent.tools (gemini): ${res.status} ${sliceLast(txt, 500)}`);
  }
  const data = await res.json();
  const cand  = data?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts.filter(p => p.text).map(p => p.text).join("");
  // Gemini doesn't issue per-call ids; we synthesize stable ones from
  // the order so the plugin's tool-result mapping has something to
  // key on.
  const toolCalls = parts
    .filter(p => p.functionCall)
    .map((p, i) => ({ id: `gemini-tc-${i}`, name: p.functionCall.name, args: p.functionCall.args || {} }));
  return {
    text,
    toolCalls,
    usage: {
      // Gemini exposes usageMetadata at the top level (newer API).
      inputTokens:  data?.usageMetadata?.promptTokenCount     ?? 0,
      outputTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
    },
    stopReason: cand?.finishReason || "STOP",
  };
}

function geminiContentsFromConvo(convo) {
  const out = [];
  for (const m of convo) {
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: String(m.text ?? "") }] });
    } else if (m.role === "assistant") {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of (m.toolCalls || [])) {
        parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
      }
      out.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const parts = m.results.map(r => ({
        functionResponse: {
          name:     r.name,
          response: r.error ? { error: r.error } : { result: r.output },
        },
      }));
      out.push({ role: "user", parts });
    }
  }
  return out;
}

// Gemini rejects some JSON Schema keywords (additionalProperties,
// $schema, anyOf when paired with primitives). Strip the ones we know
// it doesn't accept — best effort, schemas with unusual keywords may
// still trip it.
function geminiCleanSchema(s) {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(geminiCleanSchema);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    out[k] = geminiCleanSchema(v);
  }
  return out;
}

function safeJsonParse(s) {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s); } catch { return null; }
}
