// tts.synthesize — text-to-speech via the bound agent's provider.
//
// v1 supports openai + azure-openai (tts-1, tts-1-hd). Other
// providers throw a clear "TTS not supported" error.
//
// Returns the audio bytes as base64 — pipe straight into
// object.store.write with encoding=base64 to upload to S3/GCS/Azure.
// Typical wiring:
//   tts.synthesize { agent, text }
//   → object.store.write { content: ${audio.content}, encoding: "base64",
//                          contentType: ${audio.mimeType} }

import { loadAgent } from "../agent/util.js";
import { synthesize, synthesizeRaw } from "../agent/audio.js";
import { getClient } from "../object-store/util.js";

const MAX_INPUT_CHARS = 4096;   // OpenAI's TTS hard cap

export default {
  name: "tts.synthesize",
  category: "ai",
  description:
    "Convert text to speech via the bound agent's provider. Two output " +
    "modes: (1) inline — returns the audio as a base64 `content` string; " +
    "(2) streaming target — pipes the OpenAI response body straight into " +
    "S3/GCS/Azure via an object.store config, no buffering. Pass either " +
    "no target (inline) or `target: {config, key, bucket?}` (streaming). " +
    "v1 supports openai + azure-openai (tts-1, tts-1-hd).",
  inputSchema: {
    type: "object",
    required: ["agent", "text"],
    properties: {
      agent: {
        type: "string", minLength: 1, title: "Agent",
        description:
          "Title of a stored agent (Home → Agents). Used for provider " +
          "creds + telemetry.",
      },
      text: {
        type: "string", format: "textarea", title: "Text to speak",
        description: "Max ~4096 characters (OpenAI's cap).",
      },
      voice: {
        type: "string", title: "Voice",
        enum: ["alloy","echo","fable","onyx","nova","shimmer"],
        default: "alloy",
      },
      format: {
        type: "string", title: "Audio format",
        enum: ["mp3","opus","aac","flac","wav","pcm"],
        default: "mp3",
      },
      model: {
        type: "string", title: "Model override",
        description: "Override the config's model. Examples: tts-1, tts-1-hd.",
      },
      target: {
        type: "object",
        title: "Streaming target (object.store)",
        description:
          "When set, the audio response streams directly to S3/GCS/Azure " +
          "— no base64 round-trip through ctx. The plugin returns " +
          "{ key, bucket, size, mimeType } instead of content.",
        properties: {
          config: { type: "string", minLength: 1, description: "object.store config name." },
          key:    { type: "string", minLength: 1, description: "Destination object key." },
          bucket: { type: "string", description: "Bucket / container override (defaults to the config's bucket)." },
        },
        required: ["config", "key"],
      },
    },
  },
  primaryOutput: "content",
  outputSchema: {
    type: "object",
    properties: {
      // Inline mode
      content:  { type: "string", description: "Base64-encoded audio bytes (inline mode)." },
      // Streaming mode
      key:      { type: "string" },
      bucket:   { type: "string" },
      size:     { type: ["integer", "null"] },
      // Both modes
      mimeType: { type: "string" },
      usage:    { type: "object" },
    },
  },
  async execute(input, ctx) {
    const { agent, cfg } = await loadAgent(ctx, input.agent);
    const text = String(input.text || "");
    if (!text) throw new Error("tts.synthesize: `text` is required");
    if (text.length > MAX_INPUT_CHARS) {
      throw new Error(
        `tts.synthesize: text is ${text.length} chars; ` +
        `OpenAI's TTS endpoint accepts at most ${MAX_INPUT_CHARS}. ` +
        `Split upstream into smaller chunks.`,
      );
    }

    const t0 = Date.now();
    const args = {
      cfg,
      text,
      voice:  input.voice  || "alloy",
      format: input.format || "mp3",
      model:  input.model,
    };

    let out;
    if (input.target) {
      // Streaming path. Open the TTS response, pipe its body straight
      // into object.store.putStream — Content-Length comes from the
      // OpenAI response so S3 single-PUT is enough (no multipart).
      const { client, bucket: bucketName } = await getClient(ctx, input.target.config, input.target.bucket);
      const raw = await synthesizeRaw(args);
      const r   = await client.putStream(
        bucketName, input.target.key,
        raw.res.body, raw.mimeType, raw.contentLength,
      );
      out = {
        key:      input.target.key,
        bucket:   bucketName,
        size:     r.size,
        mimeType: raw.mimeType,
        usage:    raw.usage,
      };
    } else {
      // Inline path (back-compat). Buffer the response → base64 → ctx.
      const r = await synthesize(args);
      out = { content: r.content, mimeType: r.mimeType, usage: r.usage };
    }
    const latencyMs = Date.now() - t0;

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
          kind:         input.target ? "tts.stream" : "tts",
        }).catch(() => {});
      } catch { /* telemetry-grade */ }
    }

    return out;
  },
};
