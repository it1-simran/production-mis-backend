const test = require("node:test");
const assert = require("node:assert/strict");
const { expandPlanToDays } = require("../../services/planning/dayGenerator");
const { computeDayPlan, overtimeMinutesFor, downtimeMinutesFor } = require("../../services/planning/dayCapacity");
const { validatePlan } = require("../../services/planning/planValidator");
const { buildHolidayKeys } = require("../../utils/planDates");
const { DAY_SHIFT, PROCESS, makeDraft, makeCtx, stageEntry } = require("./helpers");

const ID_A = "507f1f77bcf86cd799439011";
const NO_HOLIDAYS = buildHolidayKeys([]);

const days = ({ draft = {}, end = new Date(2026, 9, 9) } = {}) =>
  expandPlanToDays({ draft: makeDraft(draft), endDate: end, shift: DAY_SHIFT, holidayKeys: NO_HOLIDAYS }).days;

const plan = (dayList, options = {}) =>
  computeDayPlan({ days: dayList, processStages: PROCESS.stages, shift: DAY_SHIFT, quantity: 1000, ...options });

const extraSeat = (seatKey, name, upha, source = "adjusted") => ({
  kind: "seat",
  seatKey,
  rowIndex: 0,
  seatIndex: Number(seatKey.split("-")[1]),
  commonSlot: null,
  stage: { name, upha, stageInstanceId: "", parallelGroupKey: "", requiredSkill: "", managedBy: "", hasJigStepType: false },
  operatorIds: [],
  jigIds: [],
  source,
  adjustedFields: [],
  state: "active",
});

const codes = (r) => r.problems.map((p) => p.code);
const units = (r) => r.perDay.map((d) => d.plannedUnits);

test("an untouched template gives the same finish date as the Phase 1 formula", () => {
  const result = plan(days());
  // 1000 units, Functional 40/h x 1 seat x 8 productive hours = 320/day; start day is a set-up day.
  assert.deepEqual(units(result), [0, 320, 320, 320, 40]);
  assert.equal(result.forecast.forecastEndKey, "2026-10-09");
  assert.equal(result.forecast.shortfallUnits, 0);
  const phase1 = validatePlan(makeDraft(), makeCtx(), { now: new Date(2026, 9, 1) }).computed;
  assert.equal(result.forecast.forecastEndKey, phase1.capacityEndKey, "day-wise and Phase 1 agree when no day is adjusted");
});

test("cumulative units and remaining add up day by day", () => {
  const r = plan(days());
  assert.deepEqual(r.perDay.map((d) => d.cumulativeUnits), [0, 320, 640, 960, 1000]);
  assert.deepEqual(r.perDay.map((d) => d.remainingAfter), [1000, 680, 360, 40, 0]);
  assert.equal(r.forecast.totalPlanned, 1000);
  assert.equal(r.forecast.producingDays, 4);
});

test("the start day is a set-up day by default, and produces when asked", () => {
  const setup = plan(days());
  assert.equal(setup.perDay[0].setupDay, true);
  assert.equal(plan(days(), { startDayProduces: false }).perDay[0].setupDay, true);
  assert.ok(codes(setup).includes("DAY-007"));
  const producing = plan(days(), { startDayProduces: true });
  assert.equal(producing.perDay[0].setupDay, false);
  assert.deepEqual(units(producing), [320, 320, 320, 40, 0]);
  assert.equal(producing.forecast.forecastEndKey, "2026-10-08");
  assert.ok(!codes(producing).includes("DAY-007"));
});

test("worked example: one day with a second seat on the slowest stage finishes the plan earlier", () => {
  const d = days();
  // Wednesday: a planner adds a second Functional seat for that day only.
  d[2].rows.push(extraSeat("0-2", "Functional", 40));
  const r = plan(d);
  // Functional is now 80/h, but Visual Inspection (50/h) limits the line to 400 that day.
  assert.equal(r.perDay[2].capacityUnits, 400);
  assert.equal(r.perDay[2].bottleneck.stage, "Visual Inspection");
  assert.equal(r.perDay[2].adjusted, true);
  assert.deepEqual(units(r), [0, 320, 400, 280, 0]);
  assert.equal(r.forecast.forecastEndKey, "2026-10-08", "Thursday instead of Friday");
  assert.equal(r.forecast.shortfallUnits, 0);
});

test("exact shortfall when the plan ends too early (the range-based check cannot see the adjusted day)", () => {
  const d = days({ end: new Date(2026, 9, 7) }); // ends Wednesday
  d[2].rows.push(extraSeat("0-2", "Functional", 40));
  const r = plan(d);
  assert.deepEqual(units(r), [0, 320, 400]);
  assert.equal(r.forecast.shortfallUnits, 280);
  const issue = r.problems.find((p) => p.code === "DAY-002");
  assert.ok(issue);
  assert.equal(issue.shortfallUnits, 280);
  assert.equal(issue.dayKey, "2026-10-07");
  assert.equal(r.forecast.forecastEndKey, "2026-10-07");
});

test("a stage with no seat on a producing day stops the line: error on an adjusted day, warning otherwise", () => {
  const d = days();
  d[2].rows = d[2].rows.filter((row) => row.stage.name !== "Functional");
  d[2].rows[0].source = "adjusted";
  const r = plan(d);
  assert.equal(r.perDay[2].stalled, true);
  assert.equal(r.perDay[2].plannedUnits, 0);
  const wed = r.problems.find((p) => p.code === "DAY-003" && p.dayKey === "2026-10-07");
  assert.equal(wed.severity, "error");
  assert.deepEqual(wed.stages, ["Functional"]);
  // the lost day cannot be made up inside the plan: Tue 320, Wed 0, Thu 320, Fri 320, so 40 units are short
  assert.deepEqual(units(r), [0, 320, 0, 320, 320]);
  assert.equal(r.forecast.shortfallUnits, 40);

  const plain = days();
  plain[2].rows = plain[2].rows.filter((row) => row.stage.name !== "Functional");
  const warn = plan(plain).problems.find((p) => p.code === "DAY-003");
  assert.equal(warn.severity, "warning");
});

