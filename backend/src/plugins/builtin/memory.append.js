// memory.append — append an item to a JSON array stored under a single
// memory key. If the key doesn't exist (or its value isn't an array),
// the row is initialised as [item].
//
// Race note: this is a read-then-write, so two parallel appends to the
// same key may race. Fine for typical event-log use cases; for heavy
// concurrency, prefer the conversation-history plugin (one row per
// turn, monotonic seq).

import { appendKv } from "../../engine/memoryStore.js";

export default {
  name: "memory.append",
  category: "engine",
  description:
    "Append an item to a JSON array stored under a memory key. " +
    "Useful for event logs, accumulating audit trails, etc.",

  inputSchema: {
    type: "object",
    required: ["key", "item"],
    properties: {
      key:  { type: "string", title: "Key", minLength: 1 },
      // No `type` — `item` can be any shape (the typical use is to
      // append an upstream object via `${nodes.x.output}`). The panel
      // renders it as a textarea because of the `format` hint.
      item: {
        title: "Item",
        format: "textarea",
        description:
          "Item to append. A `${var}` reference preserves the typed " +
          "value from the referenced node.",
        placeholder: "${event}",
      },
      namespace: { type: "string", title: "Namespace", default: "kv" },
    },
  },

  primaryOutput: "length",

  outputSchema: {
    type: "object",
    properties: {
      key:    { type: "string" },
      length: { type: "integer", description: "Total items in the list after the append." },
    },
  },

  async execute(input, ctx) {
    if (input.item === undefined || input.item === null) {
      throw new Error(
        `memory.append: item is empty for key "${input.key}". ` +
        "If you used a `${var}` reference, make sure the variable " +
        "resolves to a non-null value before this node runs.",
      );
    }
    const length = await appendKv({
      workspaceId: ctx?.execution?.workspaceId,
      scope:       "workflow",
      scopeId:     ctx?.execution?.graphId || null,
      namespace:   input.namespace || "kv",
      key:         input.key,
      item:        input.item,
    });
    // Mirror the new array onto ctx.memory so downstream
    // ${memory.<key>} sees the latest list (the worker snapshot
    // would otherwise be stale for the rest of this run).
    if (ctx && typeof ctx === "object") {
      if (!ctx.memory || typeof ctx.memory !== "object") ctx.memory = {};
      const cur = Array.isArray(ctx.memory[input.key]) ? ctx.memory[input.key] : [];
      ctx.memory[input.key] = [...cur, input.item ?? null];
    }
    return { key: input.key, length };
  },
};
