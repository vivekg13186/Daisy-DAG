// Feature — /plugins API returns category-tagged rows + the UI
// renders the same set. We assert on the API (the contract) and
// spot-check the page renders SOME plugin names (the UI binding).
// Category-rail UI filtering is a Layer 3 visual concern.

import { test, expect } from "@playwright/test";
import { login, listPlugins, TEST_ADMIN } from "../../helpers/api.js";
import { LoginPage }    from "../../pages/LoginPage.js";
import { PluginsPage }  from "../../pages/PluginsPage.js";

test("plugins — every row carries one of the curated categories", async () => {
  const { token } = await login();
  const plugins = await listPlugins({ token });

  const validCats = new Set(["engine", "ai", "enterprise", null /* third-party */]);
  for (const p of plugins) {
    expect(validCats.has(p.category)).toBe(true);
  }

  // Each curated category has at least one row.
  const counts = plugins.reduce((m, p) => {
    if (p.category) m[p.category] = (m[p.category] || 0) + 1;
    return m;
  }, {});
  expect(counts.engine     ?? 0).toBeGreaterThan(0);
  expect(counts.ai         ?? 0).toBeGreaterThan(0);
  expect(counts.enterprise ?? 0).toBeGreaterThan(0);
});

test("plugins page — UI renders the API's plugin set", async ({ page }) => {
  await new LoginPage(page).loginAs(TEST_ADMIN.email, TEST_ADMIN.password);
  const plugins = new PluginsPage(page);
  await plugins.goto();

  // Spot-check a few stable names from each category.
  for (const name of ["transform", "agent", "sql.select"]) {
    expect(await plugins.hasPlugin(name)).toBe(true);
  }
});
