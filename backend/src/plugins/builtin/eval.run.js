// eval.run — kick off a stored eval suite from inside a workflow.
//
// Use case: regression-gate a deploy. The CI workflow ends with an
// eval.run node; if the pass rate drops below `minPassRate`, the
// node fails and the deploy aborts.
//
// Synchronous semantics — the plugin blocks until the suite finishes.
// Suites are usually small (20–100 cases) so this is fine; for very
// large suites the future move is to push onto BullMQ and let the
// plugin poll, but that's not the v1 path.
//
// Inputs:
//   suiteId:      UUID of an eval_suites row (scoped to the execution's
//                 workspace + project — we never cross-tenant)
//   minPassRate:  optional 0–1 floor; node fails when totals.passed/
//                 (passed+failed+errored) drops below
//   failOnError:  when true (default), errored cases count against
//                 the pass rate; when false they're excluded
//
// Output:
//   { runId, totals: { passed, failed, score, totalTokens, ... }, passRate }

import { runSuite } from "../../evals/runner.js";

export default {
  name: "eval.run",
  category: "ai",
  description:
    "Run a stored eval suite and return its totals. Use minPassRate to " +
    "gate deploys: any pass rate below the floor fails the node so the " +
    "upstream workflow can branch on it. The suite must already exist " +
    "(create from the Evals page).",

  inputSchema: {
    type: "object",
    required: ["suiteId"],
    properties: {
      suiteId: {
        type: "string", minLength: 1, title: "Eval suite ID",
        description: "UUID of an eval_suites row. Create suites on the Evals page.",
      },
      minPassRate: {
        type: "number", minimum: 0, maximum: 1,
        title: "Minimum pass rate",
        description:
          "Optional 0–1 floor. Node fails when the suite's pass rate " +
          "drops below this — useful for regression-gating a deploy.",
      },
      failOnError: {
        type: "boolean", default: true,
        title: "Count errored cases as failures",
        description:
          "When true (default), provider errors count against the pass " +
          "rate. When false, they're excluded from the denominator.",
      },
    },
  },

  primaryOutput: "totals",

  outputSchema: {
    type: "object",
    required: ["runId", "totals", "passRate"],
    properties: {
      runId:    { type: "string" },
      passRate: { type: "number" },
      totals: {
        type: "object",
        properties: {
          passed:            { type: "integer" },
          failed:            { type: "integer" },
          score:             { type: "number" },
          totalTokens:       { type: "integer" },
          totalInputTokens:  { type: "integer" },
          totalOutputTokens: { type: "integer" },
          totalCostMicros:   { type: "integer" },
          durationMs:        { type: "integer" },
        },
      },
    },
  },

  async execute(input, ctx) {
    const workspaceId = ctx?.execution?.workspaceId;
    const projectId   = ctx?.execution?.projectId;
    if (!workspaceId || !projectId) {
      throw new Error(
        "eval.run: execution context is missing workspaceId / projectId. " +
        "This plugin can't be invoked outside a normal workflow execution.",
      );
    }

    // userId is informational on the eval_runs row; in a workflow we
    // don't have a real user — use the executor's identity or null.
    const userId = ctx?.execution?.userId || ctx?.actor?.userId || null;

    const { runId, totals } = await runSuite({
      suiteId: input.suiteId,
      userId,
      workspaceId,
      projectId,
    });

    // Pass rate denominator: when failOnError is false, errored cases
    // are excluded — useful when you want to ignore transient provider
    // 429s during a CI run rather than fail the gate.
    const failOnError = input.failOnError !== false;
    const passed   = totals.passed || 0;
    const failed   = totals.failed || 0;
    const total    = failOnError ? (passed + failed) : passed;     // failed already includes errored
    const passRate = total > 0 ? Number((passed / total).toFixed(4)) : 0;

    if (typeof input.minPassRate === "number" && passRate < input.minPassRate) {
      const err = new Error(
        `eval.run: pass rate ${passRate.toFixed(4)} is below the minimum ${input.minPassRate}`,
      );
      err.code = "EVAL_REGRESSION";
      err.runId = runId;
      err.totals = totals;
      err.passRate = passRate;
      throw err;
    }

    return { runId, totals, passRate };
  },
};
