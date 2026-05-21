// Feature — agent CRUD via the API + the UI. We create through the
// API (faster), then verify the AgentDesigner opens populated with
// the row's data, change the prompt through the UI, and assert the
// saved value round-trips back through the API.

import { test, expect } from "@playwright/test";
import {
  login, createConfig, createAgent, deleteAgent, deleteConfig,
  listAgents, uniq, TEST_ADMIN,
} from "../../helpers/api.js";
import { LoginPage }     from "../../pages/LoginPage.js";
import { AgentDesigner } from "../../pages/AgentDesigner.js";
import { startMockLlm, MOCK_LLM_URL } from "../../helpers/llm-mock.js";

test.beforeAll(async () => { await startMockLlm(); });

test("agent CRUD — create via API, edit via UI, round-trip", async ({ page }) => {
  const { token } = await login();
  const cfgName    = uniq("agent-crud-cfg");
  const agentTitle = uniq("agent-crud");

  const cfg = await createConfig({
    token, name: cfgName, type: "ai.provider",
    data: { provider: "openai", model: "gpt-4o-mini",
            apiKey: "sk-mock", baseUrl: MOCK_LLM_URL },
  });

  const agent = await createAgent({
    token, title: agentTitle, configName: cfgName,
    prompt: "You are a tester. Reply with JSON.",
  });

  try {
    // The new row shows up in list endpoint.
    const beforeEdit = await listAgents({ token });
    expect(beforeEdit.some(a => a.id === agent.id)).toBe(true);

    // UI: open in designer, edit prompt, save.
    await new LoginPage(page).loginAs(TEST_ADMIN.email, TEST_ADMIN.password);
    const designer = new AgentDesigner(page);
    await designer.open(agent.id);

    const newPrompt = "You are a tester. Always respond with exactly the word OK.";
    await designer.setPrompt(newPrompt);
    await designer.save();
    await designer.expectSaveToast();

    // Round-trip: fetch the agent through the API and confirm the
    // new prompt persisted.
    const afterEdit = await listAgents({ token });
    const updated = afterEdit.find(a => a.id === agent.id);
    expect(updated.prompt).toContain("OK");
  } finally {
    await deleteAgent({ token, id: agent.id }).catch(() => {});
    await deleteConfig({ token, id: cfg.id }).catch(() => {});
  }
});
