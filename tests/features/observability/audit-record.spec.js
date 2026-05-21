// Feature — audit.record from inside a DAG appends a row tagged
// actor_kind='workflow'. The /audit list endpoint surfaces it.

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution,
  listAudit, uniq,
} from "../../helpers/api.js";

test("audit.record — workflow-emitted row appears on /audit", async ({}, testInfo) => {
  testInfo.setTimeout(30_000);

  const { token } = await login();
  const action = `smoke.audit.${uniq("ev")}`;

  const wf = await createWorkflow({
    token, name: uniq("audit-wf"),
    dsl: {
      name: "audit-wf", version: "1.0", data: {},
      nodes: [
        { name: "rec", action: "audit.record",
          inputs: {
            action,
            resource: { type: "smoke-test", id: "x1", name: "smoke" },
            outcome:  "success",
            metadata: { source: "wave-2-tests" },
          } },
      ],
      edges: [],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 20_000 });
    expect(row.status).toBe("success");

    // Audit list filtered by the unique action name should return
    // exactly our row.
    const audit = await listAudit({ token, action, limit: 5 });
    expect(Array.isArray(audit)).toBe(true);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const r = audit[0];
    expect(r.action).toBe(action);
    expect(r.actor_kind).toBe("workflow");
    expect(r.resource_type).toBe("smoke-test");
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
