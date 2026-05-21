// memory.history.load — fetch the most-recent N turns of a conversation.
//
// The agent plugin auto-loads history when a `conversationId` is set on
// its node, so most flows don't need this. Use it when you want to
// pre-process the turns (redact PII, filter, summarise) before passing
// them to an agent that's running in stateless mode.

import { loadHistory } from "../../engine/memoryStore.js";

export default {
  name: "memory.history.load",
  category: "engine",
  description:
    "Load the last N turns of a conversation from memory. Returns " +
    "{ turns: [{role, content}, …] } in chronological order " +
    "(oldest first), suitable for passing as `messages` to an LLM.",

  inputSchema: {
    type: "object",
    required: ["conversationId"],
    properties: {
      conversationId: { type: "string", title: "Conversation ID", minLength: 1 },
      limit: {
        type: "integer", title: "Limit",
        minimum: 0, maximum: 200, default: 20,
      },
    },
  },

  primaryOutput: "turns",

  outputSchema: {
    type: "object",
    required: ["turns", "count"],
    properties: {
      turns: { type: "array", items: { type: "object" } },
      count: { type: "integer" },
    },
  },

  async execute(input, ctx) {
    const turns = await loadHistory({
      workspaceId:    ctx?.execution?.workspaceId,
      scope:          "workflow",
      scopeId:        ctx?.execution?.graphId || null,
      conversationId: input.conversationId,
      limit:          input.limit ?? 20,
    });
    return { turns, count: turns.length };
  },
};
