// Smoke — create an empty workflow via the API, then open it in the
// FlowDesigner. Confirms that the Designer mounts for an existing
// workflow id (the most fragile UI surface in the app).

import { test, expect } from "@playwright/test";
import { login, createWorkflow, deleteWorkflow, EMPTY_DSL } from "../helpers/api.js";
import { LoginPage }    from "../pages/LoginPage.js";
import { FlowDesigner } from "../pages/FlowDesigner.js";
import { TEST_ADMIN }   from "../helpers/api.js";

test("create workflow — empty DSL opens in FlowDesigner", async ({ page }) => {
  // Seed: create the row through the API so the test focuses on
  // the Designer's mount path, not on form filling.
  const { token } = await login();
  const wf = await createWorkflow({
    token,
    name: `smoke-empty-${Date.now()}`,
    dsl:  EMPTY_DSL,
  });
  expect(wf.id).toBeTruthy();

  try {
    // UI: log in via the page, then deep-link into the Designer.
    await new LoginPage(page).loginAs(TEST_ADMIN.email, TEST_ADMIN.password);
    const designer = new FlowDesigner(page);
    await designer.open(wf.id);

    // The Designer's toolbar should be interactive — the Run
    // button is the cleanest signal it mounted with the workflow
    // loaded.
    await expect(designer.runButton()).toBeVisible();
  } finally {
    // Always clean up so smoke can run twice in a row against the
    // same stack without leaving orphan rows.
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
