// Smoke — log in as the seeded admin and land on /home.
//
// Verifies that:
//   1. The /auth/login endpoint accepts the bootstrap creds.
//   2. The frontend stores the access token + reroutes to /home.
//   3. /home renders the toolbar (we use the rebrand text as a
//      stable "I'm here" signal).

import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage.js";
import { HomePage }  from "../pages/HomePage.js";
import { TEST_ADMIN } from "../helpers/api.js";

test("login — admin lands on /home", async ({ page }) => {
  const login = new LoginPage(page);
  const home  = new HomePage(page);

  await login.loginAs(TEST_ADMIN.email, TEST_ADMIN.password);

  // Either we ended up on / or on a deep-link that the auth guard
  // was holding onto; smoke just checks we're authenticated and the
  // HomePage rendered.
  await expect(page).toHaveURL(/\/(?!login).*/);
  await home.expectLanded();
});
