// Feature — template body renders ${var} placeholders with the
// supplied vars. Covers the /prompt-templates/preview endpoint
// that the UI hits when an author tweaks variables.

import { test, expect } from "@playwright/test";
import { login, previewPromptTemplate } from "../../helpers/api.js";

test("template render — ${name} substitutes against `vars`", async () => {
  const { token } = await login();

  const out = await previewPromptTemplate({
    token,
    body: "Hello ${name}, your role is ${role:default-role}.",
    vars: { name: "Alice", role: "tester" },
  });
  // The endpoint returns either { rendered } or { body, rendered } —
  // either shape carries the rendered string in `rendered`.
  expect(out.rendered).toBe("Hello Alice, your role is tester.");
});

test("template render — missing var falls through to default", async () => {
  const { token } = await login();
  const out = await previewPromptTemplate({
    token,
    body: "Hello ${name}, your role is ${role:visitor}.",
    vars: { name: "Bob" },         // role omitted on purpose
  });
  expect(out.rendered).toBe("Hello Bob, your role is visitor.");
});
