// user — pause the workflow until a human (or external system) responds.
//
// When this node runs, it returns the WAITING sentinel. The executor
// recognises it, marks the node WAITING, and stops scheduling its
// descendants. Other parallel branches keep running. The execution as
// a whole ends with status='waiting'.
//
// To resume, POST to:
//
//     POST /executions/<executionId>/nodes/<nodeName>/respond
//     Content-Type: application/json
//     <body>
//
// The body is captured verbatim as the node's output. Setting
// `outputVar` on the node, or mapping `data → <var>` in the Outputs
// panel, exposes the response to downstream nodes via ${var}.
//
// The InstanceViewer also shows a JSON form per waiting node so an
// operator can submit the response directly from the UI.

import { WAITING_MARKER } from "../../engine/executor.js";

export default {
  name: "user",
  category: "engine",
  description:
    "Pauses the workflow until someone POSTs JSON to " +
    "/executions/<execId>/nodes/<nodeName>/respond. The posted JSON " +
    "becomes this node's output. Use it for human-in-the-loop approvals, " +
    "callbacks, or any step that needs an external decision.",

  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        title: "Prompt",
        format: "textarea",
        description:
          "Optional message shown alongside the JSON form in the " +
          "InstanceViewer's 'Awaiting response' panel. Markdown is fine.",
      },
      // Free-form hint to the responder about the JSON shape they should
      // post. We don't validate against this — it's documentation.
      schema: {
        type: "object",
        title: "Expected response shape (docs only)",
        description:
          "Optional JSON object that documents the response shape. Surfaced " +
          "in the InstanceViewer alongside the form. Not validated.",
      },
    },
  },

  // The user's posted JSON is captured under `data`. Configure the
  // node's outputVar (or Outputs panel's `data → <var>` mapping) to
  // expose it to downstream nodes.
  primaryOutput: "data",

  outputSchema: {
    type: "object",
    properties: {
      data:        {                 description: "The JSON the responder posted." },
      respondedAt: { type: "string", description: "ISO timestamp of the response." },
    },
  },

  async execute(input /*, ctx */) {
    return {
      [WAITING_MARKER]: true,
      prompt: input.prompt || "",
      schema: input.schema || null,
    };
  },
};
