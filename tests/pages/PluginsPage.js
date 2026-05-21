// Page Object for /plugins.

export class PluginsPage {
  /** @param {import("@playwright/test").Page} page */
  constructor(page) { this.page = page; }

  async goto() {
    await this.page.goto("/plugins");
    // The page title sits at the top of the page; wait for it so
    // we don't assert on a half-rendered table.
    await this.page.getByRole("heading", { name: /plugin/i }).first().waitFor();
  }

  /** Count rows in the installed-plugins table. The table is a
   *  q-table; row count is the number of <tr> with role="row"
   *  minus the header row. */
  async rowCount() {
    const rows = this.page.locator("tbody tr");
    return rows.count();
  }

  /** Returns true if a plugin with the given name appears in the
   *  installed table. */
  async hasPlugin(name) {
    return this.page.getByText(name, { exact: true }).first().isVisible();
  }
}
