// csv.stringify — render a 2D array as a CSV string. Pure in-memory:
// no filesystem write. Replaces the deprecated `csv.write` which took
// a file path.
//
// Typical wiring in cloud workflows:
//   - upstream node builds a 2D array (transform / sql.select rows)
//   - csv.stringify renders it
//   - object.store.write uploads `content` to S3/GCS/Azure
//
// First row = headers, remaining rows = data — same convention as
// csv.write so workflows migrating off the deprecated plugin only
// need to swap the action name + take the path off.

import { stringify } from "csv-stringify/sync";

export default {
  name: "csv.stringify",
  category: "enterprise",
  description:
    "Render a 2D array as a CSV string. First row = headers, rest = " +
    "rows. The rendered text is returned as `content` — pipe it into " +
    "object.store.write or any other sink. Pass `data` as a ${var} " +
    "reference to a 2D array built upstream.",

  inputSchema: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        title: "Data",
        placeholder: "${matrix}",
        description:
          "Reference to a 2D array (use ${var}). First row = headers, " +
          "rest = rows. Build the array upstream with a transform node " +
          "or sql.select.",
      },
      delimiter: { type: "string", title: "Delimiter", default: "," },
    },
  },

  primaryOutput: "content",

  outputSchema: {
    type: "object",
    required: ["content", "rowCount"],
    properties: {
      content:  { type: "string" },
      rowCount: { type: "integer" },
    },
  },

  async execute({ data, delimiter = "," }) {
    // Defensive: a literal JSON string (or an array of stringified
    // rows from the old plugin) is normalised to a real 2D array.
    data = parseIfJsonString(data);
    if (Array.isArray(data)) {
      data = data.map(row => typeof row === "string" ? parseIfJsonString(row) : row);
    }

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(
        "csv.stringify: data must resolve to a non-empty 2D array. " +
        "Pass `${var}` referencing a 2D array (e.g. produced by transform).",
      );
    }
    const [headers, ...rows] = data;
    if (!Array.isArray(headers)) {
      throw new Error("csv.stringify: first row of data must be an array of column names");
    }
    if (rows.some(r => !Array.isArray(r))) {
      throw new Error("csv.stringify: every data row must be an array — got a non-array row");
    }

    const content = stringify(rows, {
      header:  true,
      columns: headers,
      delimiter,
    });
    return { content, rowCount: rows.length };
  },
};

/** Parse a JSON-shaped string; otherwise return the value unchanged. */
function parseIfJsonString(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("[") || t.startsWith("{"))) return v;
  try { return JSON.parse(t); }
  catch { return v; }
}
