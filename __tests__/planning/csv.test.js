const test = require("node:test");
const assert = require("node:assert/strict");
const { toCsv, safeFileName, cell } = require("../../services/planning/csv");

test("cells with commas, quotes or line breaks are quoted, and quotes are doubled", () => {
  assert.equal(cell("plain"), "plain");
  assert.equal(cell("a,b"), '"a,b"');
  assert.equal(cell('say "hi"'), '"say ""hi"""');
  assert.equal(cell("two\nlines"), '"two\nlines"');
  assert.equal(cell(null), "");
  assert.equal(cell(undefined), "");
});

test("text that a spreadsheet would run as a formula is guarded; numbers keep their sign", () => {
  assert.equal(cell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(cell("+91 98765"), "'+91 98765");
  assert.equal(cell("-cmd"), "'-cmd");
  assert.equal(cell("@user"), "'@user");
  assert.equal(cell("\t=x"), "'\t=x");
  assert.equal(cell(-5), "-5", "a negative number is not text");
  assert.equal(cell(12.5), "12.5");
  assert.equal(cell("=1,2"), '"\'=1,2"', "a guarded cell is still quoted when it needs it");
});

test("a table is a header row and one line per row, separated by CRLF", () => {
  const csv = toCsv([{ header: "Serial", value: (r) => r.serial }, { header: "Note", value: (r) => r.note }, { header: "Seconds", value: (r) => r.s }], [{ serial: "A1", note: "ok, fine", s: 3 }, { serial: "=A2", note: "", s: null }]);
  assert.equal(csv, 'Serial,Note,Seconds\r\nA1,"ok, fine",3\r\n\'=A2,,');
  assert.equal(toCsv([{ header: "X", value: () => 1 }], []), "X");
});

test("file names contain only safe characters", () => {
  assert.equal(safeFileName(["GB429 JIONET A+B", "Visual Inspection", "pass", "2026-10-07"]), "GB429_JIONET_A_B-Visual_Inspection-pass-2026-10-07.csv");
  assert.equal(safeFileName(['../../etc/passwd"', ""]), "etc_passwd.csv");
  assert.ok(!/[\\/:"]/.test(safeFileName(['../../etc/passwd"'])));
  assert.equal(safeFileName([]), "export.csv");
  assert.ok(safeFileName(["x".repeat(500)]).length <= 124);
});
