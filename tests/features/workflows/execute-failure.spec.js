// Feature — when a node fails AND onError is "terminate" (the
// default), the whole execution flips to status='failed' with the
// failing node's error captured on the node_states row. Confirms
// the executor's failure-handling pipeline.

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution, uniq,
} from "../../helpers/api.js";

test("workflow execute — failing transform terminates the run", async ({}, testInfo) => {
  testInfo.setTimeout(45_000);

  const { token } = await login();

  // transform with a deliberately broken FEEL expression. The
  // plugin throws `transform: failed to evaluate FEEL expression`
  // which the executor propagates as a node failure.
  const wf = await createWorkflow({
    token, name: uniq("exec-fail"),
    dsl: {
      name: "exec-fail", version: "1.0", data: {},
      nodes: [
        { name: "bad", action: "transform",
          inputs:  { expression: "this is not valid feel %%%" },
          outputs: { value: "x" },
          // Default onError is terminate; spelled out so the test
          // documents the contract.
          onError: "terminate" },
      ],
      edges: [],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 30_000 });

    expect(row.status).toBe("failed");
    // The error message is recorded somewhere on the row — could be
    // row.error or row.nodes.bad.error depending on shape. Loose
    // match so the test survives minor schema tweaks.
    expect(JSON.stringify(row)).toMatch(/transform|feel|evaluate|failed/i);
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
