// sql.select — run a parameterised SELECT against a stored database config.
//
// Inputs:
//   config: name of a stored `database` configuration (built from the
//           Home page → Configurations).
//   sql:    the SQL text. Use $1, $2, … for placeholders.
//   params: optional ${var} reference to an array supplying the values
//           for those placeholders.

import {
  resolveConfigConnString,
  runQuery,
  sqlInputSchema,
  sqlOutputSchema,
  normalizeParams,
} from "../sql/util.js";

export default {
  name: "sql.select",
  category: "enterprise",
  description:
    "Run a parameterised SELECT against a stored database configuration. " +
    "The `config` input names the configuration; `sql` is the query text " +
    "with $1/$2/… placeholders; `params` resolves to an array of values.",

  inputSchema: sqlInputSchema({
    sqlPlaceholder: "SELECT * FROM users WHERE id = $1",
    sqlDescription: "SELECT statement. Use $1, $2, … for parameter placeholders.",
  }),

  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "rows",

  outputSchema: sqlOutputSchema,

  async execute(input, ctx) {
    const cs = resolveConfigConnString(ctx, input.config);
    const params = normalizeParams(input.params);
    return runQuery(cs, input.sql, params);
  },
};
