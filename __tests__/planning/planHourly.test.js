const test = require("node:test");
const assert = require("node:assert/strict");
const svc = require("../../services/planInsightsService");
const { buildHourly, buildBuckets } = require("../../services/planning/planHourly");
const { buildWindow } = require("../../utils/planDates");

const LOOKUP = svc.buildStageAliasLookup({ processStages: [{ stageName: "Visual Inspection" }, { stageName: "Functional" }], commonStages: [{ stageName: "PDI" }] });
const STAGES = [
  { name: "Visual Inspection", common: false, seats: 2, upha: 50 },
  { name: "Functional", common: false, seats: 1, upha: 40 },
  { name: "PDI", common: true, seats: 0, upha: 0 },
];

let seq = 0;
// plant time is Asia/Kolkata (UTC+5:30); `at(9, 15)` is 09:15 on 7 Oct 2026 there, `at(25, 0)` is 01:00 the next morning
const at = (hour, minute = 0, day = 7) => new Date(Date.UTC(2026, 9, day, hour - 5, minute - 30));
const rec = (deviceId, stageName, status, when, extra = {}) => ({ _id: `r${++seq}`, deviceId, serialNo: `S-${deviceId}`, stageName, status, flowVersion: 1, createdAt: when, ...extra });
const newestFirst = (list) => list.slice().sort((a, b) => b.createdAt - a.createdAt);
const hourly = (over = {}) =>
  buildHourly({ date: "2026-10-07", window: { startTime: "08:30", endTime: "17:30" }, breaks: [{ startTime: "13:00", endTime: "14:00" }], stages: STAGES, records: [], devices: [], aliasLookup: LOOKUP, lastStage: "Functional", ...over });

test("buckets run from the start time in hours, with an hour before and after, and breaks reduce productive minutes", () => {
  const h = hourly();
  const labels = h.buckets.map((b) => b.label);
  assert.equal(labels[0], "07:30-08:30");
  assert.equal(labels[1], "08:30-09:30");
  assert.equal(labels[labels.length - 2], "16:30-17:30");
  assert.equal(labels[labels.length - 1], "17:30-18:30");
  assert.deepEqual(h.buckets.map((b) => b.kind).filter((k, i, a) => a.indexOf(k) === i), ["before", "shift", "after"]);
  const noon = h.buckets.find((b) => b.label === "12:30-13:30");
  const after = h.buckets.find((b) => b.label === "13:30-14:30");
  assert.deepEqual([noon.productiveMinutes, noon.isBreak, after.productiveMinutes], [30, false, 30]);
});

test("a bucket that is all break is marked, and a short last hour is shorter", () => {
  const b = buildBuckets(buildWindow("09:00", "13:30"), [{ startTime: "12:00", endTime: "13:00" }]);
  const lunch = b.find((x) => x.label === "12:00-13:00");
  assert.deepEqual([lunch.isBreak, lunch.productiveMinutes], [true, 0]);
  const last = b.filter((x) => x.kind === "shift").pop();
  assert.deepEqual([last.label, last.productiveMinutes], ["13:00-13:30", 30]);
});

test("passes and NG land in the hour they were recorded; the latest result per device and stage wins", () => {
  const records = newestFirst([
    rec("A", "Visual Inspection", "NG", at(9, 0)),
    rec("A", "Visual Inspection", "Pass", at(9, 40)), // the retry replaces the NG
    rec("B", "Visual Inspection", "Pass", at(9, 10)),
    rec("C", "Visual Inspection", "NG", at(10, 5)),
    rec("D", "Functional", "Pass", at(10, 45)),
    rec("E", "Visual Inspection", "Resolved", at(11, 0)), // not output
  ]);
  const h = hourly({ records });
  const cell = (stage, label) => h.stages.find((s) => s.name === stage).cells[h.buckets.findIndex((b) => b.label === label)];
  assert.deepEqual([cell("Visual Inspection", "08:30-09:30").pass, cell("Visual Inspection", "08:30-09:30").ng], [1, 0], "B passed at 09:10; A's NG at 09:00 was replaced");
  assert.deepEqual([cell("Visual Inspection", "09:30-10:30").pass, cell("Visual Inspection", "09:30-10:30").ng], [1, 1], "A passed at 09:40, C failed at 10:05");
  assert.equal(cell("Functional", "10:30-11:30").pass, 1);
  assert.deepEqual(h.totals, { pass: 3, ng: 1 });
  assert.equal(h.stages.find((s) => s.name === "Visual Inspection").totals.pass, 2);
});

