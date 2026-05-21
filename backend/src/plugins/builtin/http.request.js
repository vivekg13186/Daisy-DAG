export default {
  name: "http.request",
  category: "engine",
  description: "Performs an HTTP request via fetch and returns status + body.",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url:     { type: "string", format: "uri" },
      method:  { type: "string", enum: ["GET","POST","PUT","PATCH","DELETE","HEAD"], default: "GET" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body:    {},
      timeoutMs: { type: "integer", minimum: 1, maximum: 60000, default: 15000 },
    },
  },
  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "body",

  outputSchema: {
    type: "object",
    required: ["status"],
    properties: {
      status:  { type: "integer" },
      headers: { type: "object" },
      body:    {},
    },
  },
  async execute({ url, method = "GET", headers = {}, body, timeoutMs = 15000 }, _ctx, _hooks, opts = {}) {
    // Two abort sources merged into one signal:
    //   1. The plugin's own `timeoutMs` (back-compat — long-standing
    //      per-call default of 15s, overridable in node inputs).
    //   2. The engine's signal (opts.signal) which aborts when the
    //      node-level timeout fires or the surrounding workflow gives
    //      up. Honoring it shortens the leak window on hung sockets.
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    // If the engine signals abort, propagate to our local controller.
    const onEngineAbort = () => ac.abort(opts.signal?.reason);
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onEngineAbort, { once: true });
    }
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
        signal: ac.signal,
      });
      const text = await res.text();
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: parsed,
      };
    } finally {
      clearTimeout(t);
      if (opts.signal) opts.signal.removeEventListener?.("abort", onEngineAbort);
    }
  },
};
