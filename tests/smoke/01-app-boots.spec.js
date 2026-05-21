// Layer 1 / smoke — the most basic "is the app even reachable" check.
//
// Doesn't need to log in: visiting /login is enough to confirm
// the SPA bundle loads, the Vue Router takes over, and the
// LoginPage hydrates. If this fails, everything else will too.

import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage.js";

test("app boots — /login renders the LoginPage", async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();

  // The brand text is present and visible.
  await expect(page.getByText("Daisy AI Orchestrator").first()).toBeVisible();

  // Both inputs are reachable by accessible name. If Quasar rewires
  // q-input to drop the <label> association we'll catch it here.
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});
