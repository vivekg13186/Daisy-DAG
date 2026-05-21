// metric.emit — append a value to the workspace_metrics time series.
//
// Use cases:
//   • Business metrics — count(checkout.completed), gauge(queue.depth),
//     histogram(processing.ms) — values you want on a dashboard but
//     that aren't naturally captured by token spend or node duration.
//   • Custom error tracking — increment a counter when a specific
//     branch fires (e.g. fallback model picked) so ops can alert.
//   • SLA timing — histogram(end-to-end.ms) per execution, surfaced
//     in the admin /usage page alongside cost.
//
// Three kinds:
//   • counter   — monotonic +N (defaults value=1). Use for "things
//                 that happened" counts.
//   • gauge     — point-in-time value (queue length, cache size, etc).
//   • histogram — one sample contributing to a distribution. Plot
//                 percentiles in the admin dashboard.
//
// Labels are small key/value tags for filtering on the dashboard.
// Cap is soft: anything above ~10 keys per emission bloats the JSONB
// index without much extra utility.
//
// This is a write-only plugin — the row goes to workflow_metrics and
// the plugin returns the persisted id. Query the data via /metrics
// admin API or by JOINing on workflow_metrics directly.

import { randomUUID } from "node:crypto";
import { pool } from "../../db/pool.js";

const VALID_KINDS = new Set(["counter", "gauge", "histogram"]);
const MAX_LABEL_KEYS = 20;

export default {
  name: "metric.emit",
  category: "enterprise",
  description:
    "Append a numeric metric to the workspace_metrics time series. " +
    "Three kinds — counter (monotonic +N, default value=1), gauge " +
    "(point-in-time value), histogram (one sample for a distribution). " +
    "Pair with the /usage admin page for dashboards, or JOIN " +
    "workflow_metrics directly for custom views.",

  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string", minLength: 1, maxLength: 200,
        title: "Metric name",
        description:
          "Dotted identifier, e.g. checkout.completed, queue.depth, " +
          "processing.ms. Keep stable across emissions.",
      },
      value: {
        type: "number",
        title: "Value",
        description:
          "Numeric value. Counters default to 1 when omitted; gauges " +
          "and histograms require an explicit value.",
      },
      kind: {
        type: "string", enum: ["counter", "gauge", "histogram"],
        default: "counter",
        title: "Kind",
      },
      labels: {
        type: "object",
        title: "Labels",
        description:
          "Small key/value tags for filtering on the dashboard, e.g. " +
          "{tier: \"premium\", region: \"us-east-1\"}. Keep under " +
          "~10 keys.",
      },
    },
  },

  primaryOutput: "id",

  outputSchema: {
    type: "object",
    required: ["id", "name", "kind", "value"],
    properties: {
      id:    { type: "string" },
      name:  { type: "string" },
      kind:  { type: "string" },
      value: { type: "number" },
      ts:    { type: "string", format: "date-time" },
    },
  },

  async execute(input, ctx) {
    const workspaceId = ctx?.execution?.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "metric.emit: execution context is missing workspaceId. " +
        "This plugin can't be invoked outside a normal workflow execution.",
      );
    }
    const projectId   = ctx?.execution?.projectId || null;
    const executionId = ctx?.execution?.id || null;
    const nodeName    = ctx?.node?.name   || null;

    const name = String(input.name || "").trim();
    if (!name) throw new Error("metric.emit: `name` is required");

    const kind = input.kind || "counter";
    if (!VALID_KINDS.has(kind)) {
      throw new Error(`metric.emit: kind must be one of counter | gauge | histogram (got "${kind}")`);
    }

    // Value default: counter defaults to 1; gauges and histograms
    // need an explicit value (NaN-on-gauge masks bugs).
    let value;
    if (input.value === undefined || input.value === null) {
      if (kind === "counter") value = 1;
      else throw new Error(`metric.emit: ${kind} requires an explicit \`value\``);
    } else {
      value = Number(input.value);
      if (!Number.isFinite(value)) {
        throw new Error(`metric.emit: value must be a finite number (got ${JSON.stringify(input.value)})`);
      }
    }

    // Labels: small map; reject ridiculous payloads so the JSONB
    // index doesn't get clobbered by a runaway loop.
    const labels = input.labels && typeof input.labels === "object" && !Array.isArray(input.labels)
      ? input.labels
      : {};
    const keys = Object.keys(labels);
    if (keys.length > MAX_LABEL_KEYS) {
      throw new Error(
        `metric.emit: labels object has ${keys.length} keys; ` +
        `cap is ${MAX_LABEL_KEYS}. Drop seldom-filtered keys to keep ` +
        `the index lean.`,
      );
    }
    // Coerce label values to scalars (strings/numbers/booleans only) —
    // the dashboard filters by equality, nested objects don't help.
    const cleanLabels = {};
    for (const [k, v] of Object.entries(labels)) {
      if (v == null) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        cleanLabels[k] = v;
      } else {
        cleanLabels[k] = JSON.stringify(v);
      }
    }

    const id = randomUUID();
    const ts = new Date();
    try {
      await pool.query(
        `INSERT INTO workflow_metrics
           (id, workspace_id, project_id, execution_id, node_name,
            name, kind, value, labels, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [
          id, workspaceId, projectId, executionId, nodeName,
          name, kind, value, JSON.stringify(cleanLabels), ts,
        ],
      );
    } catch (e) {
      // Pre-033 schema → don't crash the run. The metric is lost,
      // but the surrounding workflow keeps moving. Log so an
      // operator notices the migration is overdue.
      if (e.code === "42P01") {
        throw new Error(
          "metric.emit: workflow_metrics table missing. Apply migration 033_workflow_observability.sql.",
        );
      }
      throw e;
    }

    return { id, name, kind, value, ts: ts.toISOString() };
  },
};
