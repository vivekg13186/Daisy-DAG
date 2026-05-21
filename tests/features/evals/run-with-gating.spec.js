// Feature — run a suite synchronously, get totals + per-case
// results. Mock LLM returns {"result":"mocked","confidence":0.9}
// for every call, so we can predict scorer outcomes.

import { test, expect } from "@playwright/test";
import {
  login, createEvalSuite, createEvalCase, runEvalSuite, deleteEvalSuite,
  createConfig, createAgent, deleteAgent, deleteConfig, uniq,
} from "../../helpers/api.js";
import { MOCK_LLM_URL, startMockLlm, stopMockLlm } from "../../helpers/llm-mock.js";

test.beforeAll(async () => { await startMockLlm(); });
test.afterAll(async  () => { await stopMockLlm();  });

test("eval run — synchronous run returns totals + pass count", async ({}, testInfo) => {
  testInfo.setTimeout(60_000);

  const { token } = await login();

  // Setup: agent + suite + 2 cases. Mock LLM returns "mocked" in
  // every reply, so a `contains:"mocked"` scorer ALWAYS passes and
  // a `contains:"never-present"` scorer ALWAYS fails. Total
  // expected: 1 passed, 1 failed.
  const cfg = await createConfig({
    token, name: uniq("run-cfg"), type: "ai.provider",
    data: { provider: "openai", model: "gpt-4o-mini",
            apiKey: "sk-mock", baseUrl: MOCK_LLM_URL },
  });
  const agent = await createAgent({
    token, title: uniq("run-agent"), configName: cfg.name,
    prompt: "tester",
  });
  const suite = await createEvalSuite({
    token, title: uniq("run-suite"), agent_id: agent.id,
  });

  await createEvalCase({
    token, suiteId: suite.id,
    title: "passes",
    inputs: { input: "hi" },
    expected: { contains: "mocked" },
    scorers: [{ type: "contains", weight: 1, config: {} }],
  });
  await createEvalCase({
    token, suiteId: suite.id,
    title: "fails",
    inputs: { input: "hi" },
    expected: { contains: "never-present" },
    scorers: [{ type: "contains", weight: 1, config: {} }],
  });

  try {
    const result = await runEvalSuite({ token, suiteId: suite.id });
    // /runs returns { runId, totals } from the synchronous runner.
    expect(result.runId).toBeTruthy();
    expect(result.totals.passed).toBe(1);
    expect(result.totals.failed).toBe(1);
  } finally {
    await deleteEvalSuite({ token, id: suite.id }).catch(() => {});
    await deleteAgent({ token, id: agent.id }).catch(() => {});
    await deleteConfig({ token, id: cfg.id }).catch(() => {});
  }
});