test("a stage left off every day is reported on each producing day, not on the set-up day", () => {
  const r = plan(days({ draft: { assignedStages: { "0-0": [stageEntry("Visual Inspection", 50)] } } }));
  const stalledDays = r.problems.filter((p) => p.code === "DAY-003").map((p) => p.dayKey);
  assert.deepEqual(stalledDays, ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.equal(r.forecast.forecastEndKey, null);
  assert.equal(r.forecast.shortfallUnits, 1000);
});

test("stall behaviour can be switched off to match the looser Phase 1 maths", () => {
  const r = plan(days({ draft: { assignedStages: { "0-0": [stageEntry("Visual Inspection", 50)] } } }), { stallWhenStageUnseated: false });
  assert.equal(r.perDay[1].capacityUnits, 400);
  assert.ok(!codes(r).includes("DAY-003"));
});

test("unstaffed seats count by default; counting only staffed seats can be requested", () => {
  const d = days({ draft: { assignedOperators: { "0-0": [{ _id: ID_A }] } } });
  assert.equal(plan(d).perDay[1].capacityUnits, 320);
  const strict = plan(d, { countUnstaffed: false });
  assert.equal(strict.perDay[1].seatCount, 1, "only the staffed seat counts");
  assert.equal(strict.perDay[1].capacityUnits, 0, "Functional has no staffed seat, so the line is stalled");
});

test("released and conflicting rows hold no capacity", () => {
  const d = days();
  d[1].rows[1].state = "released";
  const r = plan(d);
  assert.equal(r.perDay[1].stalled, true);
  assert.equal(r.perDay[1].plannedUnits, 0);
  d[1].rows[1].state = "conflict";
  assert.equal(plan(d).perDay[1].plannedUnits, 0);
});

test("overtime adds hours to the day it starts on; downtime removes the hours it overlaps", () => {
  const overtime = [{ from: new Date(2026, 9, 6, 18, 0), to: new Date(2026, 9, 6, 20, 0), active: true }, { from: new Date(2026, 9, 7, 18, 0), to: new Date(2026, 9, 7, 20, 0), active: false }];
  assert.equal(overtimeMinutesFor("2026-10-06", overtime), 120);
  assert.equal(overtimeMinutesFor("2026-10-07", overtime), 0, "inactive window ignored");
  const withOt = plan(days(), { overtimeWindows: overtime });
  assert.equal(withOt.perDay[1].capacityMinutes, 600);
  assert.equal(withOt.perDay[1].capacityUnits, 400); // 40/h x 10h
  assert.equal(withOt.perDay[2].capacityMinutes, 480);

  const downTime = { from: new Date(2026, 9, 7, 10, 0), to: new Date(2026, 9, 7, 12, 0) };
  const d = days();
  assert.equal(downtimeMinutesFor(d[2], downTime), 120);
  assert.equal(downtimeMinutesFor(d[1], downTime), 0);
  assert.equal(downtimeMinutesFor(d[2], { from: new Date(2026, 9, 7, 6, 0), to: new Date(2026, 9, 7, 10, 0) }), 60, "only the part inside the shift counts");
  const withDown = plan(d, { downTime });
  assert.equal(withDown.perDay[2].capacityMinutes, 360);
  assert.equal(withDown.perDay[2].capacityUnits, 240);
});

test("zero or missing quantity plans nothing and reports no shortfall", () => {
  const r = plan(days(), { quantity: 0 });
  assert.deepEqual(units(r), [0, 0, 0, 0, 0]);
  assert.equal(r.forecast.forecastEndKey, null);
  assert.equal(r.forecast.shortfallUnits, 0);
  assert.ok(!codes(r).includes("DAY-002"));
  assert.equal(plan(days(), { quantity: "abc" }).forecast.quantity, 0);
});

test("a one-day plan produces on its only day (stored single-day plans have end = start)", () => {
  const r = plan(days({ end: new Date(2026, 9, 5) }));
  assert.equal(r.perDay.length, 1);
  assert.equal(r.perDay[0].setupDay, false);
  assert.equal(r.perDay[0].plannedUnits, 320);
  assert.equal(r.forecast.shortfallUnits, 680);
  assert.equal(r.forecast.forecastEndKey, "2026-10-05");
  assert.ok(codes(r).includes("DAY-002"));
  assert.ok(!codes(r).includes("DAY-007"));
});

test("forcing the set-up policy makes a one-day plan only a set-up day", () => {
  const r = plan(days({ end: new Date(2026, 9, 5) }), { startDayProduces: false });
  assert.equal(r.perDay[0].setupDay, true);
  assert.equal(r.forecast.shortfallUnits, 1000);
  assert.equal(r.forecast.forecastEndKey, null);
  assert.ok(codes(r).includes("DAY-007"));
});

test("no days at all gives an empty, harmless result", () => {
  const r = computeDayPlan({ days: [], processStages: PROCESS.stages, shift: DAY_SHIFT, quantity: 1000 });
  assert.deepEqual(r.perDay, []);
  assert.equal(r.forecast.lastDayKey, null);
  assert.deepEqual(r.problems, []);
});
