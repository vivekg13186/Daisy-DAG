// excel.parse — read an .xlsx workbook from in-memory bytes. Pure
// in-memory: no filesystem. Replaces the deprecated `excel.read`
// which took a file path.
//
// .xlsx is a zip of XML files (binary container) — so `content`
// must be base64-encoded bytes. Upstream nodes that produce xlsx
// content (object.store.read with encoding=binary, http.request
// fetching a .xlsx URL) emit base64; downstream parsing here
// just decodes once and hands ExcelJS the buffer.
//
// Output mirrors excel.read:
//   - allSheets:false → { sheet, columns, rows, rowCount }
//   - allSheets:true  → { sheets: [{ sheet, columns, rows, rowCount }, ...] }

import ExcelJS from "exceljs";
import { Buffer } from "node:buffer";

export default {
  name: "excel.parse",
  category: "enterprise",
  description:
    "Read an .xlsx workbook from base64-encoded bytes. With headers:true " +
    "(default) returns array of objects keyed by the first row. Pass " +
    "`content` from object.store.read (encoding=binary) or any other " +
    "source that produces base64. Pure in-memory — no filesystem.",

  inputSchema: {
    type: "object",
    required: ["content"],
    properties: {
      content: {
        type: "string",
        title: "Workbook bytes (base64)",
        description:
          "Base64-encoded .xlsx content. Usually a ${var} reference to " +
          "the output of object.store.read with encoding=binary.",
      },
      sheet:     { type: "string",  title: "Sheet name (default: first sheet)" },
      headers:   { type: "boolean", title: "Has header row", default: true },
      allSheets: { type: "boolean", title: "Return every sheet", default: false },
    },
  },

  primaryOutput: "rows",

  outputSchema: {
    type: "object",
    properties: {
      sheet:    { type: "string" },
      columns:  { type: "array", items: { type: "string" } },
      rows:     { type: "array" },
      rowCount: { type: "integer" },
      sheets:   { type: "array" },    // when allSheets:true
    },
  },

  async execute({ content, sheet, headers = true, allSheets = false }) {
    if (!content) throw new Error("excel.parse: `content` (base64) is required");
    const buf = Buffer.from(String(content), "base64");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    if (allSheets) {
      const sheets = wb.worksheets.map(ws => extractSheet(ws, headers));
      return { sheets };
    }
    const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0];
    if (!ws) throw new Error(`excel.parse: sheet "${sheet}" not found`);
    return extractSheet(ws, headers);
  },
};

function extractSheet(ws, headers) {
  const all = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-indexed and has a leading undefined; slice it off.
    all.push(row.values.slice(1).map(cellValue));
  });

  if (headers && all.length) {
    const cols = all[0].map(v => v == null ? "" : String(v));
    const rows = all.slice(1).map(arr => {
      const o = {};
      cols.forEach((c, i) => { o[c || `col${i+1}`] = arr[i] ?? null; });
      return o;
    });
    return { sheet: ws.name, columns: cols, rows, rowCount: rows.length };
  }
  return { sheet: ws.name, columns: [], rows: all, rowCount: all.length };
}

// ExcelJS returns rich cell objects for hyperlinks / formulas / dates.
function cellValue(v) {
  if (v == null) return null;
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString();
    if ("text" in v) return v.text;                 // hyperlink / rich text
    if ("result" in v) return v.result;             // formula
    if ("richText" in v) return v.richText.map(r => r.text).join("");
  }
  return v;
}
