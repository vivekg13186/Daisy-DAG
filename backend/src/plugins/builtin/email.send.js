import { getTransport } from "../email/util.js";

// String-or-array-of-strings — used for to / cc / bcc.
const stringList = {
  oneOf: [
    { type: "string" },
    { type: "array", items: { type: "string" } },
  ],
};

export default {
  name: "email.send",
  category: "enterprise",
  description:
    "Send an email via SMTP. The `config` input names a stored configuration " +
    "(type mail.smtp) which provides the host, port, credentials, and default " +
    "From address. Manage configs from the Home page → Configurations table.",

  inputSchema: {
    type: "object",
    required: ["config", "subject"],
    properties: {
      // Name of a stored mail.smtp config (Home page → Configurations).
      // The engine pre-loads every config into ctx.config.<name>.<field>
      // before each execution, so we look it up by name from there.
      config: {
        type: "string",
        minLength: 1,
        description:
          "Name of a stored configuration of type mail.smtp. " +
          "Resolved from ctx.config.<name> at run-time.",
      },
      to:        stringList,
      cc:        stringList,
      bcc:       stringList,
      from:      { type: "string", description: "Overrides the config's `from` field if set." },
      replyTo:   { type: "string" },
      subject:   { type: "string", minLength: 1 },
      text:      { type: "string" },
      html:      { type: "string" },
      headers:   { type: "object", additionalProperties: { type: "string" } },
      attachments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            filename:    { type: "string" },
            content:     { type: "string" },
            path:        { type: "string" },
            contentType: { type: "string" },
            encoding:    { type: "string" },                  // e.g. "base64"
            cid:         { type: "string" },                  // for inline images
          },
        },
      },
    },
  },

  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "messageId",

  outputSchema: {
    type: "object",
    required: ["messageId"],
    properties: {
      messageId: { type: "string" },
      accepted:  { type: "array" },
      rejected:  { type: "array" },
      response:  { type: "string" },
      envelope:  { type: "object" },
      // Present in dry-run (jsonTransport) mode — the rendered MIME message
      // as a JSON string. Useful for tests.
      preview:   { type: "string" },
    },
  },

  async execute(input, ctx) {
    if (!input.to && !input.cc && !input.bcc) {
      throw new Error("email.send requires at least one of: to, cc, bcc");
    }
    if (!input.text && !input.html) {
      throw new Error("email.send requires either `text` or `html`");
    }

    // Resolve the named config from the live runtime context.
    // `ctx.config` is populated by worker.js at execution start (see
    // configs/loader.js) and contains every saved config keyed by name.
    const cfg = ctx?.config?.[input.config];
    if (!cfg || typeof cfg !== "object") {
      throw new Error(
        `email.send: config "${input.config}" not found. ` +
        `Create a configuration of type mail.smtp on the Home page → Configurations.`,
      );
    }

    // The mail.smtp config schema uses `username`/`password`; the transport
    // helper expects `user`/`pass`. Map across so users don't have to know.
    const transportOpts = {
      host:   cfg.host,
      port:   cfg.port,
      secure: cfg.secure,
      user:   cfg.username,
      pass:   cfg.password,
    };
    if (!transportOpts.host) {
      throw new Error(
        `email.send: config "${input.config}" has no host set.`,
      );
    }

    const from = input.from || cfg.from || cfg.username;
    if (!from) {
      throw new Error(
        `email.send: no from address — set "from" on the config or pass it on the node input.`,
      );
    }

    const transport = getTransport(transportOpts);
    const message = {
      from,
      to:          input.to,
      cc:          input.cc,
      bcc:         input.bcc,
      replyTo:     input.replyTo,
      subject:     input.subject,
      text:        input.text,
      html:        input.html,
      headers:     input.headers,
      attachments: input.attachments,
    };

    const info = await transport.sendMail(message);
    return {
      messageId: info.messageId || "",
      accepted:  info.accepted  || [],
      rejected:  info.rejected  || [],
      response:  info.response  || "",
      envelope:  info.envelope  || {},
      // jsonTransport returns the rendered email at info.message (string).
      preview:   typeof info.message === "string" ? info.message : "",
    };
  },
};
