// Feature — Knowledge Base CRUD via the API. The UI surface
// (KnowledgeBasesPage) is a Layer 3 visual concern; here we lock
// the contract.

import { test, expect } from "@playwright/test";
import { login, createKb, listKbs, deleteKb, uniq } from "../../helpers/api.js";

test("KB CRUD — create + list + delete", async () => {
  const { token } = await login();
  const title = uniq("kb");

  // Note: this test uses pgvector + the text-embedding-3-small
  // provider. The migration 026 must have run, and the worker has
  // to expose the OpenAI provider in the embedder registry. The
  // ingest spec (next file) actually exercises the embedder; this
  // one only touches the metadata table.
  const kb = await createKb({ token, title });
  expect(kb.id).toBeTruthy();
  expect(kb.title).toBe(title);

  const list = await listKbs({ token });
  expect(list.some(k => k.id === kb.id)).toBe(true);

  await deleteKb({ token, id: kb.id });

  const after = await listKbs({ token });
  expect(after.some(k => k.id === kb.id)).toBe(false);
});
