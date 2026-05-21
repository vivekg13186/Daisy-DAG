// ocr.extract — extract text from an image (or a single-page PDF
// rendered as an image) using the bound agent's vision LLM.
//
// v1 uses the LLM-as-OCR pattern: the bound agent's provider must
// support vision input — i.e. openai (gpt-4o family), anthropic
// (claude with vision), gemini, azure-openai, or bedrock vision
// models. The plugin pushes the image through the existing
// callProvider path with a system prompt that says "extract verbatim
// text". Cloud-only by design — no Tesseract binary on the worker.
//
// For dense documents (multi-page PDFs, scanned forms with tables),
// route through a marketplace plugin pointed at Azure Document
// Intelligence or AWS Textract — the LLM path handles light OCR
// well but isn't the right tool for complex layouts.
//
// Inputs:
//   agent:   stored agent (provider creds + telemetry + guardrails)
//   content: base64-encoded image bytes (png/jpg/webp/gif/pdf-page)
//   mimeType: image/png | image/jpeg | image/webp | image/gif
//   instruction: optional plain-English hint ("only extract the
//                table on the right side")
//
// Output:
//   { text: <verbatim text>, usage, raw }

import { Buffer } from "node:buffer";
import { loadAgent, callProvider } from "../agent/util.js";
import { runOneShot } from "../agent/structured.js";
import { getClient } from "../object-store/util.js";

const VISION_PROVIDERS = new Set(["openai", "anthropic", "azure-openai", "gemini", "bedrock"]);

export default {
  name: "ocr.extract",
  category: "ai",
  description:
    "Extract text from an image using the bound agent's vision LLM. " +
    "Two input modes: (1) inline — pass `content` as base64; (2) " +
    "streaming source — pass `source: {config, key, bucket?}` to " +
    "fetch directly from object.store, no base64 hop through ctx. " +
    "Best for short documents / receipts / screenshots; for dense " +
    "multi-page PDFs use a marketplace OCR plugin pointed at Azure " +
    "Document Intelligence or AWS Textract.",
  inputSchema: {
    type: "object",
    required: ["agent"],
    properties: {
      agent: {
        type: "string", minLength: 1, title: "Agent",
        description:
          "Title of a stored agent (Home → Agents). Provider must " +
          "support vision: openai, anthropic, azure-openai, gemini, bedrock.",
      },
      content: {
        type: "string", title: "Image bytes (base64)",
        description:
          "Base64-encoded image. Mutually exclusive with `source`.",
      },
      source: {
        type: "object",
        title: "Streaming source (object.store)",
        description:
          "Fetch the image bytes directly from an object.store config " +
          "— bypasses the base64 hop through ctx. Mutually exclusive " +
          "with `content`.",
        properties: {
          config: { type: "string", minLength: 1 },
          key:    { type: "string", minLength: 1 },
          bucket: { type: "string" },
        },
        required: ["config", "key"],
      },
      mimeType: {
        type: "string",
        enum: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        default: "image/png",
        title: "MIME type",
      },
      instruction: {
        type: "string", format: "textarea",
        title: "Extra instruction",
        description:
          "Optional plain-English hint. Examples: \"only the table\", " +
          "\"preserve newlines\", \"return raw OCR with no commentary\".",
      },
      maxTokens: {
        type: "integer", minimum: 1, maximum: 16000, default: 4000,
        title: "Max output tokens",
        description: "Upper bound on the response length.",
      },
    },
  },
  primaryOutput: "text",
  outputSchema: {
    type: "object",
    required: ["text"],
    properties: {
      text:  { type: "string" },
      raw:   { type: "string" },
      usage: { type: "object" },
    },
  },
  async execute(input, ctx, hooks) {
    const { agent, cfg } = await loadAgent(ctx, input.agent);
    if (!VISION_PROVIDERS.has(cfg.provider)) {
      throw new Error(
        `ocr.extract: provider "${cfg.provider}" doesn't expose vision input. ` +
        `Use an openai / anthropic / azure-openai / gemini / bedrock config.`,
      );
    }

    // Validate mutex: exactly one of content / source.
    const hasContent = input.content != null && input.content !== "";
    const hasSource  = input.source && typeof input.source === "object";
    if (hasContent && hasSource) {
      throw new Error("ocr.extract: pass either `content` (base64) or `source` (object.store ref), not both");
    }
    if (!hasContent && !hasSource) {
      throw new Error("ocr.extract: provide `content` (base64) or `source: {config, key, bucket?}`");
    }

    // Resolve the bytes + mimeType. Source mode reads through the
    // object.store client → bytes → base64 inside the plugin. ctx
    // never holds the encoded payload.
    let base64;
    let mimeType = input.mimeType || "image/png";
    if (hasSource) {
      const { client, bucket } = await getClient(ctx, input.source.config, input.source.bucket);
      const obj = await client.get(bucket, input.source.key);
      base64 = Buffer.from(obj.body).toString("base64");
      if (obj.contentType) mimeType = obj.contentType;
    } else {
      base64 = String(input.content);
    }

    // We don't go through runOneShot because callProvider's images
    // path takes the base64 + mimeType. The structured helper would
    // require restructuring its signature — simpler to inline the
    // guardrails + telemetry here, matching the agent plugin pattern.
    const systemPrompt = buildOcrSystem(input.instruction);

    const t0 = Date.now();
    // Pass a single content-string carrying the base64 — callProvider's
    // normaliseImage will detect it as raw bytes and stamp the right
    // media type. For provider-specific shapes we also set kind=base64
    // via a data URL so the existing imageInput normaliser does the
    // right thing across providers.
    const dataUrl = `data:${mimeType};base64,${base64}`;
    const { text, usage } = await callProvider({
      cfg,
      system:    systemPrompt,
      messages:  [{ role: "user", content: "Extract the text from this image. Return text only." }],
      images:    [dataUrl],
      maxTokens: input.maxTokens || 4000,
    });
    const latencyMs = Date.now() - t0;

    // Telemetry — OCR via LLM uses real tokens, log them.
    const workspaceId = ctx?.execution?.workspaceId;
    const projectId   = ctx?.execution?.projectId;
    if (projectId) {
      try {
        const { recordAgentTokenEvent } = await import("../agent/usage.js");
        recordAgentTokenEvent({
          workspaceId, projectId,
          executionId:  ctx?.execution?.id || null,
          agentId:      agent.id,
          agentTitle:   agent.title,
          provider:     cfg.provider,
          model:        cfg.model,
          inputTokens:  usage?.inputTokens  || 0,
          outputTokens: usage?.outputTokens || 0,
          cacheHit:     false,
          latencyMs,
          kind:         "ocr",
        }).catch(() => {});
      } catch { /* telemetry-grade */ }
    }

    if (hooks?.stream?.log) {
      hooks.stream.log("info",
        `ocr "${agent.title}" → ${cfg.provider}/${cfg.model} (${usage?.outputTokens || 0} out tokens)`);
    }
    return { text: text.trim(), raw: text, usage };
  },
};

function buildOcrSystem(instruction) {
  const lines = [
    "You are an OCR engine.",
    "Read the user's image and emit the text it contains verbatim.",
    "Preserve line breaks and basic table layout. Do NOT add commentary,",
    "headers, or markdown — output the raw text only. If the image",
    "contains no readable text, output an empty string.",
  ];
  if (instruction) {
    lines.push("", "Additional instruction:", instruction);
  }
  return lines.join("\n");
}
