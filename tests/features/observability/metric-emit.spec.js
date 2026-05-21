// Feature — a metric.emit node lands a row in workflow_metrics
// + the GET /workflow-metrics endpoint surfaces it.

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution,
  listWorkflowMetrics, uniq,
} from "../../helpers/api.js";

test("metric.emit — counter shows up on /workflow-metrics", async ({}, testInfo) => {
  testInfo.setTimeout(30_000);

  const { token } = await login();
  const metricName = uniq("smoke.metric");

  const wf = await createWorkflow({
    token, name: uniq("metric-wf"),
    dsl: {
      name: "metric-wf", version: "1.0", data: {},
      nodes: [
        { name: "tick", action: "metric.emit",
          inputs: {
            name:   metricName,
            kind:   "counter",
            value:  1,
            labels: { source: "smoke-test" },
          } },
      ],
      edges: [],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 20_000 });
    expect(row.status).toBe("success");

    // The metric should now appear when we list by name.
    const metrics = await listWorkflowMetrics({ token, name: metricName, limit: 10 });
    expect(Array.isArray(metrics)).toBe(true);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics[0];
    expect(m.name).toBe(metricName);
    expect(m.kind).toBe("counter");
    expect(Number(m.value)).toBe(1);
    expect(m.labels?.source).toBe("smoke-test");
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
