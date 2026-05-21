import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

// ── Mocks ──────────────────────────────────────────────────────────
let stubAgent  = { id: "ag1", title: "A", prompt: "", config_name: "cfg",
                   guardrails_override: null, template_body: null };
let stubCfg    = { provider: "openai", model: "whisper-1", apiKey: "sk-x" };

let transcribeResponse = { text: "hello world", usage: { inputTokens: 0, outputTokens: 0 } };
let synthesizeResponse    = { content: "AAA=", mimeType: "audio/mpeg", usage: {} };
let synthesizeRawResponse = null;          // set per-test for the streaming path
let callProviderResponse  = { text: "OCR'd text\nLine 2", usage: { inputTokens: 100, outputTokens: 20 } };

// Track every call into the audio module + the object-store client so
// tests can assert on what was actually executed.
let transcribeCalls = [];
let putStreamCalls  = [];
let getCalls        = [];

mock.module("../src/plugins/agent/util.js", {
  namedExports: {
    loadAgent: async () => ({ agent: stubAgent, cfg: { ...stubCfg } }),
    callProvider: async (args) => { callProviderResponse._args = args; return callProviderResponse; },
  },
});
mock.module("../src/plugins/agent/audio.js", {
  namedExports: {
    transcribe: async (args) => { transcribeCalls.push(args); return transcribeResponse; },
    synthesize: async () => synthesizeResponse,
    synthesizeRaw: async () => synthesizeRawResponse,
  },
});
// Stub the object-store helper so source/target tests don't need a
// live S3/GCS/Azure. Each getClient call returns a mock with .get
// returning fake bytes, .putStream tracking what was piped in.
mock.module("../src/plugins/object-store/util.js", {
  namedExports: {
    getClient: async (_ctx, configName, bucketOverride) => ({
      client: {
        async get(bucket, key) {
          getCalls.push({ bucket, key });
          return {
            body: Buffer.from("FAKEBYTES"),
            contentType: "audio/wav",
            size: 9,
            etag: "abc",
            lastModified: null,
          };
        },
        async putStream(bucket, key, stream, contentType, contentLength) {
          // Drain the stream so the "did it pipe?" assertion is real.
          const chunks = [];
          for await (const c of toAsyncIterable(stream)) chunks.push(c);
          const total = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c)));
          putStreamCalls.push({ bucket, key, contentType, contentLength, drainedBytes: total.length });
          return { etag: "abc", size: contentLength ?? total.length };
        },
      },
      provider: "s3",
      bucket: bucketOverride || "bucket-from-config",
    }),
  },
});

function toAsyncIterable(s) {
  if (Symbol.asyncIterator in s) return s;
  return Readable.fromWeb(s);
}

const stt = (await import("../src/plugins/builtin/transcribe.audio.js")).default;
const tts = (await import("../src/plugins/builtin/tts.synthesize.js")).default;
const ocr = (await import("../src/plugins/builtin/ocr.extract.js")).default;

const ctx = { execution: { workspaceId: "ws1", projectId: null, id: "ex1" }, node: { name: "n" } };
const hooks = { stream: { log: () => {} } };

// ── transcribe.audio (inline / base64 mode) ───────────────────────

test("transcribe.audio (inline) — base64 decode + happy path", async () => {
  transcribeCalls = [];
  const audioB64 = Buffer.from("fakebytes").toString("base64");
  const r = await stt.execute({ agent: "A", content: audioB64, mimeType: "audio/wav" }, ctx);
  assert.equal(r.text, "hello world");
  assert.equal(transcribeCalls.length, 1);
  assert.equal(transcribeCalls[0].mimeType, "audio/wav");
});

test("transcribe.audio (inline) — rejects 0-byte payload", async () => {
  await assert.rejects(
    () => stt.execute({ agent: "A", content: "" }, ctx),
    /provide.*content.*or.*source/,    // refuses BOTH-missing case now
  );
});

test("transcribe.audio — content + source is rejected", async () => {
  await assert.rejects(
    () => stt.execute({ agent: "A", content: "AAA=", source: { config: "s3", key: "x" } }, ctx),
    /either `content`.*or `source`.*not both/,
  );
});

test("transcribe.audio (source) — reads from object.store, ctx never sees bytes", async () => {
  transcribeCalls = []; getCalls = [];
  const r = await stt.execute({ agent: "A", source: { config: "s3", key: "voicemail/42.mp3" } }, ctx);
  assert.equal(r.text, "hello world");
  assert.equal(getCalls.length, 1);
  assert.equal(getCalls[0].key, "voicemail/42.mp3");
  // The stored Content-Type from the object overrides the input default.
  assert.equal(transcribeCalls[0].mimeType, "audio/wav");
});

