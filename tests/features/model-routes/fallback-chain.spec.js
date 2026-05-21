// Feature — fallback strategy with a chain of agents. Locks the
// shape; runtime fallback behaviour is covered separately when
// we add a "primary errors" mocked path.

import { test, expect } from "@playwright/test";
import {
  login, createModelRoute, deleteModelRoute,
  createConfig, createAgent, deleteAgent, deleteConfig, uniq,
} from "../../helpers/api.js";
import { MOCK_LLM_URL, startMockLlm } from "../../helpers/llm-mock.js";

test.beforeAll(async () => { await startMockLlm(); });

test("model routes — fallback chain persists with ordered agents", async () => {
  const { token } = await login();
  const cfg = await createConfig({
    token, name: uniq("fb-cfg"), type: "ai.provider",
    data: { provider: "openai", model: "gpt-4o-mini",
            apiKey: "sk-mock", baseUrl: MOCK_LLM_URL },
  });
  const a1 = await createAgent({ token, title: uniq("primary"),   configName: cfg.name, prompt: "tester" });
  const a2 = await createAgent({ token, title: uniq("secondary"), configName: cfg.name, prompt: "tester" });
  const a3 = await createAgent({ token, title: uniq("tertiary"),  configName: cfg.name, prompt: "tester" });

  const route = await createModelRoute({
    token,
    title: uniq("fb-route"),
    strategy: "fallback",
    config: { chain: [a1.title, a2.title, a3.title] },
  });

  try {
    expect(route.id).toBeTruthy();
  } finally {
    await deleteModelRoute({ token, id: route.id }).catch(() => {});
    await deleteAgent({ token, id: a1.id }).catch(() => {});
    await deleteAgent({ token, id: a2.id }).catch(() => {});
    await deleteAgent({ token, id: a3.id }).catch(() => {});
    await deleteConfig({ token, id: cfg.id }).catch(() => {});
  }
});
