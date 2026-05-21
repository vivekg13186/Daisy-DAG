// Page Object for /home. The HomePage is the post-login landing for
// every signed-in user; the toolbar title doubles as our "I'm here"
// signal.

export class HomePage {
  /** @param {import("@playwright/test").Page} page */
  constructor(page) { this.page = page; }

  /** Assert that we're on /home with the toolbar fully rendered. */
  async expectLanded() {
    // The toolbar title gets rendered inside <q-toolbar-title> the
    // moment HomePage hydrates. Waiting for it is more reliable
    // than waiting on a URL change alone (the SPA can route faster
    // than the DOM mounts).
    await this.page.getByText("Daisy AI Orchestrator").first().waitFor({ state: "visible" });
  }

  /** The activity rail items are <q-item> rows with their `tooltip`
   *  used as the accessible label. We match the tooltip text for
   *  stable selectors. */
  async openActivity(label) {
    // Hover the rail item — Playwright clicks it once it's hoverable.
    await this.page.getByRole("listitem").filter({ hasText: label }).first().click();
  }
}
