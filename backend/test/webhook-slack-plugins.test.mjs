// Slack-side tests run under node --test (no fetch shim needed at
// import time). The webhook tests live in test/webhook-direct.test.mjs
// instead, because they need to replace globalThis.fetch BEFORE the
// plugin module loads — which means running outside the node:test
// per-file harness.

import { test } from "node:test";
import assert from "node:assert/strict";

let fetchCalls = [];
let fetchResp  = { ok: true, status: 200, body: { ok: true } };
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url, init });
  return {
    ok: fetchResp.ok, status: fetchResp.status,
    headers: { forEach() {} },
    text: async () => JSON.stringify(fetchResp.body),
    json: async () => fetchResp.body,
  };
};

const slack = (await import("../src/plugins/builtin/slack.post.js")).default;
const ctx = (cfgs) => ({ config: cfgs, execution: { workspaceId: "ws1", projectId: null }, node: { name: "n" } });

test("slack.post — ok:true response surfaces ts + channel", async () => {
  fetchCalls = []; fetchResp = { ok: true, status: 200, body: { ok: true, ts: "1739000000.000200", channel: "C123" } };
  const r = await slack.execute({ config: "sl", channel: "#general", text: "hi" },
                                ctx({ sl: { botToken: "xoxb-1", defaultChannel: "#alerts" } }));
  assert.equal(r.ok, true);
  assert.equal(r.ts, "1739000000.000200");
  assert.equal(r.channel, "C123");
  assert.equal(fetchCalls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(fetchCalls[0].init.headers["authorization"], "Bearer xoxb-1");
});

test("slack.post — defaultChannel fallback + ok:false branchable", async () => {
  fetchResp = { ok: true, status: 200, body: { ok: false, error: "channel_not_found" } };
  const r = await slack.execute({ config: "sl", text: "x" },
                                ctx({ sl: { botToken: "xoxb-1", defaultChannel: "#x" } }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "channel_not_found");
});

test("slack.post — refuses when no channel nor defaultChannel is set", async () => {
  await assert.rejects(
    () => slack.execute({ config: "sl", text: "x" }, ctx({ sl: { botToken: "xoxb-1" } })),
    /no channel supplied/,
  );
});
