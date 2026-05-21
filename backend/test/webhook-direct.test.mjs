// Standalone test — replaces globalThis.fetch BEFORE the import so
// webhook.send picks up our stub. node:test was running this file
// in a way that re-bound fetch after our patch.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

let fetchCalls = [];
let fetchImpl  = async () => ({ ok: true, status: 200,
  headers: { forEach() {} }, text: async () => "{}", json: async () => ({}) });

globalThis.fetch = async (...args) => {
  fetchCalls.push({ url: args[0], init: args[1] });
  return await fetchImpl(...args);
};

const wh = (await import("../src/plugins/builtin/webhook.send.js")).default;

const ctx = (cfgs) => ({ config: cfgs, execution: { workspaceId: "ws1", projectId: null }, node: { name: "n" } });

// 1. Happy path
fetchCalls = [];
fetchImpl = async () => ({ ok: true, status: 200,
  headers: { forEach(fn) { fn("application/json", "content-type"); } },
  text: async () => JSON.stringify({ received: true }),
  json: async () => ({ received: true }) });
let r = await wh.execute({ config: "wh", body: { hello: "world" } },
                          ctx({ wh: { url: "https://example.com/hook" } }));
assert.equal(r.status, 200);
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].url, "https://example.com/hook");
assert.equal(fetchCalls[0].init.method, "POST");
assert.equal(fetchCalls[0].init.body, JSON.stringify({ hello: "world" }));
console.log("ok 1 — happy path");

// 2. HMAC signature
fetchCalls = [];
fetchImpl = async () => ({ ok: true, status: 200,
  headers: { forEach() {} }, text: async () => "{}", json: async () => ({}) });
const secret = "shh-very-secret";
await wh.execute({ config: "wh", body: { x: 1 } },
                 ctx({ wh: { url: "https://example.com/hook", secret } }));
const h = fetchCalls[0].init.headers;
assert.ok(h["x-daisy-timestamp"]);
assert.ok(h["x-daisy-signature"].startsWith("sha256="));
const expected = createHmac("sha256", secret)
                   .update(`${h["x-daisy-timestamp"]}.${JSON.stringify({ x: 1 })}`)
                   .digest("hex");
assert.equal(h["x-daisy-signature"], `sha256=${expected}`);
console.log("ok 2 — hmac signature");

// 3. authHeader + extraHeaders merge
fetchCalls = [];
await wh.execute({ config: "wh", body: {}, headers: { "X-Trace": "t1" } },
                 ctx({ wh: { url: "https://example.com/hook", authHeader: "Bearer abc",
                              extraHeaders: '{"X-Tenant":"acme"}' } }));
const h3 = fetchCalls[0].init.headers;
assert.equal(h3["authorization"], "Bearer abc");
assert.equal(h3["X-Tenant"], "acme");
assert.equal(h3["X-Trace"], "t1");
console.log("ok 3 — auth + extra headers merged");

// 4. Retry on 5xx
fetchCalls = [];
let n = 0;
fetchImpl = async () => {
  n++;
  const status = n < 3 ? 503 : 200;
  return { ok: status < 300, status,
    headers: { forEach() {} }, text: async () => "", json: async () => ({}) };
};
r = await wh.execute({ config: "wh", body: {}, retries: 3, timeoutMs: 5000 },
                     ctx({ wh: { url: "https://example.com/hook" } }));
assert.equal(r.status, 200);
assert.equal(r.attempts, 3);
assert.equal(fetchCalls.length, 3);
console.log("ok 4 — retry on 5xx then success");

// 5. Missing config errors cleanly
try {
  await wh.execute({ config: "nope", body: {} }, ctx({}));
  throw new Error("expected error");
} catch (e) {
  assert.match(e.message, /config "nope" not found/);
}
console.log("ok 5 — missing-config error");

console.log("--- ALL WEBHOOK TESTS OK ---");
