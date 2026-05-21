// sql.update — run a parameterised UPDATE against a stored database config.
//
// Inputs:
//   config: name of a stored `database` configuration (built from the
//           Home page → Configurations).
//   sql:    the UPDATE text. Use $1, $2, … for placeholders. Add a
//           `RETURNING` clause if you need rows back.
//   params: optional ${var} reference to an array supplying the values.

import {
  resolveConfigConnString,
  runQuery,
  sqlInputSchema,
  sqlOutputSchema,
  normalizeParams,
} from "../sql/util.js";

export default {
  name: "sql.update",
  category: "enterprise",
  description:
    "Run a parameterised UPDATE against a stored database configuration. " +
    "Always include a WHERE clause unless you really mean to update every row.",

  inputSchema: sqlInputSchema({
    sqlPlaceholder: "UPDATE users SET email = $1 WHERE id = $2",
    sqlDescription:
      "UPDATE statement. Use $1, $2, … for parameter placeholders; the " +
      "first values typically populate the SET list, the rest the WHERE.",
  }),

  primaryOutput: "rows",
  outputSchema:  sqlOutputSchema,

  async execute(input, ctx) {
    const cs = resolveConfigConnString(ctx, input.config);
    const params = normalizeParams(input.params);
    return runQuery(cs, input.sql, params);
  },
};
