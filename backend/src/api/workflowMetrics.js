// Workflow metrics read API — admin/editor, workspace-scoped.
//
// Two endpoints:
//
//   GET /workflow-metrics                — list raw emissions (paginated)
//   GET /workflow-metrics/aggregate      — bucketed series for charts
//
// Filters on both:
//   • name=<metric>          — exact match on metric name
//   • projectId=<uuid>       — single project
//   • executionId=<uuid>     — single execution
//   • from=ISO, to=ISO       — time bounds
//   • kind=counter|gauge|histogram
//
// The aggregate endpoint groups by `bucket` (1m/5m/1h/1d) and applies
// an aggregator suited to the kind:
//   counter   → SUM
//   gauge     → AVG (latest is also useful — `latest=1` flips it)
//   histogram → percentile (p50/p95/p99 via `pct=`, default p95)
//
// No write endpoints — emissions come exclusively from the metric.emit
// plugin or future engine-internal writes.

import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireUser, requireRole } from "../middleware/auth.js";
import { ValidationError } from "../utils/errors.js";

const router = Router();
router.use(requireUser);
router.use(requireRole("admin", "editor"));

const VALID_BUCKETS = new Map([
  ["1m",  "1 minute"],
  ["5m",  "5 minutes"],
  ["15m", "15 minutes"],
  ["1h",  "1 hour"],
  ["1d",  "1 day"],
]);
const MAX_LIMIT = 500;

router.get("/", async (req, res, next) => {
  try {
    const params = [req.user.workspaceId];
    const where  = ["workspace_id = $1"];

    if (req.query.name) {
      params.push(req.query.name);
      where.push(`name = $${params.length}`);
    }
    if (req.query.projectId) {
      params.push(req.query.projectId);
      where.push(`project_id = $${params.length}`);
    }
    if (req.query.executionId) {
      params.push(req.query.executionId);
      where.push(`execution_id = $${params.length}`);
    }
    if (req.query.kind) {
      params.push(req.query.kind);
      where.push(`kind = $${params.length}`);
    }
    if (req.query.from) {
      params.push(new Date(req.query.from));
      where.push(`ts >= $${params.length}`);
    }
    if (req.query.to) {
      params.push(new Date(req.query.to));
      where.push(`ts <= $${params.length}`);
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 100));

    const { rows } = await pool.query(
      `SELECT id, project_id, execution_id, node_name, name, kind, value, labels, ts
         FROM workflow_metrics
        WHERE ${where.join(" AND ")}
        ORDER BY ts DESC
        LIMIT ${limit}`,
      params,
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.get("/aggregate", async (req, res, next) => {
  try {
    if (!req.query.name) throw new ValidationError("`name` is required for aggregate");
    const bucket = String(req.query.bucket || "1h");
    if (!VALID_BUCKETS.has(bucket)) {
      throw new ValidationError(`bucket must be one of ${[...VALID_BUCKETS.keys()].join(", ")}`);
    }
    const bucketInterval = VALID_BUCKETS.get(bucket);

    // Pick the aggregator. counter → SUM, gauge → AVG (or latest with
    // ?latest=1), histogram → percentile_cont(pct).
    const kind = String(req.query.kind || "counter");
    let agg;
    if (kind === "counter") {
      agg = "SUM(value)";
    } else if (kind === "gauge") {
      agg = req.query.latest === "1"
        ? "(ARRAY_AGG(value ORDER BY ts DESC))[1]"
        : "AVG(value)";
    } else if (kind === "histogram") {
      const pct = Math.min(0.999, Math.max(0.01, parseFloat(req.query.pct) || 0.95));
      agg = `percentile_cont(${pct}) WITHIN GROUP (ORDER BY value)`;
    } else {
      throw new ValidationError(`kind must be counter, gauge or histogram`);
    }

    const params = [req.user.workspaceId, req.query.name];
    const where  = [`workspace_id = $1`, `name = $2`, `kind = '${kind}'`];

    if (req.query.projectId) {
      params.push(req.query.projectId);
      where.push(`project_id = $${params.length}`);
    }
    if (req.query.from) {
      params.push(new Date(req.query.from));
      where.push(`ts >= $${params.length}`);
    } else {
      // Default lookback: 24h. Avoids accidentally scanning the
      // entire table from an unbounded curl.
      params.push(new Date(Date.now() - 24 * 3600 * 1000));
      where.push(`ts >= $${params.length}`);
    }
    if (req.query.to) {
      params.push(new Date(req.query.to));
      where.push(`ts <= $${params.length}`);
    }

    const sql = `
      SELECT date_trunc('${trunc(bucket)}', ts) AS bucket_start,
             ${agg} AS value,
             COUNT(*) AS samples
        FROM workflow_metrics
       WHERE ${where.join(" AND ")}
       GROUP BY bucket_start
       ORDER BY bucket_start`;
    const { rows } = await pool.query(sql, params);
    res.json({ name: req.query.name, kind, bucket: bucketInterval, points: rows });
  } catch (e) { next(e); }
});

// date_trunc unit — drops the bucket-size suffix so '5m' → 'minute' etc.
function trunc(b) {
  if (b.endsWith("m")) return "minute";
  if (b.endsWith("h")) return "hour";
  if (b.endsWith("d")) return "day";
  return "minute";
}

export default router;
