// CSV for the stage exports. PURE.
//
// Cells can hold text typed by people (a serial, a failure reason). A spreadsheet treats a cell that starts with = + - @ (or a tab or
// carriage return) as a formula, so such a cell is prefixed with an apostrophe-free guard: a leading single quote is the common
// convention and is shown by Excel and Sheets as plain text.

const FORMULA_START = /^[=+\-@\t\r]/;

const cell = (value) => {
  if (value === null || value === undefined) return "";
  let text = typeof value === "number" || typeof value === "boolean" ? String(value) : String(value);
  // numbers keep their sign: only text is guarded
  if (typeof value !== "number" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** columns: [{ header, value: (row) => any }]  ->  text with CRLF line ends (what spreadsheets expect) */
const toCsv = (columns, rows) => [columns.map((c) => cell(c.header)).join(","), ...rows.map((r) => columns.map((c) => cell(c.value(r))).join(","))].join("\r\n");

// a name that is safe in a download header
const safeFileName = (parts, ext = "csv") => {
  const base = parts
    .filter(Boolean)
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|_+$/g, "") // no leading dots, so a name can never look like a path or a hidden file
    .slice(0, 120);
  return `${base || "export"}.${ext}`;
};

module.exports = { toCsv, safeFileName, cell };