test("targets are units per hour times seats times the productive share of the hour; common stages have none", () => {
  const h = hourly();
  const vi = h.stages.find((s) => s.name === "Visual Inspection");
  assert.equal(vi.targetPerHour, 100);
  assert.equal(vi.cells[h.buckets.findIndex((b) => b.label === "08:30-09:30")].target, 100);
  assert.equal(vi.cells[h.buckets.findIndex((b) => b.label === "12:30-13:30")].target, 50, "half of that hour is break");
  assert.equal(h.stages.find((s) => s.name === "Functional").targetPerHour, 40);
  const pdi = h.stages.find((s) => s.name === "PDI");
  assert.equal(pdi.targetPerHour, null);
  assert.equal(pdi.cells[3].target, null);
  assert.equal(vi.totals.target, 800, "eight productive hours: the 9-hour day less the 1-hour break; the padding hours have no target");
  assert.equal(vi.cells[0].target, null, "the hour before the day has no target");
});

test("work outside the hours (beyond the padding) is reported, not lost", () => {
  const h = hourly({ records: newestFirst([rec("A", "Visual Inspection", "Pass", at(20, 0)), rec("B", "Visual Inspection", "Pass", at(9, 0))]) });
  const vi = h.stages.find((s) => s.name === "Visual Inspection");
  assert.deepEqual(vi.outside, { pass: 1, ng: 0 });
  assert.equal(vi.totals.pass, 2);
});

test("records from an older flow version are ignored; stages are matched by alias", () => {
  const records = newestFirst([rec("F", "Visual Inspection", "Pass", at(9, 0), { flowVersion: 1 }), rec("G", "visual_inspection", "Pass", at(9, 5))]);
  const h = hourly({ records, devices: [{ _id: "F", serialNo: "S-F", flowVersion: 2 }] });
  assert.equal(h.stages.find((s) => s.name === "Visual Inspection").totals.pass, 1, "F is on flow version 2; G's alias resolves");
});

test("the current hour is marked only when the day is today", () => {
  assert.equal(hourly({ nowMinutes: 10 * 60 + 5 }).currentBucket, hourly().buckets.findIndex((b) => b.label === "09:30-10:30"));
  assert.equal(hourly({ nowMinutes: null }).currentBucket, -1);
  assert.equal(hourly({ nowMinutes: 3 * 60 }).currentBucket, -1, "before the padding");
});

test("a night shift counts the next morning's records in the same day", () => {
  const h = buildHourly({
    date: "2026-10-07",
    window: { startTime: "21:00", endTime: "05:00" },
    breaks: [],
    stages: STAGES,
    records: newestFirst([rec("A", "Visual Inspection", "Pass", at(22, 10)), rec("B", "Visual Inspection", "Pass", at(25, 30, 7))]), // 01:30 on the 8th
    devices: [],
    aliasLookup: LOOKUP,
    lastStage: "Functional",
  });
  const labels = h.buckets.map((b) => b.label);
  assert.equal(labels[1], "21:00-22:00");
  const vi = h.stages.find((s) => s.name === "Visual Inspection");
  assert.equal(vi.cells[labels.indexOf("22:00-23:00")].pass, 1);
  assert.equal(vi.cells[labels.indexOf("01:00-02:00")].pass, 1);
  assert.equal(vi.totals.pass, 2);
});

test("the last stage is named for the completion row, and a day without usable hours is refused", () => {
  assert.equal(hourly().lastStage, "Functional");
  assert.equal(buildHourly({ date: "2026-10-07", window: { startTime: "", endTime: "" }, stages: STAGES, records: [], aliasLookup: LOOKUP }).ok, false);
});

test("a day that is not on the plan has no targets, only the output", () => {
  const h = hourly({ scheduled: false, records: newestFirst([rec("A", "Visual Inspection", "Pass", at(9, 0))]) });
  const vi = h.stages.find((s) => s.name === "Visual Inspection");
  assert.equal(h.scheduled, false);
  assert.ok(vi.cells.every((c) => c.target === null));
  assert.equal(vi.totals.target, null);
  assert.equal(vi.totals.pass, 1);
});

test("work after the day's reach belongs to the next day and is not counted as other hours; a night shift reaches into the morning", () => {
  const dayShift = hourly({ records: newestFirst([rec("A", "Visual Inspection", "Pass", at(26, 0)), rec("B", "Visual Inspection", "Pass", at(9, 0))]) }); // 02:00 the next morning
  const vi = dayShift.stages.find((s) => s.name === "Visual Inspection");
  assert.deepEqual(vi.outside, { pass: 0, ng: 0 });
  assert.equal(vi.totals.pass, 1, "only the 09:00 pass");
  const night = buildHourly({ date: "2026-10-07", window: { startTime: "21:00", endTime: "05:00" }, breaks: [], stages: STAGES, records: newestFirst([rec("A", "Visual Inspection", "Pass", at(25, 30)), rec("B", "Visual Inspection", "Pass", at(31, 0))]), devices: [], aliasLookup: LOOKUP, lastStage: "Functional" });
  assert.equal(night.stages.find((s) => s.name === "Visual Inspection").totals.pass, 1, "01:30 is in the shift; 07:00 is the next day's");
});
