import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Mock the db/pool for metric.emit ──────────────────────────────
const insertedRows = [];
mock.module("../src/db/pool.js", {
  namedExports: {
    pool: {
      query: async (sql, params) => {
        if (/INSERT INTO workflow_metrics/i.test(sql)) {
          insertedRows.push(params);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      },
    },
  },
});

// ── Mock the audit/log helper for audit.record ────────────────────
const auditCalls = [];
mock.module("../src/audit/log.js", {
  namedExports: {
    auditLog: async (args) => { auditCalls.push(args); },
  },
});

const metric = (await import("../src/plugins/builtin/metric.emit.js")).default;
const audit  = (await import("../src/plugins/builtin/audit.record.js")).default;

const ctx = (overrides = {}) => ({
  execution: { workspaceId: "ws1", projectId: "p1", id: "ex1", ...overrides },
  node:      { name: "n1" },
  actor:     { userId: "u1", email: "vivek@example.com", role: "admin" },
});

// ── metric.emit ────────────────────────────────────────────────────

test("metric.emit — counter defaults value to 1", async () => {
  insertedRows.length = 0;
  const r = await metric.execute({ name: "checkout.completed" }, ctx());
  assert.equal(r.name, "checkout.completed");
  assert.equal(r.kind, "counter");
  assert.equal(r.value, 1);
  // Insert columns: id, ws, project, exec, node, name, kind, value, labels, ts
  const last = insertedRows[insertedRows.length - 1];
  assert.equal(last[1], "ws1");
  assert.equal(last[5], "checkout.completed");
  assert.equal(last[6], "counter");
  assert.equal(last[7], 1);
});

test("metric.emit — gauge needs explicit value", async () => {
  await assert.rejects(
    () => metric.execute({ name: "queue.depth", kind: "gauge" }, ctx()),
    /requires an explicit `value`/,
  );
});

test("metric.emit — histogram records the sample", async () => {
  insertedRows.length = 0;
  const r = await metric.execute({ name: "checkout.ms", kind: "histogram", value: 134.7 }, ctx());
  assert.equal(r.kind, "histogram");
  assert.equal(r.value, 134.7);
});

test("metric.emit — rejects non-finite values", async () => {
  await assert.rejects(
    () => metric.execute({ name: "x", kind: "gauge", value: NaN }, ctx()),
    /finite number/,
  );
});

test("metric.emit — coerces non-scalar label values to strings", async () => {
  insertedRows.length = 0;
  await metric.execute({
    name: "x",
    labels: { tier: "premium", region: "us-east-1", extra: { nested: 1 } },
  }, ctx());
  const labels = JSON.parse(insertedRows[0][8]);
  assert.equal(labels.tier, "premium");
  assert.equal(labels.region, "us-east-1");
  assert.equal(labels.extra, '{"nested":1}');
});

test("metric.emit — rejects >20 label keys", async () => {
  const labels = {};
  for (let i = 0; i < 25; i++) labels[`k${i}`] = i;
  await assert.rejects(
    () => metric.execute({ name: "x", labels }, ctx()),
    /labels object has 25 keys/,
  );
});

test("metric.emit — rejects empty workspaceId", async () => {
  await assert.rejects(
    () => metric.execute({ name: "x" }, { execution: {}, node: {} }),
    /missing workspaceId/,
  );
});

// ── audit.record ──────────────────────────────────────────────────

test("audit.record — writes with actor_kind=workflow + enriches metadata", async () => {
  auditCalls.length = 0;
  const r = await audit.execute({
    action:   "order.refunded",
    resource: { type: "order", id: "o42", name: "#42" },
    metadata: { reason: "fraud", amount: 9900 },
  }, ctx());
  assert.equal(r.recorded, true);
  assert.equal(r.action, "order.refunded");
  assert.equal(auditCalls.length, 1);
  const call = auditCalls[0];
  assert.equal(call.action, "order.refunded");
  assert.equal(call.actor.kind, "workflow");
  assert.equal(call.actor.id, "u1");                 // the trigger user comes through
  assert.equal(call.workspaceId, "ws1");
  assert.equal(call.projectId, "p1");
  assert.equal(call.resource.type, "order");
  assert.equal(call.metadata.reason, "fraud");
  assert.equal(call.metadata.__source, "workflow");
  assert.equal(call.metadata.__executionId, "ex1");
  assert.equal(call.metadata.__node, "n1");
});

test("audit.record — outcome defaults to 'success'", async () => {
  auditCalls.length = 0;
  await audit.execute({ action: "ping" }, ctx());
  assert.equal(auditCalls[0].outcome, "success");
});

test("audit.record — refuses outside execution context", async () => {
  await assert.rejects(
    () => audit.execute({ action: "x" }, { execution: {}, node: {} }),
    /missing workspaceId/,
  );
});
