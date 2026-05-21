// Feature — invoke the rag.retrieve plugin from inside a workflow.
// Same OpenAI-key dependency as ingest-and-query.

import { test, expect } from "@playwright/test";
import {
  login, createKb, ingestKbText, deleteKb,
  createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution,
  uniq,
} from "../../helpers/api.js";

const HAS_OPENAI_KEY = !!process.env.TEST_OPENAI_API_KEY;

test.describe("rag.retrieve plugin (requires OPENAI_API_KEY)", () => {
  test.skip(!HAS_OPENAI_KEY,
    "set TEST_OPENAI_API_KEY in the env to enable RAG specs against the real embedder");

  test("rag.retrieve — pulls chunks into ctx", async ({}, testInfo) => {
    testInfo.setTimeout(45_000);

    const { token } = await login();
    const kb = await createKb({ token, title: uniq("kb-retrieve") });
    await ingestKbText({
      token, kbId: kb.id, title: "Tides",
      text: "Tides are caused by the gravitational pull of the moon and sun. " +
            "The moon's influence is roughly twice the sun's because of proximity.",
    });

    const wf = await createWorkflow({
      token, name: uniq("rag-flow"),
      dsl: {
        name: "rag-flow", version: "1.0", data: {},
        nodes: [
          { name: "rag", action: "rag.retrieve",
            inputs:  { kbId: kb.id, query: "what causes tides?", topK: 3 },
            outputs: { matches: "chunks" } },
        ],
        edges: [],
      },
    });

    try {
      const { id: executionId } = await executeWorkflow({ token, id: wf.id });
      const row = await waitForExecution({ token, id: executionId, timeoutMs: 30_000 });
      expect(row.status).toBe("success");
      expect(JSON.stringify(row)).toMatch(/tide|moon|gravitational/i);
    } finally {
      await deleteWorkflow({ token, id: wf.id }).catch(() => {});
      await deleteKb({ token, id: kb.id }).catch(() => {});
    }
  });
});
