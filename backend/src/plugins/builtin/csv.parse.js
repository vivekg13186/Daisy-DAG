// csv.parse — turn a CSV string into rows. Pure in-memory: no
// filesystem, no network. Replaces the deprecated `csv.read` which
// took a file path.
//
// Typical wiring in cloud workflows:
//   - object.store.read fetches the .csv from S3/GCS/Azure
//   - csv.parse turns the body into rows
//   - downstream nodes (sql.insert / agent / rag.ingest) consume them
//
// `content` can be either a UTF-8 string (the common case after an
// object-store read) or a base64-encoded buffer. Set
// `encoding: "base64"` for the latter — the plugin decodes to a
// utf-8 string before parsing.
//
// Why a fresh name instead of evolving csv.read in place: the input
// contract changes (path → content). Workflows that still reference
// the old plugin keep working until the deprecation window closes.

import { parse } from "csv-parse/sync";
import { Buffer } from "node:buffer";

export default {
  name: "csv.parse",
  category: "enterprise",
  description:
    "Parse a CSV string (or base64-encoded bytes) into rows. With " +
    "headers:true (default) returns array of objects keyed by header; " +
    "otherwise array of arrays. Wire `rows` to a downstream variable " +
    "through the Outputs panel (rows → <var name>). Pure in-memory — " +
    "fetch the file upstream with object.store.read or http.request.",

  inputSchema: {
    type: "object",
    required: ["content"],
    properties: {
      content: {
        type: "string",
        format: "textarea",
        title: "CSV content",
        description:
          "Inline CSV text, or base64-encoded CSV bytes (set encoding=base64). " +
          "Usually a ${var} reference to an upstream node's output (e.g. " +
          "${doc} from an object.store.read).",
      },
      encoding: {
        type: "string",
        enum: ["utf8", "utf-8", "base64"],
        default: "utf8",
        title: "Encoding",
        description:
          "Encoding of `content`. Use base64 when the upstream node " +
          "returned binary bytes (e.g. object.store.read with " +
          "encoding=binary).",
      },
      delimiter: { type: "string",  title: "Delimiter",  default: "," },
      headers:   { type: "boolean", title: "Has header row", default: true },
      skipEmpty: { type: "boolean", title: "Skip empty lines", default: true },
      cast:      { type: "boolean", title: "Cast values to native types", default: true },
    },
  },

  primaryOutput: "rows",

  outputSchema: {
    type: "object",
    required: ["rows", "rowCount"],
    properties: {
      rows:     { type: "array" },
      rowCount: { type: "integer" },
      columns:  { type: "array", items: { type: "string" } },
    },
  },

  async execute({ content, encoding = "utf8", delimiter = ",", headers = true, skipEmpty = true, cast = true }) {
    if (content == null) throw new Error("csv.parse: `content` is required");
    const text = encoding === "base64"
      ? Buffer.from(String(content), "base64").toString("utf8")
      : String(content);
    const rows = parse(text, {
      delimiter,
      columns:           headers,             // true → first row as keys → emits objects
      skip_empty_lines:  skipEmpty,
      trim:              true,
      cast,
      cast_date:         false,
      relax_quotes:      true,
    });
    const columns = headers && rows.length
      ? Object.keys(rows[0])
      : (Array.isArray(rows[0]) ? rows[0].map((_, i) => `col${i+1}`) : []);
    return { rows, rowCount: rows.length, columns };
  },
};
