import { test, mock } from "node:test";
import assert from "node:assert/strict";

let canned = () => "";
function setCanned(s) { canned = typeof s === "function" ? s : () => s; }

mock.module("../src/plugins/agent/util.js", {
  namedExports: {
    loadAgent: async (_ctx, title) => ({
      agent: { id: "ag1", title, prompt: "ignored", config_name: "cfg",
               guardrails_override: null, template_body: null },
      cfg:   { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-x" },
    }),
    callProvider: async () => { throw new Error("should not be called"); },
    tryParseJson(text) {
      if (typeof text !== "string") return null;
      const t = text.trim();
      const fenced = /^```(?:json)?\s*\n([\s\S]*?)```/i.exec(t);
      const cand = fenced ? fenced[1] : t;
      const c = cand.trim().charAt(0);
      if (c !== "{" && c !== "[") return null;
      try { return JSON.parse(cand); } catch { return null; }
    },
    extractConfidence() { return null; },
  },
});

mock.module("../src/plugins/agent/structured.js", {
  namedExports: {
    runOneShot: async () => ({ text: canned(), usage: { inputTokens: 10, outputTokens: 20 }, latencyMs: 1 }),
  },
});

const ext = (await import("../src/plugins/builtin/agent.extract.js")).default;
const cls = (await import("../src/plugins/builtin/agent.classify.js")).default;

const ctx   = { execution: { workspaceId: "ws1", projectId: "p1", id: "ex1" }, node: { name: "n" } };
const hooks = { stream: { log: () => {} } };

test("agent.extract — happy path validates first try", async () => {
  setCanned(`{"name":"alice","age":30}`);
  const schema = { type: "object", required: ["name","age"],
                   properties: { name: { type: "string" }, age: { type: "integer" } } };
  const r = await ext.execute({ agent: "X", schema, text: "alice 30" }, ctx, hooks);
  assert.equal(r.valid, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.data.name, "alice");
  assert.equal(r.data.age, 30);
});

test("agent.extract — retries on schema failure", async () => {
  let calls = 0;
  setCanned(() => { calls++; return calls === 1 ? `{"name":"alice"}` : `{"name":"alice","age":30}`; });
  const schema = { type: "object", required: ["name","age"],
                   properties: { name: { type: "string" }, age: { type: "integer" } } };
  const r = await ext.execute({ agent: "X", schema, text: "x", maxRetries: 2 }, ctx, hooks);
  assert.equal(r.valid, true);
  assert.equal(r.attempts, 2);
});

test("agent.extract — gives up after maxRetries", async () => {
  setCanned(() => `{"name":"alice"}`);
  const schema = { type: "object", required: ["name","age"],
                   properties: { name: { type: "string" }, age: { type: "integer" } } };
  const r = await ext.execute({ agent: "X", schema, text: "x", maxRetries: 1 }, ctx, hooks);
  assert.equal(r.valid, false);
  assert.equal(r.attempts, 2);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
});

test("agent.classify — single-label picks the max-scoring label", async () => {
  setCanned(`{"scores":{"billing":0.05,"tech":0.85,"feedback":0.10}}`);
  const r = await cls.execute({ agent: "X", labels: ["billing","tech","feedback"], text: "wifi broken" }, ctx, hooks);
  assert.equal(r.label, "tech");
  assert.ok(Math.abs(r.confidence - 0.85) < 1e-9);
  assert.deepEqual(r.scores, { billing: 0.05, tech: 0.85, feedback: 0.10 });
});

test("agent.classify — multi-label respects threshold", async () => {
  setCanned(`{"scores":{"bug":0.91,"performance":0.55,"ui":0.10,"docs":0.02}}`);
  const r = await cls.execute({ agent: "X", labels: ["bug","performance","ui","docs"],
                                 text: "slow ui", multiLabel: true, threshold: 0.5 }, ctx, hooks);
  assert.deepEqual(r.labels, ["bug","performance"]);
});

test("agent.classify — missing labels in model response default to 0", async () => {
  setCanned(`{"scores":{"a":0.7}}`);
  const r = await cls.execute({ agent: "X", labels: ["a","b","c"], text: "x" }, ctx, hooks);
  assert.equal(r.scores.a, 0.7);
  assert.equal(r.scores.b, 0);
  assert.equal(r.scores.c, 0);
  assert.equal(r.label, "a");
});

test("agent.classify — rejects labels with fewer than 2 distinct strings", async () => {
  await assert.rejects(
    () => cls.execute({ agent: "X", labels: ["only-one"], text: "x" }, ctx, hooks),
    /at least 2 distinct strings/,
  );
});
