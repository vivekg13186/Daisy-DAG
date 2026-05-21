// sql.insert — run a parameterised INSERT against a stored database config.
//
// Inputs:
//   config: name of a stored `database` configuration (built from the
//           Home page → Configurations).
//   sql:    the INSERT text. Use $1, $2, … for placeholders. Add a
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
  name: "sql.insert",
  category: "enterprise",
  description:
    "Run a parameterised INSERT against a stored database configuration. " +
    "Use a RETURNING clause to get the new row(s) back.",

  inputSchema: sqlInputSchema({
    sqlPlaceholder: "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
    sqlDescription:
      "INSERT statement. Use $1, $2, … for parameter placeholders; add " +
      "RETURNING <cols> if you need the inserted rows.",
  }),

  primaryOutput: "rows",
  outputSchema:  sqlOutputSchema,

  async execute(input, ctx) {
    const cs = resolveConfigConnString(ctx, input.config);
    const params = normalizeParams(input.params);
    return runQuery(cs, input.sql, params);
  },
};
