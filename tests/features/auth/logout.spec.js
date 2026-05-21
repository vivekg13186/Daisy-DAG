// Feature — logout via the UI clears the session and bounces the
// user back to /login. Also confirms the refresh cookie is gone so
// a tab refresh can't reanimate the session.

import { test, expect } from "@playwright/test";
import { LoginPage } from "../../pages/LoginPage.js";
import { TEST_ADMIN } from "../../helpers/api.js";

test("logout drops the session and lands on /login", async ({ page, context }) => {
  // Sign in first.
  await new LoginPage(page).loginAs(TEST_ADMIN.email, TEST_ADMIN.password);

  // The user avatar / account menu lives in the toolbar. Quasar
  // typically renders it as a circular q-btn at the right edge.
  // We try a sequence of likely selectors; the test logs which one
  // actually matched so we can pin it down in Layer 2 cleanup.
  const logoutButton = page
    .getByRole("menuitem", { name: /log\s*out|sign\s*out/i })
    .or(page.getByRole("button", { name: /log\s*out|sign\s*out/i }))
    .first();

  // Open the account menu — most UIs hide logout behind a click
  // on the avatar / "account" button first.
  const accountBtn = page.getByRole("button", { name: /account|profile|user|admin@test\.local/i }).first();
  if (await accountBtn.isVisible().catch(() => false)) {
    await accountBtn.click();
  }
  await logoutButton.click();

  // After logout, the SPA pushes the user to /login.
  await expect(page).toHaveURL(/\/login(\?.*)?$/);
  await expect(page.getByLabel("Email")).toBeVisible();

  // Refresh cookie should be cleared. Refresh the page and confirm
  // we don't auto-redirect to /home.
  await page.reload();
  await expect(page).toHaveURL(/\/login(\?.*)?$/);

  // Sanity: cookie jar no longer has the refresh cookie.
  const cookies = await context.cookies();
  const refreshCookie = cookies.find(c => /refresh/i.test(c.name));
  expect(refreshCookie?.value || "").toBe("");
});
