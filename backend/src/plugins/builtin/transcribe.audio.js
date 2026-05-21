// transcribe.audio — speech-to-text via the bound agent's provider.
//
// v1 supports openai + azure-openai (whisper-1, gpt-4o-transcribe).
// Other providers throw a clear "STT not supported" error.
//
// Input contract is content-in (no filesystem) — same shape as
// excel.parse, csv.parse, object.store.read: a base64 string the
// upstream node produced.
//
// Typical wiring in cloud workflows:
//   object.store.read { encoding: "binary" }    ← grab the .mp3 from S3
//   → transcribe.audio { content: ${doc.content}, mimeType: "audio/mpeg" }
//   → downstream agent / agent.classify / sql.insert / ...

import { Buffer } from "node:buffer";
import { loadAgent } from "../agent/util.js";
import { transcribe } from "../agent/audio.js";
import { getClient } from "../object-store/util.js";

const MAX_BYTES = 25 * 1024 * 1024;   // OpenAI's whisper limit

export default {
  name: "transcribe.audio",
  category: "ai",
  description:
    "Transcribe audio (mp3/wav/webm/ogg/m4a/flac) to text via the bound " +
    "agent's provider. Two input modes: (1) inline — pass `content` as " +
    "base64; (2) streaming source — pass `source: {config, key, bucket?}` " +
    "to fetch directly from object.store, so the bytes never round-trip " +
    "through ctx. v1 supports openai + azure-openai (whisper-1, " +
    "gpt-4o-transcribe).",
  inputSchema: {
    type: "object",
    required: ["agent"],
    properties: {
      agent: {
        type: "string", minLength: 1, title: "Agent",
        description:
          "Title of a stored agent (Home → Agents). Used for provider " +
          "creds + telemetry. The agent's prompt / template is ignored.",
      },
      content: {
        type: "string", title: "Audio bytes (base64)",
        description:
          "Base64-encoded audio. Mutually exclusive with `source`. " +
          "Use for small clips or when the audio already lives in ctx.",
      },
      source: {
        type: "object",
        title: "Streaming source (object.store)",
        description:
          "Fetch the audio bytes directly from an object.store config " +
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
        title: "MIME type",
        default: "audio/mpeg",
        description:
          "Drives the file extension whisper sniffs to pick a decoder. " +
          "Common: audio/mpeg, audio/wav, audio/webm, audio/m4a. " +
          "When `source` is set and the object's stored Content-Type " +
          "is non-null, the stored value wins.",
      },
      language: {
        type: "string", title: "Language hint",
        description:
          "ISO-639-1 code (en, fr, es, …). Optional but improves " +
          "accuracy for non-English audio.",
      },
      prompt: {
        type: "string", format: "textarea", title: "Glossary prompt",
        description:
          "Optional text whisper uses to bias toward unusual " +
          "terminology (product names, jargon).",
      },
      model: {
        type: "string", title: "Model override",
        description:
          "Override the config's model. Examples: whisper-1, " +
          "gpt-4o-transcribe, gpt-4o-mini-transcribe.",
      },
    },
  },
  primaryOutput: "text",
  outputSchema: {
    type: "object",
    required: ["text"],
    properties: {
      text:  { type: "string" },
      usage: { type: "object" },
    },
  },
  async execute(input, ctx) {
    const { agent, cfg } = await loadAgent(ctx, input.agent);

    // Validate mutex: exactly one of content / source.
    const hasContent = input.content != null && input.content !== "";
    const hasSource  = input.source && typeof input.source === "object";
    if (hasContent && hasSource) {
      throw new Error("transcribe.audio: pass either `content` (base64) or `source` (object.store ref), not both");
    }
    if (!hasContent && !hasSource) {
      throw new Error("transcribe.audio: provide `content` (base64) or `source: {config, key, bucket?}`");
    }

    // Source mode → read straight from object.store. Ctx never holds
    // the bytes; the buffer lives only for the multipart upload.
    let audio;
    let mimeType = input.mimeType || "audio/mpeg";
    if (hasSource) {
      const { client, bucket } = await getClient(ctx, input.source.config, input.source.bucket);
      const obj = await client.get(bucket, input.source.key);
      audio = obj.body;
      // Storage-recorded Content-Type wins over the input hint when
      // present — keeps whisper's decoder sniff accurate.
      if (obj.contentType) mimeType = obj.contentType;
    } else {
      audio = Buffer.from(String(input.content || ""), "base64");
    }
    if (audio.length === 0) {
      throw new Error(
        hasSource
          ? `transcribe.audio: object "${input.source.key}" is 0 bytes`
          : "transcribe.audio: `content` decoded to 0 bytes — check the base64 input",
      );
    }
    if (audio.length > MAX_BYTES) {
      throw new Error(
        `transcribe.audio: ${audio.length} bytes exceeds the 25 MB limit ` +
        `(split the audio upstream or compress to a lower bitrate).`,
      );
    }

    const t0 = Date.now();
    const r = await transcribe({
      cfg,
      audio,
      mimeType,
      language: input.language,
      prompt:   input.prompt,
      model:    input.model,
    });
    const latencyMs = Date.now() - t0;

    // Telemetry — whisper doesn't report tokens, but we record the
    // call so it shows up in the spend timeline at zero token cost.
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
          model:        input.model || cfg.model,
          inputTokens:  0,
          outputTokens: 0,
          cacheHit:     false,
          latencyMs,
          kind:         "transcribe",
        }).catch(() => {});
      } catch { /* telemetry-grade */ }
    }

    return { text: r.text, usage: r.usage };
  },
};
