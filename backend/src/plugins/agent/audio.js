// Audio API adapters for the transcribe.audio + tts.synthesize plugins.
//
// Lives outside src/plugins/builtin/ so the plugin auto-loader doesn't
// register it as an action.
//
// v1 provider support:
//   • openai        — /audio/transcriptions (whisper-1, gpt-4o-transcribe)
//                     and /audio/speech (tts-1, tts-1-hd)
//   • azure-openai  — same endpoint shape under the deployment URL
//
// Other ai.provider providers (anthropic, gemini, bedrock, ollama)
// don't have audio APIs in their main SDK paths today; the plugins
// throw a clear "audio not supported on provider X" so the user can
// switch providers without guessing what's wrong.

import { Buffer } from "node:buffer";
import { sliceLast } from "./util.js";

const OPENAI_AUDIO_PROVIDERS = new Set(["openai", "azure-openai"]);

/**
 * Run a single audio file through the speech-to-text endpoint.
 *
 *   await transcribe({ cfg, audio: Buffer, mimeType: "audio/mpeg",
 *                       language?: "en", prompt?: string, model? })
 *
 * Returns { text, usage: { inputTokens: 0, outputTokens: 0 } }.
 * Whisper doesn't expose tokens; we surface zeros so the cost
 * rollup helpers don't choke on `null`.
 */
export async function transcribe({ cfg, audio, mimeType, language, prompt, model }) {
  if (!OPENAI_AUDIO_PROVIDERS.has(cfg.provider)) {
    throw new Error(
      `transcribe.audio: provider "${cfg.provider}" doesn't expose an STT API. ` +
      `Use an openai (or azure-openai) ai.provider config.`,
    );
  }
  const url = stsEndpoint(cfg, "transcriptions");
  const headers = audioHeaders(cfg);
  // The OpenAI API expects multipart/form-data with the file under
  // `file`, plus a `model` field. We build the body by hand to
  // avoid pulling in form-data — the contract is small.
  const form = new FormData();
  // Best to give the API a filename matching the mime; whisper sniffs
  // the extension to pick a decoder.
  const filename = filenameForMime(mimeType);
  form.append("file",  new Blob([audio], { type: mimeType || "audio/mpeg" }), filename);
  form.append("model", model || cfg.model || "whisper-1");
  if (language) form.append("language", language);
  if (prompt)   form.append("prompt",   prompt);
  // We don't request verbose_json — text-only is enough for the
  // workflow plugin contract. Customers who need timestamps can use
  // a marketplace plugin pointed at the same OpenAI endpoint.
  form.append("response_format", "text");

  const res = await fetch(url, { method: "POST", headers, body: form });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`transcribe.audio (${cfg.provider}): ${res.status} ${sliceLast(txt, 500)}`);
  }
  // response_format=text returns raw text, not JSON.
  const text = (await res.text()).trim();
  return { text, usage: { inputTokens: 0, outputTokens: 0 } };
}

/**
 * Synthesize speech from text and buffer the full response.
 *
 *   await synthesize({ cfg, text, voice, model, format })
 *
 * Returns { content: <base64 string>, mimeType, usage: { ... } }.
 *
 * Use synthesizeRaw() instead when piping the response straight into
 * an object-store target — that path avoids materializing the audio
 * in memory.
 */
export async function synthesize({ cfg, text, voice = "alloy", model, format = "mp3" }) {
  const { res, mimeType } = await openTtsResponse({ cfg, text, voice, model, format });
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    content:  bytes.toString("base64"),
    mimeType,
    usage:    { inputTokens: 0, outputTokens: 0 },
  };
}

/**
 * Open a TTS response without buffering it. Returns the raw fetch
 * Response so the caller can pipe `res.body` straight into a sink
 * (e.g. object.store putStream).
 *
 *   const { res, mimeType, contentLength } = await synthesizeRaw({...})
 *   await client.putStream(bucket, key, res.body, mimeType, contentLength)
 */
export async function synthesizeRaw({ cfg, text, voice = "alloy", model, format = "mp3" }) {
  const { res, mimeType } = await openTtsResponse({ cfg, text, voice, model, format });
  const contentLength = parseInt(res.headers.get("content-length") || "", 10);
  return {
    res,
    mimeType,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
    usage:         { inputTokens: 0, outputTokens: 0 },
  };
}

async function openTtsResponse({ cfg, text, voice, model, format }) {
  if (!OPENAI_AUDIO_PROVIDERS.has(cfg.provider)) {
    throw new Error(
      `tts.synthesize: provider "${cfg.provider}" doesn't expose a TTS API. ` +
      `Use an openai (or azure-openai) ai.provider config.`,
    );
  }
  const url = stsEndpoint(cfg, "speech");
  const headers = { ...audioHeaders(cfg), "content-type": "application/json" };
  const body = {
    model:           model || cfg.model || "tts-1",
    input:           String(text || ""),
    voice,
    response_format: format,
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`tts.synthesize (${cfg.provider}): ${res.status} ${sliceLast(txt, 500)}`);
  }
  return { res, mimeType: mimeForFormat(format) };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function stsEndpoint(cfg, kind) {
  if (cfg.provider === "azure-openai") {
    const base = (cfg.baseUrl || "").replace(/\/$/, "");
    const version = cfg.azureApiVersion || "2024-08-01-preview";
    // Azure routes audio under the same deployment alias as chat.
    return `${base}/openai/deployments/${cfg.azureDeployment}/audio/${kind}?api-version=${version}`;
  }
  const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  return `${base}/audio/${kind}`;
}

function audioHeaders(cfg) {
  if (cfg.provider === "azure-openai") {
    // Azure uses api-key instead of Authorization.
    return { "api-key": cfg.apiKey };
  }
  return { "authorization": `Bearer ${cfg.apiKey}` };
}

function filenameForMime(mime) {
  const ext = {
    "audio/mpeg":  "mp3",
    "audio/mp3":   "mp3",
    "audio/wav":   "wav",
    "audio/x-wav": "wav",
    "audio/webm":  "webm",
    "audio/ogg":   "ogg",
    "audio/m4a":   "m4a",
    "audio/mp4":   "m4a",
    "audio/flac":  "flac",
  }[mime] || "mp3";
  return `audio.${ext}`;
}

function mimeForFormat(fmt) {
  return {
    mp3:  "audio/mpeg",
    opus: "audio/ogg",
    aac:  "audio/aac",
    flac: "audio/flac",
    wav:  "audio/wav",
    pcm:  "audio/pcm",
  }[fmt] || "audio/mpeg";
}
