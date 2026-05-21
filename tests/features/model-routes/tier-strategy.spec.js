// Feature — create a tier-strategy route. Verifies the validateConfig
// path for the tier strategy + the row round-trips.

import { test, expect } from "@playwright/test";
import {
  login, createModelRoute, listModelRoutes, deleteModelRoute,
  createConfig, createAgent, deleteAgent, deleteConfig, uniq,
} from "../../helpers/api.js";
import { MOCK_LLM_URL, startMockLlm } from "../../helpers/llm-mock.js";

test.beforeAll(async () => { await startMockLlm(); });

test("model routes — tier strategy persists and lists", async () => {
  const { token } = await login();

  // Each tier needs an agent. Mock provider keeps it cheap.
  const cfg = await createConfig({
    token, name: uniq("route-cfg"), type: "ai.provider",
    data: { provider: "openai", model: "gpt-4o-mini",
            apiKey: "sk-mock", baseUrl: MOCK_LLM_URL },
  });
  const cheap    = await createAgent({ token, title: uniq("cheap"),    configName: cfg.name, prompt: "tester" });
  const balanced = await createAgent({ token, title: uniq("balanced"), configName: cfg.name, prompt: "tester" });
  const strong   = await createAgent({ token, title: uniq("strong"),   configName: cfg.name, prompt: "tester" });

  const route = await createModelRoute({
    token,
    title: uniq("tier-route"),
    strategy: "tier",
    config: {
      tiers: {
        cheap:    cheap.title,
        balanced: balanced.title,
        strong:   strong.title,
      },
      // Default tier picked when input doesn't specify.
      default: "balanced",
    },
  });

  try {
    expect(route.id).toBeTruthy();
    const list = await listModelRoutes({ token });
    const row = list.find(r => r.id === route.id);
    expect(row).toBeTruthy();
    expect(row.strategy).toBe("tier");
  } finally {
    await deleteModelRoute({ token, id: route.id }).catch(() => {});
    await deleteAgent({ token, id: cheap.id    }).catch(() => {});
    await deleteAgent({ token, id: balanced.id }).catch(() => {});
    await deleteAgent({ token, id: strong.id   }).catch(() => {});
    await deleteConfig({ token, id: cfg.id     }).catch(() => {});
  }
});
