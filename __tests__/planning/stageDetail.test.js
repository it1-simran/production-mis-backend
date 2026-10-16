const test = require("node:test");
const assert = require("node:assert/strict");
const svc = require("../../services/planInsightsService");
const { analyzeStage, wipDevicesAt, stageHistory, prepare } = require("../../services/planning/stageDetail");

const STAGES = [{ stageName: "Visual Inspection" }, { stageName: "Functional" }];
const COMMON = [{ stageName: "PDI" }, { stageName: "FG to Store" }];
const LOOKUP = svc.buildStageAliasLookup({ processStages: STAGES, commonStages: COMMON });
const NAMES = new Map([["op1", { name: "Asha Rao", employeeCode: "E1" }], ["op2", { name: "Bala K", employeeCode: "E2" }]]);

let seq = 0;
// all on 2026-10-07 (plant time) unless a day is given; newest first is arranged by the helper below
const rec = (deviceId, stageName, status, minute, extra = {}) => ({
  _id: `r${++seq}`,
  deviceId,
  serialNo: `S-${deviceId}`,
  operatorId: "op1",
  stageName,
  status,
  seatNumber: "0-0",
  flowVersion: 1,
  attemptNumber: 1,
  testDurationMs: 60000,
  createdAt: new Date(Date.UTC(2026, 9, extra.day || 7, 6, minute, 0)), // 11:30 + minute in IST
  ...extra,
});
const newestFirst = (list) => list.slice().sort((a, b) => b.createdAt - a.createdAt);
const dev = (id, extra = {}) => ({ _id: id, serialNo: `S-${id}`, status: "", currentStage: "", flowVersion: 1, ...extra });

const RECORDS = newestFirst([
  rec("A", "Visual Inspection", "NG", 0, { attemptNumber: 1, ngDescription: "scratch" }),
  rec("A", "Visual Inspection", "Pass", 5, { attemptNumber: 2, operatorId: "op2", reattemptReason: "reworked" }),
  rec("B", "Visual Inspection", "Pass", 1, { nextLogicalStage: "Functional" }),
  rec("C", "Visual Inspection", "NG", 2),
  rec("D", "Visual Inspection", "Pass", 3, { nextLogicalStage: "Functional" }),
  rec("D", "Functional", "Pass", 9),
  rec("E", "Visual Inspection", "NG", 4),
  rec("E", "QC", "Resolved", 8, { assignedDeviceTo: "Visual Inspection" }),
]);
const DEVICES = [dev("A"), dev("B"), dev("C"), dev("D"), dev("E")];
const analyze = (over = {}) => analyzeStage({ records: RECORDS, devices: DEVICES, aliasLookup: LOOKUP, stage: "Visual Inspection", names: NAMES, ...over });

test("a stage's result is each device's latest record there; a retry replaces the earlier attempt", () => {
  const a = analyze();
  assert.equal(a.counts.pass, 3, "A (after a retry), B and D");
  assert.equal(a.counts.ng, 1, "C; E is not counted because it was resolved back to this stage");
  assert.equal(a.counts.devices, 5);
  assert.equal(a.counts.attempts, 6);
});

test("first-pass yield and retry figures", () => {
  const a = analyze();
  assert.equal(a.firstPassYield, 40, "B and D passed first time, of 5 devices");
  assert.deepEqual([a.retry.devices, a.retry.attempts, a.retry.percent, a.retry.passedAfterRetry], [1, 1, 20, 100]);
  assert.equal(a.durations.avgMs, 60000);
});

test("operators are every operator who tested, with their own attempts, not only the current assignee", () => {
  const a = analyze();
  const asha = a.byOperator.find((o) => o.id === "op1");
  const bala = a.byOperator.find((o) => o.id === "op2");
  assert.deepEqual([asha.name, asha.attempts, asha.pass, asha.ng], ["Asha Rao", 5, 2, 3]);
  assert.deepEqual([bala.name, bala.attempts, bala.pass, bala.ng], ["Bala K", 1, 1, 0]);
  assert.ok(asha.firstAt && asha.lastAt);
});

