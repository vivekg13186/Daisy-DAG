// sql.execute — run any parameterised SQL against a stored database config.
//
// The general-purpose escape hatch for SQL that doesn't fit the
// SELECT/INSERT/UPDATE/DELETE pigeonholes — stored procedures (CALL …),
// table-returning functions (SELECT * FROM fn(…)), DDL, multi-statement
// blocks, etc.
//
// Inputs:
//   config: name of a stored `database` configuration (built from the
//           Home page → Configurations).
//   sql:    the SQL text. Use $1, $2, … for placeholders.
//   params: optional ${var} reference to an array supplying the values.

import {
  resolveConfigConnString,
  runQuery,
  sqlInputSchema,
  sqlOutputSchema,
  normalizeParams,
} from "../sql/util.js";

export default {
  name: "sql.execute",
  category: "enterprise",
  description:
    "Run any parameterised SQL statement against a stored database " +
    "configuration — handy for CALL stored_proc(…), SELECT * FROM fn(…), " +
    "DDL, or anything that doesn't fit the dedicated select/insert/update/" +
    "delete plugins.",

  inputSchema: sqlInputSchema({
    sqlPlaceholder: "CALL my_proc($1, $2)",
    sqlDescription:
      "Any SQL statement. Use $1, $2, … for parameter placeholders.",
  }),

  primaryOutput: "rows",
  outputSchema:  sqlOutputSchema,

  async execute(input, ctx) {
    const cs = resolveConfigConnString(ctx, input.config);
    const params = normalizeParams(input.params);
    return runQuery(cs, input.sql, params);
  },
};
