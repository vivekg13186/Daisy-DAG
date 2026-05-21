// Feature — clicking Run in the FlowDesigner kicks off a real
// execution. We don't poll the UI's Live panel (Layer 3 concern);
// instead we poll the API for the execution row + assert it
// reached `success`. The UI's role here is just to send the POST.

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, deleteWorkflow,
  ONE_TRANSFORM_DSL, uniq, TEST_ADMIN,
} from "../../helpers/api.js";
import { LoginPage }    from "../../pages/LoginPage.js";
import { FlowDesigner } from "../../pages/FlowDesigner.js";

test("UI Run button — clicking Run fires an execution that succeeds", async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  const { token } = await login();

  // Seed: one workflow with one transform node.
  const wf = await createWorkflow({
    token,
    name: uniq("ui-run"),
    dsl:  ONE_TRANSFORM_DSL,
  });

  try {
    // Watch the API for the POST /graphs/:id/execute that the UI
    // emits when the Run button is clicked. Capturing the response
    // tells us the execution id without scraping the DOM.
    const execPromise = page.waitForResponse(
      r => r.url().includes(`/graphs/${wf.id}/execute`) && r.request().method() === "POST",
      { timeout: 15_000 },
    );

    await new LoginPage(page).loginAs(TEST_ADMIN.email, TEST_ADMIN.password);
    const designer = new FlowDesigner(page);
    await designer.open(wf.id);
    await designer.run();

    const execResponse = await execPromise;
    expect(execResponse.status()).toBe(200);
    const body = await execResponse.json();
    expect(body.id).toBeTruthy();

    // Now poll the execution endpoint via the API helper. The UI's
    // Live panel will be updating in parallel; we let that be.
    const { waitForExecution } = await import("../../helpers/api.js");
    const row = await waitForExecution({ token, id: body.id, timeoutMs: 25_000 });
    expect(row.status).toBe("success");
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
