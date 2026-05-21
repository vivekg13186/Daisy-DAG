// memory.history.append — append a single turn to a conversation.
//
// The agent plugin's auto-store path uses the same backing helper, so
// you only need this when you've turned `storeConversation` off on the
// agent and are managing history yourself (e.g. redacting before
// storing).

import { appendHistory } from "../../engine/memoryStore.js";

export default {
  name: "memory.history.append",
  category: "engine",
  description:
    "Append a {role, content} turn to a conversation. Use to log " +
    "extra system messages, capture redacted user input, or maintain " +
    "history when the agent is running in stateless mode.",

  inputSchema: {
    type: "object",
    required: ["conversationId", "role", "content"],
    properties: {
      conversationId: { type: "string", title: "Conversation ID", minLength: 1 },
      role:           {
        type: "string", title: "Role",
        enum: ["user", "assistant", "system", "tool"],
        default: "user",
      },
      content:        { type: "string", title: "Content", format: "textarea" },
    },
  },

  primaryOutput: "ok",

  outputSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
  },

  async execute(input, ctx) {
    await appendHistory({
      workspaceId:    ctx?.execution?.workspaceId,
      scope:          "workflow",
      scopeId:        ctx?.execution?.graphId || null,
      conversationId: input.conversationId,
      role:           input.role,
      content:        String(input.content ?? ""),
    });
    return { ok: true };
  },
};
