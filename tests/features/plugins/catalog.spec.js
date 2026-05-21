// Feature — admin can browse the marketplace catalog. The hosted
// default catalog is unreachable from the test stack (deliberate —
// the test compose has no PLUGIN_CATALOG_URL override). The
// backend falls back to the bundled deploy/plugin-catalog.example.json,
// so the catalog should resolve with that fallback source noted in
// the response.

import { test, expect } from "@playwright/test";
import { login, getPluginCatalog } from "../../helpers/api.js";

test("plugin catalog — returns a non-empty list of marketplace entries", async () => {
  const { token } = await login();
  const cat = await getPluginCatalog({ token });

  // The endpoint returns { source, fetchedAt, name, version,
  // plugins: [...] } per backend/src/api/plugins.js.
  expect(cat.source).toBeTruthy();
  expect(Array.isArray(cat.plugins)).toBe(true);
  expect(cat.plugins.length).toBeGreaterThan(0);

  // Every catalog entry has the mandatory fields.
  for (const p of cat.plugins) {
    expect(typeof p.name).toBe("string");
    expect(typeof p.version).toBe("string");
    expect(typeof p.manifestUrl).toBe("string");
  }

  // The `installed` annotation is present on each entry (false in
  // the test stack — no marketplace plugins installed by default).
  expect(cat.plugins.every(p => typeof p.installed === "boolean")).toBe(true);
});
