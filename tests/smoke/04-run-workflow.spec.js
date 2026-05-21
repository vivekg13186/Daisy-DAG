// Smoke — execute a one-node workflow and wait for the execution
// row to flip to status='success'. Validates the full execution
// pipeline: API → BullMQ → worker → plugin → node_states write.

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution,
  ONE_TRANSFORM_DSL,
} from "../helpers/api.js";

test("run workflow — single transform node finishes 'success'", async ({}, testInfo) => {
  // Pure API smoke — driven from the API helper because the UI's
  // execution panel is a Layer 2 concern. If this passes, the
  // worker is healthy, BullMQ is wired, and the executor can run
  // a primitive plugin end-to-end.

  testInfo.setTimeout(45_000);   // worker + queue can be a touch slow on cold boot

  const { token } = await login();
  const wf = await createWorkflow({
    token,
    name: `smoke-run-${Date.now()}`,
    dsl:  ONE_TRANSFORM_DSL,
  });
  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    expect(executionId).toBeTruthy();

    const row = await waitForExecution({ token, id: executionId, timeoutMs: 30_000 });
    expect(row.status).toBe("success");
    // The transform plugin's output binds to ctx.answer; the
    // execution record's output should reflect that.
    // (Shape may differ by version; we keep the assertion loose.)
    expect(JSON.stringify(row)).toMatch(/answer/);
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
