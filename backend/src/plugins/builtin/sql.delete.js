// sql.delete — run a parameterised DELETE against a stored database config.
//
// Inputs:
//   config: name of a stored `database` configuration (built from the
//           Home page → Configurations).
//   sql:    the DELETE text. Use $1, $2, … for placeholders. Always
//           include a WHERE clause unless you really mean to wipe the
//           table.
//   params: optional ${var} reference to an array supplying the values.

import {
  resolveConfigConnString,
  runQuery,
  sqlInputSchema,
  sqlOutputSchema,
  normalizeParams,
} from "../sql/util.js";

export default {
  name: "sql.delete",
  category: "enterprise",
  description:
    "Run a parameterised DELETE against a stored database configuration. " +
    "Always include a WHERE clause — there's no safety net here.",

  inputSchema: sqlInputSchema({
    sqlPlaceholder: "DELETE FROM users WHERE id = $1",
    sqlDescription: "DELETE statement. Use $1, $2, … for parameter placeholders.",
  }),

  primaryOutput: "rows",
  outputSchema:  sqlOutputSchema,

  async execute(input, ctx) {
    const cs = resolveConfigConnString(ctx, input.config);
    const params = normalizeParams(input.params);
    return runQuery(cs, input.sql, params);
  },
};
