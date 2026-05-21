-- Workflow-emitted observability — Step 7.
--
-- Two changes:
--
--   1. workflow_metrics — append-only time series of values emitted
--      by the metric.emit plugin from inside a DAG. Counters / gauges
--      / histograms. Workspace + project + execution attribution so
--      admin dashboards can slice the same way they slice token spend.
--
--   2. Extend the audit_logs.actor_kind CHECK to admit 'workflow' so
--      the audit.record plugin can append audit rows whose actor is
--      the DAG itself (not a user, not a service account). The
--      existing 'user' and 'service_account' kinds stay valid.
--
-- The /usage and /audit admin pages query these tables; no new index
-- columns are needed beyond what's defined below.

-- ─── workflow_metrics ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_metrics (
  id              UUID        PRIMARY KEY,
  workspace_id    UUID        NOT NULL,
  project_id      UUID,                          -- null = workspace-level metric
  execution_id    UUID,                          -- null = emitted outside a run
  node_name       TEXT,
  name            TEXT        NOT NULL,
  kind            TEXT        NOT NULL,
  value           DOUBLE PRECISION NOT NULL,
  labels          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Three indexes cover the dashboards we ship:
--   (workspace_id, name, ts) — "metric X over time across the workspace"
--   (project_id, ts)         — "everything this project emitted recently"
--   (execution_id)           — "what did THIS run emit" (link from Run detail page)
CREATE INDEX IF NOT EXISTS idx_workflow_metrics_ws_name_ts
  ON workflow_metrics (workspace_id, name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_metrics_project_ts
  ON workflow_metrics (project_id, ts DESC) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_metrics_execution
  ON workflow_metrics (execution_id) WHERE execution_id IS NOT NULL;

ALTER TABLE workflow_metrics
  ADD CONSTRAINT workflow_metrics_kind_chk
    CHECK (kind IN ('counter', 'gauge', 'histogram'));

COMMENT ON TABLE workflow_metrics IS
  'Time-series of values emitted by metric.emit plugin nodes. One row per emission.';
COMMENT ON COLUMN workflow_metrics.kind IS
  'counter (monotonic +N) | gauge (point-in-time value) | histogram (sample for distribution).';
COMMENT ON COLUMN workflow_metrics.labels IS
  'Small key/value tags for filtering. Caller-supplied; keep under ~10 keys.';

-- ─── audit_logs.actor_kind: admit 'workflow' ──────────────────────
ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_actor_kind_chk;
ALTER TABLE audit_logs
  ADD  CONSTRAINT audit_logs_actor_kind_chk
    CHECK (actor_kind IN ('user', 'service_account', 'workflow'));