test("seats count final results", () => {
  const a = analyze();
  assert.deepEqual(a.bySeat, [{ seatKey: "0-0", pass: 3, ng: 1 }]);
});

test("a date range keeps only that day's records", () => {
  assert.equal(analyze({ from: "2026-10-08", to: "2026-10-08" }).counts.devices, 0);
  assert.equal(analyze({ from: "2026-10-07", to: "2026-10-07" }).counts.pass, 3);
  const later = newestFirst([...RECORDS, rec("Z", "Visual Inspection", "Pass", 0, { day: 9 })]);
  const a = analyzeStage({ records: later, devices: [...DEVICES, dev("Z")], aliasLookup: LOOKUP, stage: "Visual Inspection", from: "2026-10-09", to: "2026-10-09", names: NAMES });
  assert.equal(a.counts.pass, 1);
});

test("records from an older flow version of a device are ignored", () => {
  const stale = newestFirst([...RECORDS, rec("F", "Visual Inspection", "Pass", 6, { flowVersion: 1 })]);
  const a = analyzeStage({ records: stale, devices: [...DEVICES, dev("F", { flowVersion: 2 })], aliasLookup: LOOKUP, stage: "Visual Inspection", names: NAMES });
  assert.equal(a.counts.pass, 3, "F's record belongs to flow version 1 but the device is on 2");
});

test("pass, NG and resolved are bucketed from the same rules", () => {
  const a = analyze();
  const serials = (b) => a._finals.buckets[b].map((p) => p.r.serialNo).sort();
  assert.deepEqual(serials("pass"), ["S-A", "S-B", "S-D"]);
  assert.deepEqual(serials("ng"), ["S-C"]);
  assert.deepEqual(serials("returned"), ["S-E"]);
});

test("WIP: resolved back to the stage, passed the previous stage and not yet tested here, and untested devices up to the kits on the line", () => {
  const all = prepare(RECORDS, LOOKUP);
  const vi = wipDevicesAt({ all, devices: DEVICES, aliasLookup: LOOKUP, stage: "Visual Inspection", firstStage: "Visual Inspection", processStatus: "active", lineAllocated: 0, consumed: 0 });
  assert.deepEqual(vi.rows.map((r) => [r.serialNo, r.source]), [["S-E", "resolved"]]);
  const fn = wipDevicesAt({ all, devices: DEVICES, aliasLookup: LOOKUP, stage: "Functional", firstStage: "Visual Inspection", processStatus: "active", lineAllocated: 0, consumed: 0 });
  assert.deepEqual(fn.rows.map((r) => [r.serialNo, r.source]), [["S-B", "passed_previous"]], "D already has a Functional record, B has not");
});

test("untested devices count as WIP only after the kits are confirmed, and only up to the kits on the line, in the engine's order", () => {
  const untested = [dev("U1"), dev("U2"), dev("U3", { currentStage: "Functional" }), dev("U4")];
  const all = prepare(RECORDS, LOOKUP);
  const at = (processStatus, lineAllocated, consumed, stage) => wipDevicesAt({ all, devices: [...DEVICES, ...untested], aliasLookup: LOOKUP, stage, firstStage: "Visual Inspection", processStatus, lineAllocated, consumed });
  assert.equal(at("Waiting_Kits_allocation", 100, 0, "Visual Inspection").rows.filter((r) => r.source === "untested").length, 0, "before confirmation nothing is WIP");
  assert.deepEqual(at("active", 3, 0, "Visual Inspection").rows.filter((r) => r.source === "untested").map((r) => r.serialNo), ["S-U1", "S-U2"], "capacity 3 is used by U1, U2 and U3, and U3 sits at Functional");
  assert.deepEqual(at("active", 3, 0, "Functional").rows.filter((r) => r.source === "untested").map((r) => r.serialNo), ["S-U3"]);
  assert.equal(at("active", 3, 2, "Visual Inspection").rows.filter((r) => r.source === "untested").length, 1, "consumed kits reduce the capacity");
});

