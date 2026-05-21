// Feature — PUT /guardrails/policy persists + GET round-trips.

import { test, expect } from "@playwright/test";
import {
  login, getGuardrailPolicy, setGuardrailPolicy,
} from "../../helpers/api.js";

test("guardrail policy — set then read round-trips", async () => {
  const { token } = await login();

  // Save the original so we can restore at the end — this is a
  // singleton per project, not per-test, so cleanup matters.
  const original = await getGuardrailPolicy({ token }).catch(() => null);

  try {
    const desired = {
      apply_to: "input",
      config: {
        pii: { enabled: true, mode: "redact",
               types: ["email", "phone"] },
        toxicity:  { enabled: false, mode: "warn", threshold: 0.5 },
        jailbreak: { enabled: true,  mode: "warn", threshold: 0.7 },
      },
    };
    await setGuardrailPolicy({ token, ...desired });

    const reread = await getGuardrailPolicy({ token });
    expect(reread.apply_to).toBe("input");
    expect(reread.config.pii.enabled).toBe(true);
    expect(reread.config.pii.mode).toBe("redact");
    expect(reread.config.jailbreak.enabled).toBe(true);
  } finally {
    if (original) {
      await setGuardrailPolicy({
        token,
        apply_to: original.apply_to,
        config:   original.config,
      }).catch(() => {});
    }
  }
});
