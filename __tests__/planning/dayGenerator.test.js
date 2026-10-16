const test = require("node:test");
const assert = require("node:assert/strict");
const { expandPlanToDays } = require("../../services/planning/dayGenerator");
const { buildHolidayKeys, dayNumber } = require("../../utils/planDates");
const { DAY_SHIFT, NIGHT_SHIFT, makeDraft, stageEntry } = require("./helpers");

const ID_A = "507f1f77bcf86cd799439011";
const ID_B = "507f1f77bcf86cd799439012";
const ID_C = "507f1f77bcf86cd799439013";
const JIG = "507f1f77bcf86cd799439021";

const NO_HOLIDAYS = buildHolidayKeys([]);
const expand = (draftOverrides = {}, { end = new Date(2026, 9, 9), shift = DAY_SHIFT, holidayKeys = NO_HOLIDAYS, ...rest } = {}) =>
  expandPlanToDays({ draft: makeDraft(draftOverrides), endDate: end, shift, holidayKeys, ...rest });

const keys = (result) => result.days.map((d) => d.dayKey);
const codes = (result) => result.problems.map((p) => p.code);

test("a plain plan gets one entry per working day, start and end day included", () => {
  const r = expand();
  assert.equal(r.ok, true);
  assert.deepEqual(keys(r), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.equal(r.days[0].isStartDay, true);
  assert.equal(r.days[1].isStartDay, false);
  assert.deepEqual(r.calendar, { startKey: "2026-10-05", endKey: "2026-10-09", workingDays: 5, window: { startTime: "09:00", endTime: "18:00" }, truncated: false });
});

test("every day carries one row per placed seat, copied from the template", () => {
  const r = expand();
  r.days.forEach((day) => {
    assert.deepEqual(day.rows.map((row) => row.seatKey), ["0-0", "0-1"]);
    assert.deepEqual(day.rows.map((row) => row.stage.name), ["Visual Inspection", "Functional"]);
    assert.equal(day.rows[0].kind, "seat");
    assert.equal(day.rows[0].source, "template");
    assert.equal(day.rows[0].state, "active");
    assert.equal(day.rows[1].rowIndex, 0);
    assert.equal(day.rows[1].seatIndex, 1);
  });
});

test("absolute minutes make overlap tests plain range checks", () => {
  const r = expand();
  const monday = r.days[0];
  assert.equal(monday.absStart, dayNumber("2026-10-05") * 1440 + 540);
  assert.equal(monday.absEnd, dayNumber("2026-10-05") * 1440 + 1080);
  assert.equal(r.days[1].absStart - monday.absStart, 1440);
});

test("weekends and holidays are skipped", () => {
  const holidayKeys = buildHolidayKeys([{ holidayDate: new Date("2026-10-12T00:00:00.000Z") }]);
  const r = expand({ startDate: "08/10/26 00:00:00" }, { end: new Date(2026, 9, 13), holidayKeys });
  assert.deepEqual(keys(r), ["2026-10-08", "2026-10-09", "2026-10-13"]); // Sat 10, Sun 11 and holiday Mon 12 are out
});

test("a start day that is a day off simply has no entry, and nothing is marked as the start day", () => {
  const r = expand({ startDate: "10/10/26 00:00:00" }, { end: new Date(2026, 9, 14) }); // Saturday start
  assert.deepEqual(keys(r), ["2026-10-12", "2026-10-13", "2026-10-14"]);
  assert.ok(r.days.every((d) => !d.isStartDay));
});

test("an overnight shift belongs to the day it starts, and ends after midnight", () => {
  const r = expand({}, { shift: NIGHT_SHIFT, end: new Date(2026, 9, 6) });
  assert.deepEqual(keys(r), ["2026-10-05", "2026-10-06"]);
  const base = dayNumber("2026-10-05") * 1440;
  assert.equal(r.days[0].absStart, base + 21 * 60);
  assert.equal(r.days[0].absEnd, base + 29 * 60); // 05:00 the next morning
  assert.ok(r.days[0].absEnd > dayNumber("2026-10-06") * 1440, "the tail of Monday's shift runs into Tuesday morning");
  assert.ok(r.days[0].absEnd <= r.days[1].absStart, "but consecutive nights do not overlap each other");
});

test("a shift override replaces the shift window", () => {
  const r = expand({ ProcessShiftMappings: { startTime: "08:00", endTime: "16:00" } });
  assert.deepEqual(r.days[0].window, { startTime: "08:00", endTime: "16:00" });
  assert.equal(r.days[0].absStart, dayNumber("2026-10-05") * 1440 + 480);
  assert.equal(r.days[0].absEnd, dayNumber("2026-10-05") * 1440 + 960);
});

test("an invalid override or a shift without usable times is refused with the Phase 1 codes", () => {
  const badOverride = expand({ ProcessShiftMappings: { startTime: "xx", endTime: "16:00" } });
  assert.equal(badOverride.ok, false);
  assert.deepEqual(codes(badOverride), ["SHIFT-001"]);
  assert.deepEqual(badOverride.days, []);
  const noTimes = expand({}, { shift: { ...DAY_SHIFT, startTime: undefined, endTime: undefined, intervals: [] } });
  assert.equal(noTimes.ok, false);
  assert.deepEqual(codes(noTimes), ["SHIFT-002"]);
});

test("missing start date, missing end date, end before start and an empty range are refused", () => {
  assert.deepEqual(codes(expand({ startDate: "" })), ["CAL-004"]);
  assert.deepEqual(codes(expand({}, { end: null })), ["DAY-008"]);
  assert.deepEqual(codes(expand({}, { end: new Date("nonsense") })), ["DAY-008"]);
  assert.deepEqual(codes(expand({}, { end: new Date(2026, 9, 1) })), ["CAL-005"]);
  const weekend = expand({ startDate: "10/10/26 00:00:00" }, { end: new Date(2026, 9, 11) });
  assert.equal(weekend.ok, false);
  assert.deepEqual(codes(weekend), ["CAL-004"]);
});

test("a plan longer than the cap stays range-based (DAY-006)", () => {
  const r = expand({}, { end: new Date(2026, 11, 31), maxDays: 20 });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["DAY-006"]);
  assert.equal(r.calendar.truncated, true);
  const exact = expand({}, { end: new Date(2026, 9, 9), maxDays: 5 });
  assert.equal(exact.ok, true, "exactly at the cap is allowed");
});

