// Feature — workspace admin can create + delete projects. Two
// flows: API-only (locks the contract) + UI (locks the form).

import { test, expect } from "@playwright/test";
import {
  login, createProject, deleteProject, listProjects, uniq, TEST_ADMIN,
} from "../../helpers/api.js";
import { LoginPage }         from "../../pages/LoginPage.js";
import { AdminProjectsPage } from "../../pages/AdminProjectsPage.js";

test("project CRUD via API — create + delete", async () => {
  const { token } = await login();
  const name = uniq("project");

  const created = await createProject({ token, name });
  expect(created.id).toBeTruthy();

  const before = await listProjects({ token });
  expect(before.some(p => p.id === created.id)).toBe(true);

  await deleteProject({ token, id: created.id });
  const after = await listProjects({ token });
  // delete is a soft-delete (deleted_at set); the list endpoint
  // hides soft-deleted rows by default. Either way, the row is no
  // longer "visible".
  const stillVisible = after.some(p => p.id === created.id && !p.deleted_at);
  expect(stillVisible).toBe(false);
});

test("project create via UI — dialog persists a new row", async ({ page }) => {
  const { token } = await login();
  const name = uniq("ui-project");

  await new LoginPage(page).loginAs(TEST_ADMIN.email, TEST_ADMIN.password);
  const projects = new AdminProjectsPage(page);
  await projects.open();
  await projects.openNewProjectDialog();
  await projects.fillProjectName(name);
  await projects.confirmCreate();

  // The new row should land in the table.
  await expect(
    page.getByRole("row").filter({ hasText: name }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // Tidy up via the API so re-runs don't pile up.
  const list = await listProjects({ token });
  const row = list.find(p => p.name === name);
  if (row) await deleteProject({ token, id: row.id }).catch(() => {});
});
