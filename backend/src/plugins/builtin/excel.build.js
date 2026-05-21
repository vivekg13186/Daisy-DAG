// excel.build — render a 2D array as an .xlsx workbook in memory.
// Pure in-memory: no filesystem. Replaces the deprecated `excel.write`
// which took a file path.
//
// Output `content` is base64-encoded bytes — the .xlsx format is a
// zip container so it can't be returned as a utf-8 string. Pipe
// the base64 straight into object.store.write (encoding=base64)
// to upload to S3/GCS/Azure.
//
// First row = headers (rendered bold), remaining rows = data —
// same convention as excel.write.

import ExcelJS from "exceljs";

export default {
  name: "excel.build",
  category: "enterprise",
  description:
    "Render a 2D array as an .xlsx workbook. First row = headers " +
    "(rendered bold), rest = rows. Returns `content` as base64 — " +
    "pipe to object.store.write (encoding=base64) to upload. Pass " +
    "`data` as a ${var} reference to a 2D array built upstream.",

  inputSchema: {
    type: "object",
    required: ["data"],
    properties: {
      sheet: {
        type: "string",
        title: "Sheet name",
        default: "Sheet1",
      },
      data: {
        title: "Data",
        placeholder: "${matrix}",
        description:
          "Reference to a 2D array (use ${var}). First row = headers, " +
          "rest = rows. Build the array upstream with a transform node " +
          "or sql.select.",
      },
    },
  },

  primaryOutput: "content",

  outputSchema: {
    type: "object",
    required: ["content", "rowCount"],
    properties: {
      content:  { type: "string", description: "Base64-encoded .xlsx bytes" },
      sheet:    { type: "string" },
      rowCount: { type: "integer" },
    },
  },

  async execute({ sheet = "Sheet1", data }) {
    data = parseIfJsonString(data);
    if (Array.isArray(data)) {
      data = data.map(row => typeof row === "string" ? parseIfJsonString(row) : row);
    }

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(
        "excel.build: data must resolve to a non-empty 2D array. " +
        "Pass `${var}` referencing a 2D array (e.g. produced by transform).",
      );
    }
    const [headers, ...rows] = data;
    if (!Array.isArray(headers)) {
      throw new Error("excel.build: first row of data must be an array of column names");
    }
    if (rows.some(r => !Array.isArray(r))) {
      throw new Error("excel.build: every data row must be an array — got a non-array row");
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet);
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(r);

    // writeBuffer returns a Buffer (Node) — base64 it so the output
    // is JSON-friendly and easy to hand off to object.store.write.
    const buf = await wb.xlsx.writeBuffer();
    const content = Buffer.from(buf).toString("base64");
    return { content, sheet, rowCount: rows.length };
  },
};

function parseIfJsonString(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("[") || t.startsWith("{"))) return v;
  try { return JSON.parse(t); }
  catch { return v; }
}
