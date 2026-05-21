// Page Object for /admin?view=projects.
//
// Same page rendered by AdminPage.vue — `?view=projects` selects the
// embedded ProjectsPage component. The page's "New project" button
// opens a dialog with a Name input + Create submit.

export class AdminProjectsPage {
  /** @param {import("@playwright/test").Page} page */
  constructor(page) { this.page = page; }

  async open() {
    await this.page.goto("/admin?view=projects");
    // The page header text "Projects" lands in a <h2>/<h3> as soon
    // as the panel mounts. We wait on it before driving the form.
    await this.page.getByRole("heading", { name: /projects/i }).first().waitFor();
  }

  /** Click the toolbar's "New project" button — kicks open the dialog. */
  async openNewProjectDialog() {
    await this.page.getByRole("button", { name: /new\s+project|create\s+project|add\s+project/i }).first().click();
  }

  /** Inside the new-project dialog. */
  async fillProjectName(name) {
    await this.page.getByLabel(/^name$/i).first().fill(name);
  }

  async confirmCreate() {
    // Either "Create" or "Save" in the dialog footer.
    await this.page.getByRole("button", { name: /^(create|save)$/i }).first().click();
  }

  /** True if a row with the project name is visible in the table. */
  async hasProjectRow(name) {
    return this.page.getByRole("row").filter({ hasText: name }).first().isVisible();
  }
}
