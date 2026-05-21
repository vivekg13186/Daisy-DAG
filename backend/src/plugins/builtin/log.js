import { log } from "../../utils/logger.js";

export default {
  name: "log",
  category: "engine",
  description: "Logs a message and returns it as output.message.",
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string" },
      level:   { type: "string", enum: ["debug", "info", "warn", "error"], default: "info" },
    },
  },
  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "message",

  outputSchema: {
    type: "object",
    required: ["message"],
    properties: { message: { type: "string" } },
  },
  async execute({ message, level = "info" }) {
    log[level](`[plugin:log] ${message}`);
    return { message };
  },
};
