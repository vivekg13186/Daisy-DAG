// memory.get — read a single value from the workflow's memory store.
// Returns null when the key doesn't exist (use executeIf to branch).

import { getKv } from "../../engine/memoryStore.js";

export default {
  name: "memory.get",
  category: "engine",
  description:
    "Read a value from workflow memory. Returns null if the key " +
    "doesn't exist. Equivalent to ${memory.<key>} in expressions, " +
    "but available as a node when you need to log / branch on the " +
    "result rather than just interpolate.",

  inputSchema: {
    type: "object",
    required: ["key"],
    properties: {
      key:       { type: "string", title: "Key", minLength: 1 },
      namespace: { type: "string", title: "Namespace", default: "kv" },
    },
  },

  primaryOutput: "value",

  outputSchema: {
    type: "object",
    properties: {
      value: { description: "The stored value, or null if the key doesn't exist." },
      key:   { type: "string" },
    },
  },

  async execute(input, ctx) {
    const value = await getKv({
      workspaceId: ctx?.execution?.workspaceId,
      scope:       "workflow",
      scopeId:     ctx?.execution?.graphId || null,
      namespace:   input.namespace || "kv",
      key:         input.key,
    });
    return { value, key: input.key };
  },
};
