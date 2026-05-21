// webhook.send — outbound webhook with optional HMAC signing.
//
// Use cases:
//   • Notify downstream systems when a workflow completes
//   • Push events to a partner integration endpoint
//   • Fan out alerts to internal services that listen on HTTPS
//
// Why a dedicated plugin (instead of just using http.request):
//   • Stored `webhook` config — URL + secret + default headers ride
//     together so authors don't paste creds into the DSL.
//   • HMAC-SHA256 signing baked in. The receiver verifies
//     `X-Daisy-Signature: sha256=<hex>` against its shared secret —
//     the standard pattern Stripe/GitHub/Shopify use, so partners
//     plug into Daisy webhooks with no new code.
//   • Timestamp header guards against replay (5-min window
//     recommended on the receiver side).
//   • Friendly retries: configurable retry count + backoff on 5xx /
//     429. http.request leaves that to the workflow author.

import { createHmac } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS     = 60_000;
const DEFAULT_RETRIES    = 0;
const MAX_RETRIES        = 5;
const RETRY_BASE_MS      = 500;

export default {
  name: "webhook.send",
  category: "enterprise",
  description:
    "POST a JSON payload to a stored webhook URL. Adds HMAC-SHA256 " +
    "signing (X-Daisy-Signature) when the config has a secret, plus " +
    "a replay-resistant timestamp header. Retries on 5xx / 429 with " +
    "exponential backoff. Pass the body as a `${var}` JSON object.",
  configRefs: [
    { name: "config", type: "webhook", required: true,
      description: "Name of the stored webhook configuration." },
  ],
  inputSchema: {
    type: "object",
    required: ["config", "body"],
    properties: {
      config: {
        type: "string", minLength: 1, title: "Webhook config",
        description: "Name of a stored webhook configuration (Home → Configurations).",
      },
      body: {
        title: "Body",
        description:
          "JSON-serialisable payload. Usually a `${var}` reference to " +
          "an object the workflow built upstream.",
      },
      headers: {
        type: "object",
        title: "Extra headers",
        description: "Optional per-call headers. Merged on top of the config's extraHeaders.",
      },
      method: {
        type: "string", enum: ["POST","PUT","PATCH"], default: "POST",
        title: "HTTP method",
      },
      timeoutMs: {
        type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS,
        title: "Timeout (ms)",
      },
      retries: {
        type: "integer", minimum: 0, maximum: MAX_RETRIES, default: DEFAULT_RETRIES,
        title: "Retries on 5xx / 429",
        description: "Exponential backoff with jitter. 0 means no retry.",
      },
    },
  },
  primaryOutput: "status",
  outputSchema: {
    type: "object",
    required: ["status"],
    properties: {
      status:  { type: "integer" },
      headers: { type: "object" },
      body:    { type: ["object", "string", "null"] },
      attempts: { type: "integer" },
    },
  },
  async execute({ config, body, headers, method = "POST", timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES }, ctx, _hooks, opts = {}) {
    const cfg = ctx?.config?.[config];
    if (!cfg || typeof cfg !== "object") {
      throw new Error(
        `webhook.send: config "${config}" not found. Create a configuration ` +
        `of type webhook on the Home page → Configurations.`,
      );
    }
    if (!cfg.url) throw new Error(`webhook.send: config "${config}" has no url set`);

    // Body — always serialise to JSON (the webhook contract is JSON-only;
    // form-encoded payloads should use http.request instead).
    const bodyText = typeof body === "string" ? body : JSON.stringify(body ?? {});

    // Build headers: extraHeaders < per-call headers < signing / auth /
    // content-type (the trusted ones win so callers can't accidentally
    // strip the signature).
    const merged = {};
    if (cfg.extraHeaders) {
      try {
        const eh = typeof cfg.extraHeaders === "string"
          ? JSON.parse(cfg.extraHeaders) : cfg.extraHeaders;
        if (eh && typeof eh === "object") Object.assign(merged, eh);
      } catch (e) {
        throw new Error(`webhook.send: config.extraHeaders is not valid JSON — ${e.message}`);
      }
    }
    if (headers && typeof headers === "object") Object.assign(merged, headers);
    merged["content-type"] = "application/json";
    if (cfg.authHeader) merged["authorization"] = String(cfg.authHeader);

    // Signing: hex-encoded HMAC-SHA256 over `${timestamp}.${body}` —
    // matches the Stripe convention so existing receiver code drops in.
    if (cfg.secret) {
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = createHmac("sha256", String(cfg.secret))
        .update(`${ts}.${bodyText}`)
        .digest("hex");
      merged["x-daisy-timestamp"] = ts;
      merged["x-daisy-signature"] = `sha256=${sig}`;
    }

    // Merge timeout with the engine's per-invocation abort signal.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(MAX_TIMEOUT_MS, Math.max(1, timeoutMs)));
    if (typeof timer.unref === "function") timer.unref();
    let signal = ac.signal;
    if (opts.signal) {
      // Chain: abort when EITHER the engine cancel signal fires OR the timeout.
      const link = () => ac.abort();
      opts.signal.addEventListener("abort", link, { once: true });
    }

    const maxRetries = Math.min(MAX_RETRIES, Math.max(0, retries | 0));
    let attempt = 0;
    let lastErr = null;
    try {
      while (attempt <= maxRetries) {
        attempt++;
        try {
          const res = await fetch(cfg.url, { method, headers: merged, body: bodyText, signal });
          const respHeaders = {};
          res.headers.forEach((v, k) => { respHeaders[k] = v; });
          const respText = await res.text().catch(() => "");
          const respBody = parseMaybeJson(respText);
          // Retry on 5xx + 429; everything else (2xx, 4xx) returns
          // immediately so the workflow can decide how to react.
          if ((res.status >= 500 || res.status === 429) && attempt <= maxRetries) {
            await sleep(backoffMs(attempt));
            continue;
          }
          return { status: res.status, headers: respHeaders, body: respBody, attempts: attempt };
        } catch (e) {
          lastErr = e;
          if (e.name === "AbortError") throw new Error(`webhook.send: aborted after ${timeoutMs}ms`);
          if (attempt <= maxRetries) { await sleep(backoffMs(attempt)); continue; }
          throw new Error(`webhook.send: ${e.message}`);
        }
      }
      throw lastErr || new Error("webhook.send: exhausted retries");
    } finally {
      clearTimeout(timer);
    }
  },
};

function parseMaybeJson(text) {
  if (!text) return null;
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return text;
  try { return JSON.parse(t); } catch { return text; }
}

function backoffMs(attempt) {
  // 500ms, 1s, 2s, 4s, 8s with ±25% jitter.
  const base = RETRY_BASE_MS * 2 ** (attempt - 1);
  const jitter = base * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
