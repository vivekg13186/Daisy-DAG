// Hard ceiling on `ms`. 24h covers virtually every legit "wait until later"
// pause; anything beyond that is almost certainly a typo, and for genuine
// long-running waits a `schedule` trigger is a better fit (it doesn't hold
// a worker concurrency slot the whole time the way a sleeping node does).
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;   // 86_400_000

export default {
  name: "delay",
  category: "engine",
  description: "Sleeps for `ms` milliseconds (up to 24 hours).",
  inputSchema: {
    type: "object",
    required: ["ms"],
    properties: {
      ms: { type: "integer", minimum: 0, maximum: MAX_DELAY_MS },
    },
  },
  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "slept",

  outputSchema: {
    type: "object",
    required: ["slept"],
    properties: { slept: { type: "integer" } },
  },
  async execute({ ms }) {
    await new Promise(r => setTimeout(r, ms));
    return { slept: ms };
  },
};