test("transcribe.audio (inline) — refuses payload over 25 MB", async () => {
  const big = "A".repeat(36 * 1024 * 1024);
  await assert.rejects(
    () => stt.execute({ agent: "A", content: big }, ctx),
    /exceeds the 25 MB limit/,
  );
});

// ── tts.synthesize (inline / base64 mode) ─────────────────────────

test("tts.synthesize (inline) — returns base64 + mime", async () => {
  const r = await tts.execute({ agent: "A", text: "hi" }, ctx);
  assert.equal(r.content, "AAA=");
  assert.equal(r.mimeType, "audio/mpeg");
});

test("tts.synthesize — refuses text over 4096 chars", async () => {
  await assert.rejects(
    () => tts.execute({ agent: "A", text: "x".repeat(4097) }, ctx),
    /accepts at most 4096/,
  );
});

test("tts.synthesize — rejects empty text", async () => {
  await assert.rejects(
    () => tts.execute({ agent: "A", text: "" }, ctx),
    /`text` is required/,
  );
});

// ── tts.synthesize (streaming target mode) ────────────────────────

test("tts.synthesize (target) — streams response straight into object.store", async () => {
  putStreamCalls = [];
  // Build a fake Web ReadableStream containing fake audio bytes.
  const fakeBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("audio-bytes-here"));
      controller.close();
    },
  });
  synthesizeRawResponse = {
    res:           { body: fakeBody },
    mimeType:      "audio/mpeg",
    contentLength: 16,
    usage:         { inputTokens: 0, outputTokens: 0 },
  };
  const r = await tts.execute({
    agent: "A", text: "hi",
    target: { config: "s3", key: "out/voice.mp3" },
  }, ctx);
  assert.equal(r.key, "out/voice.mp3");
  assert.equal(r.bucket, "bucket-from-config");
  assert.equal(r.size, 16);
  assert.equal(r.mimeType, "audio/mpeg");
  // No base64 in the output — streaming path.
  assert.equal(r.content, undefined);
  // The stream was actually drained into putStream.
  assert.equal(putStreamCalls.length, 1);
  assert.equal(putStreamCalls[0].drainedBytes, 16);
  assert.equal(putStreamCalls[0].contentType, "audio/mpeg");
});

// ── ocr.extract (inline mode) ─────────────────────────────────────

test("ocr.extract (inline) — delegates to callProvider with image", async () => {
  const r = await ocr.execute({ agent: "A", content: "imgdata" }, ctx, hooks);
  assert.equal(r.text, "OCR'd text\nLine 2");
});

test("ocr.extract — refuses on a non-vision provider", async () => {
  const oldProvider = stubCfg.provider;
  stubCfg = { ...stubCfg, provider: "ollama" };
  try {
    await assert.rejects(
      () => ocr.execute({ agent: "A", content: "x" }, ctx, hooks),
      /doesn't expose vision input/,
    );
  } finally {
    stubCfg = { ...stubCfg, provider: oldProvider };
  }
});

test("ocr.extract — both inputs missing", async () => {
  await assert.rejects(
    () => ocr.execute({ agent: "A" }, ctx, hooks),
    /provide.*content.*or.*source/,
  );
});

test("ocr.extract — content + source rejected", async () => {
  await assert.rejects(
    () => ocr.execute({ agent: "A", content: "x", source: { config: "s3", key: "y" } }, ctx, hooks),
    /either `content`.*or `source`.*not both/,
  );
});

// ── ocr.extract (source mode) ─────────────────────────────────────

test("ocr.extract (source) — reads from object.store, base64 stays inside plugin", async () => {
  getCalls = [];
  const r = await ocr.execute({ agent: "A", source: { config: "s3", key: "scan/1.jpg" } }, ctx, hooks);
  assert.equal(r.text, "OCR'd text\nLine 2");
  assert.equal(getCalls.length, 1);
  // The callProvider call should have received a data URL using the
  // object's stored Content-Type (audio/wav from the mock — fake here,
  // but the plumbing is what matters).
  assert.ok(callProviderResponse._args, "callProvider should have been called");
  const imgs = callProviderResponse._args.images || [];
  assert.equal(imgs.length, 1);
  assert.ok(imgs[0].startsWith("data:audio/wav;base64,"));
});
