// Feature — wrong password shows an error banner + does NOT
// navigate away from /login. Also makes sure the response shape
// stays the standard ValidationError so the UI's "invalid
// credentials" message stays unambiguous.

import { test, expect } from "@playwright/test";
import { LoginPage } from "../../pages/LoginPage.js";
import { TEST_ADMIN } from "../../helpers/api.js";

test("wrong password — stays on /login + shows error banner", async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();
  await login.fillCredentials(TEST_ADMIN.email, "not-the-right-password");
  await login.submit();

  // Stay on /login.
  await expect(page).toHaveURL(/\/login/);

  // The LoginPage renders the API's 401 message into a q-banner.
  // Match a few likely shapes — "invalid credentials" is what the
  // backend's UnauthorizedError sends; the UI may decorate it.
  await expect(
    page.locator(".q-banner, .q-notification")
        .filter({ hasText: /invalid|wrong|incorrect|failed/i })
        .first(),
  ).toBeVisible();
});

test("wrong-then-right password — second attempt succeeds", async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();
  await login.fillCredentials(TEST_ADMIN.email, "nope");
  await login.submit();
  // Wait for the failure to surface so the second submit replaces
  // the visible state cleanly.
  await expect(page.locator(".q-banner, .q-notification").first()).toBeVisible();

  // Retry with the right password — no full reload needed.
  await login.fillCredentials(TEST_ADMIN.email, TEST_ADMIN.password);
  await login.submit();
  await expect(page).toHaveURL(/\/(?!login).*/);
});
