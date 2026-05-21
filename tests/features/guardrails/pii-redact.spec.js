// Feature — PII detector in redact mode replaces matched values
// with mask tokens. Uses the /guardrails/test endpoint so we don't
// need a real LLM call.

import { test, expect } from "@playwright/test";
import { login, testGuardrails } from "../../helpers/api.js";

test("guardrails — PII redact masks email + phone", async () => {
  const { token } = await login();

  // Send an in-progress policy so the test isn't affected by
  // whatever the project default is.
  const out = await testGuardrails({
    token,
    text: "Email me at alice@example.com or call 555-123-4567 anytime.",
    side: "input",
    policy: {
      apply_to: "both",
      config: {
        pii: { enabled: true, mode: "redact",
               types: ["email", "phone"] },
        toxicity:  { enabled: false, mode: "warn" },
        jailbreak: { enabled: false, mode: "warn" },
      },
    },
  });

  expect(out.blocked).toBe(false);
  // The redacted text no longer contains the literal email + phone.
  expect(out.text).not.toContain("alice@example.com");
  expect(out.text).not.toContain("555-123-4567");
  // Violations array reports what was found.
  expect(Array.isArray(out.violations)).toBe(true);
  expect(out.violations.length).toBeGreaterThan(0);
  const detectors = out.violations.map(v => v.detector);
  expect(detectors).toContain("pii");
});