test("what the engine adds without a device is reported as unlisted", () => {
  const all = prepare(RECORDS, LOOKUP);
  const r = wipDevicesAt({ all, devices: DEVICES, aliasLookup: LOOKUP, stage: "Visual Inspection", firstStage: "Visual Inspection", processStatus: "active", lineAllocated: 0, consumed: 0, engineWip: 4 });
  assert.deepEqual([r.listed, r.unlisted], [1, 3]);
});

test("common stages count devices by where they sit: a device further along has passed this one", () => {
  const devices = [dev("P1", { currentStage: "PDI" }), dev("P2", { currentStage: "FG to Store" }), dev("P3", { currentStage: "Dispatch" }), dev("P4", { currentStage: "PDI", status: "NG" })];
  const names = COMMON.map((c) => c.stageName);
  const pdi = analyzeStage({ records: [], devices, aliasLookup: LOOKUP, stage: "PDI", names: NAMES, commonStageNames: names });
  assert.equal(pdi.counts.pass, 2, "P2 and P3 are beyond PDI; P4 failed terminally");
  const fg = analyzeStage({ records: [], devices, aliasLookup: LOOKUP, stage: "FG to Store", names: NAMES, commonStageNames: names });
  assert.equal(fg.counts.pass, 1, "P3 only");
  const wip = wipDevicesAt({ all: [], devices, aliasLookup: LOOKUP, stage: "PDI", firstStage: "Visual Inspection", processStatus: "active", lineAllocated: 0, consumed: 0, commonStageNames: names });
  assert.deepEqual(wip.rows.map((r) => [r.serialNo, r.source]), [["S-P1", "at_stage"]]);
});

test("history is newest first with attempt numbers, filters and cursor paging that never repeats or skips", () => {
  const h = stageHistory({ records: RECORDS, devices: DEVICES, aliasLookup: LOOKUP, stage: "Visual Inspection", names: NAMES, limit: 4 });
  assert.equal(h.total, 6);
  assert.equal(h.rows.length, 4);
  assert.ok(h.nextCursor);
  const second = stageHistory({ records: RECORDS, devices: DEVICES, aliasLookup: LOOKUP, stage: "Visual Inspection", names: NAMES, limit: 4, cursor: h.nextCursor });
  assert.equal(second.rows.length, 2);
  assert.equal(second.nextCursor, null);
  const ids = [...h.rows, ...second.rows].map((r) => r.id);
  assert.equal(new Set(ids).size, 6, "every record exactly once");
  const times = [...h.rows, ...second.rows].map((r) => new Date(r.at).getTime());
  assert.deepEqual(times, times.slice().sort((a, b) => b - a));
});

test("history rows carry the attempt, the reason and the operator, and filter by outcome, operator, serial and seat", () => {
  const all = stageHistory({ records: RECORDS, devices: DEVICES, aliasLookup: LOOKUP, stage: "Visual Inspection", names: NAMES, limit: 50 });
  const aRetry = all.rows.find((r) => r.serialNo === "S-A" && r.outcome === "pass");
  assert.deepEqual([aRetry.attempt, aRetry.attemptsOnDevice, aRetry.reattemptReason, aRetry.operator.name], [2, 2, "reworked", "Bala K"]);
  const aFirst = all.rows.find((r) => r.serialNo === "S-A" && r.outcome === "ng");
  assert.deepEqual([aFirst.attempt, aFirst.reason], [1, "scratch"]);
  const q = (over) => stageHistory({ records: RECORDS, devices: DEVICES, aliasLookup: LOOKUP, stage: "Visual Inspection", names: NAMES, limit: 50, ...over });
  assert.equal(q({ status: "ng" }).total, 3);
  assert.equal(q({ status: "pass" }).total, 3);
  assert.equal(q({ operator: "op2" }).total, 1);
  assert.equal(q({ serial: "s-c" }).total, 1);
  assert.equal(q({ seat: "9-9" }).total, 0);
  assert.equal(q({ from: "2026-10-08", to: "2026-10-08" }).total, 0);
});
