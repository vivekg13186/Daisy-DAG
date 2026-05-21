// Smoke — make ONE agent call against the mock LLM responder. Proves:
//   1. An ai.provider config can be created + decrypted.
//   2. The agent plugin's full path runs (loadAgent, callProvider,
//      tryParseJson, chargeTokens, guardrails) end-to-end against a
//      fake upstream.
//   3. The token rollup row lands (we don't read it here — Layer 2
//      will — but a successful run is enough for smoke).

import { test, expect } from "@playwright/test";
import {
  login, createConfig, createAgent,
  createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution,
} from "../helpers/api.js";
import { startMockLlm, stopMockLlm, MOCK_LLM_URL } from "../helpers/llm-mock.js";

test.beforeAll(async () => { await startMockLlm(); });
test.afterAll(async  () => { await stopMockLlm();  });

test("agent — single LLM call against the mock provider succeeds", async ({}, testInfo) => {
  testInfo.setTimeout(45_000);

  const { token } = await login();

  // 1. ai.provider config pointed at our mock URL. The model name
  //    is unused — the mock answers everything — but the field is
  //    required by the schema.
  const cfgName = `mock-openai-${Date.now()}`;
  await createConfig({
    token,
    name: cfgName,
    type: "ai.provider",
    data: {
      provider: "openai",
      model:    "gpt-4o-mini",
      apiKey:   "sk-mock-not-real",
      baseUrl:  MOCK_LLM_URL,
    },
  });

  // 2. An agent that uses the mock config.
  const agentTitle = `smoke-agent-${Date.now()}`;
  await createAgent({
    token,
    title:      agentTitle,
    configName: cfgName,
    prompt:     "You are a tester. Always reply with JSON: {\"result\":\"ok\"}.",
  });

  // 3. A workflow with one agent node.
  const wf = await createWorkflow({
    token,
    name: `smoke-agent-${Date.now()}`,
    dsl:  {
      name:    "smoke-agent",
      version: "1.0",
      data:    {},
      nodes: [
        {
          name:    "ask",
          action:  "agent",
          inputs:  { agent: agentTitle, input: "hello" },
          outputs: { result: "answer" },
        },
      ],
      edges: [],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 30_000 });
    expect(row.status).toBe("success");
    // The agent plugin parses the mock's JSON response into ctx.answer.
    expect(JSON.stringify(row)).toMatch(/mocked/);
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
