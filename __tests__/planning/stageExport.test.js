const test = require("node:test");
const assert = require("node:assert/strict");
const { devicesCsv, historyCsv, plantTime } = require("../../services/planning/stageExport");

test("times are written in the plant's time zone", () => {
  assert.equal(plantTime("2026-10-07T03:45:00.000Z"), "2026-10-07 09:15:00");
  assert.equal(plantTime(null), "");
  assert.equal(plantTime("not a date"), "");
});

test("a device export has one row per device, with text guarded and times in plant time", () => {
  const rows = [
    { serialNo: "TR-1", seatKey: "0-0", status: "Pass", at: "2026-10-07T03:45:00.000Z", durationMs: 61000, attemptNumber: 2, reason: "", nextStage: "Functional", assignedTo: "", operator: { name: "Asha Rao", employeeCode: "E1" } },
    { serialNo: "=cmd|' /C calc'!A0", seatKey: "0-1", status: "NG", at: null, durationMs: null, attemptNumber: 1, reason: "scratch, left side", nextStage: "", assignedTo: "QC", operator: { name: "", employeeCode: "" } },
  ];
  const lines = devicesCsv("pass", rows).split("\r\n");
  assert.equal(lines[0], "Serial,Seat,Operator,Employee code,Result,When,Test time (seconds),Attempt,Reason,Next stage,Assigned to");
  assert.equal(lines[1], "TR-1,0-0,Asha Rao,E1,Pass,2026-10-07 09:15:00,61,2,,Functional,");
  assert.ok(lines[2].startsWith("'=cmd"), "a serial that looks like a formula is guarded");
  assert.ok(lines[2].includes('"scratch, left side"'));
  assert.equal(lines.length, 3);
});

test("a WIP export says why each device is there", () => {
  const csv = devicesCsv("wip", [{ serialNo: "TR-9", seatKey: "0-0", source: "passed_previous", since: "2026-10-07T03:45:00.000Z", fromStage: "Visual Inspection", operator: { name: "Bala K" } }]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Serial,Seat,Why it is here,Since,From stage,Operator");
  assert.equal(lines[1], "TR-9,0-0,Passed the previous stage,2026-10-07 09:15:00,Visual Inspection,Bala K");
});

test("a history export has the attempt, the retry reason and the outcome", () => {
  const csv = historyCsv([{ at: "2026-10-07T03:45:00.000Z", serialNo: "TR-2", seatKey: "0-0", status: "Pass", outcome: "pass", attempt: 2, attemptsOnDevice: 2, durationMs: 4000, reason: "", reattemptReason: "reworked", nextStage: "", assignedTo: "", operator: { name: "Asha Rao", employeeCode: "E1" } }]);
  const lines = csv.split("\r\n");
  assert.ok(lines[0].startsWith("When,Serial,Seat,Operator,Employee code,Result,Outcome,Attempt,Attempts on this device,Test time (seconds),Reason,Retry reason"));
  assert.equal(lines[1], "2026-10-07 09:15:00,TR-2,0-0,Asha Rao,E1,Pass,pass,2,2,4,,reworked,,");
});
