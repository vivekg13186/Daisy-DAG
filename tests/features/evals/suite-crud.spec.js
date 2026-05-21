// Feature — eval suite + cases CRUD via API.

import { test, expect } from "@playwright/test";
import {
  login, createEvalSuite, createEvalCase, deleteEvalSuite,
  createConfig, createAgent, deleteAgent, deleteConfig,
  uniq,
} from "../../helpers/api.js";
import { MOCK_LLM_URL, startMockLlm } from "../../helpers/llm-mock.js";

test.beforeAll(async () => { await startMockLlm(); });

test("eval suite CRUD — create + add cases + delete", async () => {
  const { token } = await login();

  // Bind to an agent so the suite is runnable.
  const cfgName    = uniq("eval-cfg");
  const agentTitle = uniq("eval-agent");
  const cfg = await createConfig({
    token, name: cfgName, type: "ai.provider",
    data: { provider: "openai", model: "gpt-4o-mini",
            apiKey: "sk-mock", baseUrl: MOCK_LLM_URL },
  });
  const agent = await createAgent({
    token, title: agentTitle, configName: cfgName,
    prompt: "You are a tester. Reply with {\"result\":\"ok\"}.",
  });

  const suite = await createEvalSuite({
    token,
    title: uniq("suite"),
    description: "Wave 2 smoke",
    agent_id: agent.id,
  });
  expect(suite.id).toBeTruthy();

  try {
    // Add two cases.
    const c1 = await createEvalCase({
      token, suiteId: suite.id,
      title: "contains-check",
      inputs: { input: "hello" },
      expected: { contains: "mocked" },
      scorers: [{ type: "contains", weight: 1, config: {} }],
    });
    expect(c1.id).toBeTruthy();

    const c2 = await createEvalCase({
      token, suiteId: suite.id,
      title: "exact-fail-case",
      inputs: { input: "world" },
      expected: { exact: "this-will-not-match" },
      scorers: [{ type: "exact", weight: 1, config: {} }],
    });
    expect(c2.id).toBeTruthy();
  } finally {
    await deleteEvalSuite({ token, id: suite.id }).catch(() => {});
    await deleteAgent({ token, id: agent.id }).catch(() => {});
    await deleteConfig({ token, id: cfg.id }).catch(() => {});
  }
});
