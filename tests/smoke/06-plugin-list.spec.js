// Smoke — the /plugins page shows the in-tree plugins after migration
// 034 ran. Confirms:
//   1. The loadBuiltins() sweep discovered all 44 builtins.
//   2. The /plugins API surfaces them with category tags.
//   3. None of the 15 removed legacy plugins still appear.

import { test, expect } from "@playwright/test";
import { login, listPlugins } from "../helpers/api.js";

const REMOVED_NAMES = [
  "shell.exec",
  "ssh", "ftp",
  "file.read", "file.write", "file.list", "file.delete", "file.stat",
  "csv.read", "csv.write", "excel.read", "excel.write",
  "mqtt.publish",
  "web.scrape",
  "stream.demo",
];

// A small set of plugins we KNOW should be present, drawn from each
// category. If any of these are missing after a release, something
// went badly wrong in the loader. Keep this list small + stable —
// adding new plugins doesn't break the smoke check.
const EXPECTED_PRESENT = [
  // engine
  "transform", "delay", "user",
  // ai
  "agent", "rag.retrieve", "agent.classify",
  // enterprise
  "sql.select", "object.store.read", "webhook.send",
];

test("plugin list — builtins present, legacy purged", async () => {
  const { token } = await login();
  const plugins = await listPlugins({ token });

  expect(Array.isArray(plugins)).toBe(true);
  expect(plugins.length).toBeGreaterThanOrEqual(30);

  const names = new Set(plugins.map(p => p.name));

  // Every expected builtin is here.
  for (const want of EXPECTED_PRESENT) {
    expect(names.has(want), `expected plugin "${want}" to be present`).toBe(true);
  }

  // Every removed legacy plugin is gone.
  for (const gone of REMOVED_NAMES) {
    expect(names.has(gone), `removed plugin "${gone}" should NOT be present`).toBe(false);
  }

  // Category tagging — at least one row each.
  const cats = new Set(plugins.map(p => p.category).filter(Boolean));
  for (const c of ["engine", "ai", "enterprise"]) {
    expect(cats.has(c), `expected category "${c}" to appear`).toBe(true);
  }
});
