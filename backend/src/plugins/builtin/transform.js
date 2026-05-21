// Transform: evaluate a FEEL expression and return its result.
//
// Wire the result to a downstream variable through the node's standard
// Outputs mapping (`value → <var name>`) — the per-plugin outputVar input
// has been retired so output binding is consistent with every other plugin.
//
// The expression is evaluated as raw FEEL against the runtime context.
// Type FEEL directly (no `${…}` wrapping). If somebody does wrap it in
// `${…}`, the engine pre-evaluates that (potentially producing a non-string)
// and we use that value verbatim instead of double-evaluating.

import { evaluate as feelEvaluate } from "feelin";
import { FEEL_HELPERS } from "../../dsl/expression.js";

export default {
  name: "transform",
  category: "engine",
  description:
    "Evaluates a FEEL expression and returns it as `value`. " +
    "Bind it to a ctx variable via the Outputs panel (value → <var name>).",

  inputSchema: {
    type: "object",
    required: ["expression"],
    properties: {
      expression: {
        type: "string",
        // The property panel renders strings tagged textarea as multi-line.
        format: "textarea",
        title: "Expression",
        description:
          "FEEL expression evaluated against the runtime context. " +
          "Examples: user.firstName + \" \" + user.lastName · " +
          "[for o in orders return o.total] · " +
          "if x > 0 then \"positive\" else \"non-positive\"",
      },
    },
  },

  // What gets written to ctx when the node-level outputVar is set
  // (advanced; only reachable from the JSON tab today).
  primaryOutput: "value",

  outputSchema: {
    type: "object",
    properties: { value: {} },
  },

  async execute({ expression }, ctx) {
    if (typeof expression === "string") {
      try {
        // Splice the same FEEL helpers the rest of the engine uses into
        // scope so transform expressions can call parseJson()/toJson()/
        // toJsonPretty() — without this they're unknown identifiers and
        // feelin silently returns null.
        return { value: feelEvaluate(expression, { ...FEEL_HELPERS, ...ctx }) };
      } catch (e) {
        throw new Error(`transform: failed to evaluate FEEL expression — ${e.message}`);
      }
    }
    // The engine already produced a non-string value (user wrapped the
    // input in `${…}` or supplied an object literal). Pass it through.
    return { value: expression };
  },
};
