// audit.record — append an audit_logs row from inside a DAG.
//
// The engine writes audit rows on its own for the events it controls
// (graph CRUD, execution start, plugin install, RBAC grants). This
// plugin lets workflows record what they did to USER-VISIBLE state —
// e.g. "approved order 42", "promoted user X to admin in our app",
// "purged contact record for user Z". Once the row is in audit_logs
// it shows up on the existing /admin/audit page like any other event.
//
// Actor: rows written by this plugin carry actor_kind='workflow' so
// the audit page can split "human action", "service-account action",
// and "workflow action" cleanly. The engine added 'workflow' to the
// CHECK constraint in migration 033.
//
// Common usage:
//   action:    "billing.invoice.voided"            // dotted-string event
//   resource:  { type: "invoice", id: "${inv.id}", name: "${inv.number}" }
//   outcome:   "success"  (default) | "failed" | "denied"
//   metadata:  { reason: "${reason}", refundTo: "${customer.email}" }

import { auditLog } from "../../audit/log.js";

export default {
  name: "audit.record",
  category: "enterprise",
  description:
    "Append an audit_logs row from inside a DAG. Rows carry " +
    "actor_kind='workflow' so admins can filter workflow-initiated " +
    "events separately from human + service-account ones. Use for " +
    "events the engine doesn't capture on its own (business-state " +
    "mutations, downstream-system writes).",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string", minLength: 1, maxLength: 200,
        title: "Action",
        description: "Dotted-string event name (e.g. order.refunded).",
      },
      resource: {
        type: "object",
        title: "Resource",
        description:
          "Optional target description: { type, id, name }. Both id " +
          "and name help the admin audit page render a clickable row.",
        properties: {
          type: { type: "string", maxLength: 100 },
          id:   { type: "string", maxLength: 200 },
          name: { type: "string", maxLength: 250 },
        },
      },
      outcome: {
        type: "string", enum: ["success", "failed", "denied"],
        default: "success",
        title: "Outcome",
      },
      metadata: {
        type: "object", default: {},
        title: "Metadata",
        description:
          "Free-form JSONB payload. Keep it small — admin search " +
          "queries scan this column.",
      },
    },
  },
  primaryOutput: "recorded",
  outputSchema: {
    type: "object",
    required: ["recorded", "action"],
    properties: {
      recorded: { type: "boolean" },
      action:   { type: "string" },
    },
  },
  async execute(input, ctx) {
    const workspaceId = ctx?.execution?.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "audit.record: execution context is missing workspaceId. " +
        "This plugin can't be invoked outside a normal workflow execution.",
      );
    }
    const projectId   = ctx?.execution?.projectId || null;
    const executionId = ctx?.execution?.id || null;
    const nodeName    = ctx?.node?.name || null;

    // Synthesise an `actor` blob the auditLog helper recognises.
    // We carry the originating user/sa id when the execution context
    // exposes it, so admins can still trace WHO triggered the run.
    // The actor_kind sits firmly at 'workflow' though — the action
    // itself was taken by the DAG, not the human who pressed Run.
    const actor = {
      id:         ctx?.actor?.userId || ctx?.execution?.triggeredByUserId || null,
      email:      ctx?.actor?.email  || null,
      role:       ctx?.actor?.role   || null,
      workspaceId,
      kind:       "workflow",
    };

    // The auditLog helper already writes through a try/catch and
    // never throws — even if the audit table is unreachable we want
    // the workflow to keep moving. The return value of auditLog is
    // void on success; on failure it logs a warning.
    const meta = (input.metadata && typeof input.metadata === "object")
      ? input.metadata : {};
    // Stash the execution context inside metadata so the audit page
    // can link back to the run that recorded the row.
    const enriched = {
      ...meta,
      __source: "workflow",
      __executionId: executionId,
      __node: nodeName,
    };

    await auditLog({
      action:     input.action,
      resource:   input.resource || null,
      outcome:    input.outcome  || "success",
      metadata:   enriched,
      workspaceId,
      projectId,
      actor,
    });

    return { recorded: true, action: input.action };
  },
};
