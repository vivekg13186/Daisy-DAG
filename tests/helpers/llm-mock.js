// Mock the upstream LLM endpoints at the network layer.
//
// Important: this intercepts requests made by the BACKEND, not the
// browser. Playwright's `page.route()` only catches browser-side
// fetches, so it wouldn't see calls coming from the API/worker.
//
// Two ways to mock the backend's LLM calls:
//
//   A. Point ai.provider configs at a fake base URL that we serve
//      from inside the test compose stack. The fake URL returns the
//      canned response for every call. (Simple, no Playwright tricks
//      needed.) ← what this module supports.
//
//   B. A real mock server we boot via Playwright's webServer. More
//      flexible (per-test canned responses) but heavier. Move to (B)
//      in Layer 2 when feature tests need request-specific replies.
//
// For Layer 1 we go with (A): each smoke test that needs an agent
// call creates an ai.provider config whose baseUrl is the mock URL
// below. The /chat/completions and /messages endpoints are served
// by a tiny embedded responder we boot from the test process.

import { createServer } from "node:http";

const MOCK_PORT = parseInt(process.env.MOCK_LLM_PORT || "9123", 10);
export const MOCK_LLM_URL = `http://host.docker.internal:${MOCK_PORT}/v1`;

let server = null;

/**
 * Boot the mock LLM responder. Idempotent — safe to call from every
 * test file's global setup; reuses the same server if it's already
 * listening.
 *
 * The mock answers BOTH the OpenAI Chat Completions shape and the
 * Anthropic Messages shape, so the same fake URL works regardless of
 * which provider the agent's config selects.
 */
export async function startMockLlm() {
  if (server && server.listening) return MOCK_LLM_URL;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url || "";
      let payload;
      if (url.includes("/chat/completions")) {
        // OpenAI Chat Completions shape.
        payload = {
          id:      "chatcmpl-mock",
          model:   "gpt-4o-mini",
          choices: [{
            index: 0,
            message: { role: "assistant", content: '{"result":"mocked","confidence":0.9}' },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        };
      } else if (url.includes("/messages")) {
        // Anthropic Messages shape.
        payload = {
          id:           "msg_mock",
          model:        "claude-mock",
          content:      [{ type: "text", text: '{"result":"mocked","confidence":0.9}' }],
          stop_reason:  "end_turn",
          usage:        { input_tokens: 12, output_tokens: 8 },
        };
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `mock-llm: unknown path ${url}` } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(MOCK_PORT, () => resolve());
  });
  return MOCK_LLM_URL;
}

/** Shut down the mock — called from globalTeardown. */
export async function stopMockLlm() {
  if (!server) return;
  await new Promise((r) => server.close(r));
  server = null;
}