test("days never share rows: editing one day leaves the others alone", () => {
  const r = expand();
  r.days[0].rows[0].operatorIds.push(ID_A);
  r.days[0].rows[0].stage.name = "Changed";
  assert.deepEqual(r.days[1].rows[0].operatorIds, []);
  assert.equal(r.days[1].rows[0].stage.name, "Visual Inspection");
});

test("production counters are not copied into day rows", () => {
  const counted = { ...stageEntry("Visual Inspection", 50), passedDevice: 17, ngDevice: 2, totalUPHA: 320 };
  const r = expand({ assignedStages: { "0-0": [counted] } });
  const stage = r.days[0].rows[0].stage;
  assert.equal(stage.name, "Visual Inspection");
  assert.equal(stage.upha, 50);
  assert.ok(!("passedDevice" in stage) && !("ngDevice" in stage) && !("totalUPHA" in stage));
});

test("operators, jigs and common-stage people are carried onto the rows", () => {
  const r = expand(
    {
      assignedOperators: { "0-0": [{ _id: ID_A }], "0-1": [{ _id: ID_B }, { _id: ID_B }] },
      assignedJigs: { "0-1": [{ _id: JIG }] },
      assignedCustomStagesOp: [[{ _id: ID_C }], []],
    },
    { commonStages: [{ stageName: "QC Check", managedBy: "QC", requiredSkill: "QC" }, { stageName: "Store" }] },
  );
  const rows = r.days[2].rows;
  assert.deepEqual(rows.map((x) => x.kind), ["seat", "seat", "common"]);
  assert.deepEqual(rows[0].operatorIds, [ID_A]);
  assert.deepEqual(rows[1].operatorIds, [ID_B], "duplicates collapse");
  assert.deepEqual(rows[1].jigIds, [JIG]);
  assert.equal(rows[2].commonSlot, 0);
  assert.equal(rows[2].seatKey, null);
  assert.equal(rows[2].stage.name, "QC Check");
  assert.equal(rows[2].stage.managedBy, "QC");
  assert.deepEqual(rows[2].operatorIds, [ID_C]);
  assert.equal(rows.length, 3, "an empty common slot creates no row");
});

test("seats are listed in line/seat order even when the template keys are not", () => {
  const r = expand({
    assignedStages: {
      "1-0": [stageEntry("Functional", 40)],
      "0-10": [stageEntry("Visual Inspection", 50)],
      "0-2": [stageEntry("Visual Inspection", 50)],
    },
  });
  assert.deepEqual(r.days[0].rows.map((x) => x.seatKey), ["0-2", "0-10", "1-0"]);
});

test("reserved entries, unreadable seat keys and empty seats are ignored; extra stages on a seat are reported", () => {
  const r = expand({
    assignedStages: {
      "0-0": [{ ...stageEntry("Visual Inspection", 50), reserved: true }],
      "oops": [stageEntry("Functional", 40)],
      "0-1": [stageEntry("Functional", 40), stageEntry("Visual Inspection", 50)],
      "0-2": [],
    },
  });
  assert.deepEqual(r.days[0].rows.map((x) => x.seatKey), ["0-1"]);
  assert.equal(r.days[0].rows[0].stage.name, "Functional");
  const extra = r.problems.find((p) => p.code === "DAY-009");
  assert.ok(extra);
  assert.equal(extra.severity, "info");
  assert.equal(extra.seatKey, "0-1");
});

test("a plan with nothing placed still expands to empty days, with an info note", () => {
  const r = expand({ assignedStages: {} });
  assert.equal(r.ok, true);
  assert.equal(r.days.length, 5);
  assert.deepEqual(r.days[0].rows, []);
  assert.deepEqual(codes(r), ["STRUCT-001"]);
});
