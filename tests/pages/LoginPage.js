// Page Object for /login. Quasar's q-input renders the label as a
// real <label> wrapping the input, so getByLabel finds the field
// reliably even when no data-test attribute is set.

export class LoginPage {
  /** @param {import("@playwright/test").Page} page */
  constructor(page) { this.page = page; }

  async goto() {
    await this.page.goto("/login");
    // The hero brand mark is visible the moment the SPA hydrates;
    // it's a quick, stable signal that the page is interactive.
    await this.page.getByText("Daisy AI Orchestrator").first().waitFor();
  }

  async fillCredentials(email, password) {
    await this.page.getByLabel("Email").fill(email);
    await this.page.getByLabel("Password").fill(password);
  }

  async submit() {
    // Quasar renders the submit as a real <button type="submit">.
    // q-form's @submit.prevent catches it.
    await this.page.locator('form button[type="submit"]').first().click();
  }

  async loginAs(email, password) {
    await this.goto();
    await this.fillCredentials(email, password);
    await this.submit();
  }
}
