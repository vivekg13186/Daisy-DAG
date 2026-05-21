// Feature — workflow CRUD. Three operations: create, update,
// delete. Driven through the API because the UI authoring path
// (drag, drop, configure node, save) is a Layer 3 visual-regression
// concern. Here we verify the persistence contract end-to-end.

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, updateWorkflow, deleteWorkflow,
  listWorkflows, EMPTY_DSL, uniq,
} from "../../helpers/api.js";

test("workflow CRUD — create then rename then delete", async () => {
  const { token } = await login();
  const originalName = uniq("crud-original");
  const renamedName  = uniq("crud-renamed");

  // Create.
  const wf = await createWorkflow({ token, name: originalName, dsl: EMPTY_DSL });
  expect(wf.id).toBeTruthy();
  expect(wf.name).toBe(originalName);

  // Read back via list — the row is present.
  const beforeRename = await listWorkflows({ token });
  expect(beforeRename.some(w => w.id === wf.id)).toBe(true);

  // Update — rename + add one node to the DSL.
  const updatedDsl = {
    ...EMPTY_DSL,
    nodes: [{ name: "ping", action: "log", inputs: { message: "ok" } }],
  };
  const updated = await updateWorkflow({
    token, id: wf.id, name: renamedName, dsl: updatedDsl,
  });
  expect(updated.name).toBe(renamedName);

  // Delete + confirm the row is gone.
  await deleteWorkflow({ token, id: wf.id });
  const afterDelete = await listWorkflows({ token });
  expect(afterDelete.some(w => w.id === wf.id)).toBe(false);
});
