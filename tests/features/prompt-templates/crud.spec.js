// Feature — prompt template CRUD via the API. The UI surface lives
// on the Home page rail (relocated from /admin in Step 35) but the
// backing endpoints are the contract we want to lock down.

import { test, expect } from "@playwright/test";
import {
  login, createPromptTemplate, deletePromptTemplate, listPromptTemplates, uniq,
} from "../../helpers/api.js";

test("prompt template CRUD — create then delete", async () => {
  const { token } = await login();
  const title = uniq("tmpl");

  const created = await createPromptTemplate({
    token, title,
    body: "You are a ${persona}. Respond concisely about ${topic}.",
    description: "Test template",
    variables: [
      { name: "persona", description: "Who you are" },
      { name: "topic",   description: "What to answer about" },
    ],
  });
  expect(created.id).toBeTruthy();
  expect(created.title).toBe(title);

  // List endpoint returns the row.
  const list = await listPromptTemplates({ token });
  expect(list.some(t => t.id === created.id)).toBe(true);

  // Delete + verify removal.
  await deletePromptTemplate({ token, id: created.id });
  const after = await listPromptTemplates({ token });
  expect(after.some(t => t.id === created.id)).toBe(false);
});
