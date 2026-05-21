// memory.delete — remove a single key from workflow memory.

import { deleteKv } from "../../engine/memoryStore.js";

export default {
  name: "memory.delete",
  category: "engine",
  description:
    "Remove a key from workflow memory. Returns deleted=false when " +
    "the key didn't exist (idempotent).",

  inputSchema: {
    type: "object",
    required: ["key"],
    properties: {
      key:       { type: "string", title: "Key", minLength: 1 },
      namespace: { type: "string", title: "Namespace", default: "kv" },
    },
  },

  primaryOutput: "deleted",

  outputSchema: {
    type: "object",
    properties: {
      key:     { type: "string" },
      deleted: { type: "boolean" },
    },
  },

  async execute(input, ctx) {
    const deleted = await deleteKv({
      workspaceId: ctx?.execution?.workspaceId,
      scope:       "workflow",
      scopeId:     ctx?.execution?.graphId || null,
      namespace:   input.namespace || "kv",
      key:         input.key,
    });
    // Keep ctx.memory in sync with the DB so downstream
    // ${memory.<key>} reads undefined / null instead of the stale
    // pre-run value.
    if (ctx?.memory && typeof ctx.memory === "object") {
      delete ctx.memory[input.key];
    }
    return { key: input.key, deleted };
  },
};
