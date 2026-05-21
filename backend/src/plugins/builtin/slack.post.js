// slack.post — post a message to a Slack channel via chat.postMessage.
//
// In-tree because:
//   • The HTTP shape is dead simple (one POST, Bearer auth, JSON body).
//   • Slack is universal — practically every Daisy customer wants this
//     wired up on day one. Forcing them to install a marketplace
//     plugin for it would be friction.
//
// Richer Slack operations (files.upload, conversations.list, blocks
// kit interactive callbacks) live in a marketplace plugin — see the
// `daisy-plugin-slack` catalog entry for the maintained version.
//
// Inputs:
//   config:   name of a stored `slack` configuration
//   channel:  channel ID (Cxxxxxx) or name (#general). Defaults to
//             the config's defaultChannel.
//   text:     message text (mrkdwn supported)
//   blocks:   optional Block Kit array
//   threadTs: optional parent message timestamp (reply in thread)

export default {
  name: "slack.post",
  category: "enterprise",
  description:
    "Post a message to a Slack channel via chat.postMessage. Auth via " +
    "a stored slack configuration's bot token. For richer Slack ops " +
    "(file upload, channel admin) install the marketplace slack " +
    "plugin from the Plugins page.",
  configRefs: [
    { name: "config", type: "slack", required: true },
  ],
  inputSchema: {
    type: "object",
    required: ["config", "text"],
    properties: {
      config: {
        type: "string", minLength: 1, title: "Slack config",
        description: "Name of a stored slack configuration (Home → Configurations).",
      },
      channel: {
        type: "string", title: "Channel",
        description:
          "Channel ID (Cxxxxxx) or name (#general). Defaults to the " +
          "config's defaultChannel when blank.",
      },
      text: {
        type: "string", format: "textarea", title: "Message text",
        description: "mrkdwn supported. Required even when using blocks (Slack uses it as the notification preview).",
      },
      blocks: {
        title: "Block Kit blocks",
        description:
          "Optional array of Block Kit blocks for rich layouts. " +
          "Usually a `${var}` reference to an array built upstream.",
      },
      threadTs: {
        type: "string", title: "Reply in thread (ts)",
        description: "Parent message timestamp (e.g. 1739123456.000200) to make this a thread reply.",
      },
    },
  },
  primaryOutput: "ok",
  outputSchema: {
    type: "object",
    required: ["ok"],
    properties: {
      ok:      { type: "boolean" },
      ts:      { type: ["string", "null"] },     // timestamp of the posted message
      channel: { type: ["string", "null"] },
      error:   { type: ["string", "null"] },
    },
  },
  async execute({ config, channel, text, blocks, threadTs }, ctx) {
    const cfg = ctx?.config?.[config];
    if (!cfg || typeof cfg !== "object") {
      throw new Error(
        `slack.post: config "${config}" not found. Create a configuration ` +
        `of type slack on the Home page → Configurations.`,
      );
    }
    if (!cfg.botToken) throw new Error(`slack.post: config "${config}" has no botToken set`);
    const dest = channel || cfg.defaultChannel;
    if (!dest) {
      throw new Error(
        `slack.post: no channel supplied and config "${config}" has no defaultChannel set.`,
      );
    }
    const body = { channel: dest, text: String(text || "") };
    if (Array.isArray(blocks)) body.blocks = blocks;
    if (threadTs)              body.thread_ts = String(threadTs);

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type":  "application/json; charset=utf-8",
        "authorization": `Bearer ${cfg.botToken}`,
      },
      body: JSON.stringify(body),
    });
    // Slack always returns HTTP 200 even on errors — the JSON body's
    // `ok` field is the real signal. Don't `throw` on !ok though, so
    // workflows can branch on `ok == false` via executeIf.
    let data = null;
    try { data = await res.json(); } catch { /* ignore — fall through */ }
    if (!data || typeof data !== "object") {
      throw new Error(`slack.post: unexpected response (HTTP ${res.status})`);
    }
    return {
      ok:      data.ok === true,
      ts:      data.ts || null,
      channel: data.channel || null,
      error:   data.ok ? null : (data.error || "unknown_error"),
    };
  },
};
