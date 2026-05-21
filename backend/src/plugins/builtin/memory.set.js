// memory.set — write/update a value in the workflow's memory store.
// Subsequent runs see the value via ${memory.<key>}.

import { setKv } from "../../engine/memoryStore.js";

export default {
  name: "memory.set",
  category: "engine",
  description:
    "Store a value in workflow memory. Persists across runs. Read " +
    "back via ${memory.<key>} or the memory.get plugin.",

  inputSchema: {
    type: "object",
    required: ["key", "value"],
    properties: {
      key: { type: "string", title: "Key", minLength: 1 },
      // No `type` on purpose — the value can be any shape (string,
      // number, object, array). `format: "textarea"` is honoured by
      // the property panel to render a multi-line input even for
      // no-type fields, and the placeholder hint nudges users to use
      // a `${var}` reference when they want to store typed output
      // from an upstream node.
      value: {
        title: "Value",
        format: "textarea",
        description:
          "Literal value, or a ${var} reference. Single-placeholder " +
          "strings (`${nodes.x.output}`) preserve their typed result " +
          "(arrays / objects keep their shape).",
        placeholder: "${someVar}  or  literal text",
      },
      namespace: { type: "string", title: "Namespace", default: "kv" },
    },
  },

  primaryOutput: "key",

  outputSchema: {
    type: "object",
    properties: {
      key:   { type: "string" },
      value: { description: "Echo of what was stored." },
    },
  },

  async execute(input, ctx) {
    // Fail loudly instead of silently storing JSON null. The most
    // common cause of "I stored X and got back null" is the user
    // typing `${someVar}` where `someVar` doesn't exist — the
    // expression resolver returns undefined and we'd otherwise persist
    // a null row. Surfacing the error makes the missing reference
    // immediately obvious in the InstanceViewer.
    if (input.value === undefined || input.value === null) {
      throw new Error(
        `memory.set: value is empty for key "${input.key}". ` +
        "If you used a `${var}` reference, make sure the variable " +
        "resolves to a non-null value before this node runs.",
      );
    }
    const value = input.value;
    await setKv({
      workspaceId: ctx?.execution?.workspaceId,
      scope:       "workflow",
      scopeId:     ctx?.execution?.graphId || null,
      namespace:   input.namespace || "kv",
      key:         input.key,
      value,
    });
    // ctx.memory is a snapshot loaded once per execution by the worker
    // (see backend/src/worker.js — loadKvForScope). Without writing here,
    // a downstream `${memory.<key>}` expression would read the stale
    // pre-run value. Keep the in-memory view in sync with the DB.
    if (ctx && typeof ctx === "object") {
      if (!ctx.memory || typeof ctx.memory !== "object") ctx.memory = {};
      ctx.memory[input.key] = value;
    }
    return { key: input.key, value };
  },
};
