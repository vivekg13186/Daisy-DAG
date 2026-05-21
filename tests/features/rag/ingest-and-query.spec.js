// Feature — ingest a text document into a KB, then query for the
// content. Touches the full RAG pipeline: chunk → embed → store →
// retrieve.
//
// Note: this DOES burn an OpenAI embedding call (we don't have a
// mocked embedder yet — the LLM mock only covers chat completions).
// If the test stack doesn't have an OpenAI key configured, the
// ingest will fail at the embedder call and the test will skip.

import { test, expect } from "@playwright/test";
import {
  login, createKb, ingestKbText, queryKb, deleteKb, uniq,
} from "../../helpers/api.js";

const HAS_OPENAI_KEY = !!process.env.TEST_OPENAI_API_KEY;

test.describe("KB ingest + query (requires OPENAI_API_KEY)", () => {
  test.skip(!HAS_OPENAI_KEY,
    "set TEST_OPENAI_API_KEY in the env to enable RAG specs against the real embedder");

  test("ingest text → query → top-k results contain the source", async ({}, testInfo) => {
    testInfo.setTimeout(45_000);

    const { token } = await login();
    const kb = await createKb({ token, title: uniq("kb-rag") });

    try {
      // The docs are short + distinctive so cosine similarity will
      // separate them clearly.
      const doc = await ingestKbText({
        token, kbId: kb.id,
        title: "Sky doc",
        text: "The sky is blue because of Rayleigh scattering. " +
              "Sunlight is scattered by molecules in the atmosphere.",
      });
      expect(doc.id).toBeTruthy();
      expect(doc.chunkCount || doc.chunks || doc.numChunks).toBeGreaterThan(0);

      const results = await queryKb({ token, kbId: kb.id, query: "why is the sky blue?", topK: 3 });
      // Endpoint returns { matches: [{ text, score, ... }] } or
      // { chunks: [...] } depending on shape.
      const items = results.matches || results.chunks || results.results || [];
      expect(items.length).toBeGreaterThan(0);
      expect(JSON.stringify(items)).toMatch(/rayleigh|scattering|blue/i);
    } finally {
      await deleteKb({ token, id: kb.id }).catch(() => {});
    }
  });
});
