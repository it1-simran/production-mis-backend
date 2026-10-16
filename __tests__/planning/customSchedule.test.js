const test = require("node:test");
const assert = require("node:assert/strict");
const { expandPlanToDays } = require("../../services/planning/dayGenerator");
const { computeDayPlan } = require("../../services/planning/dayCapacity");
const { buildDaySchedule, templateFromShift } = require("../../services/planning/daySchedule");
const { buildHolidayKeys, dayNumber } = require("../../utils/planDates");
const { DAY_SHIFT, PROCESS, makeDraft, stageEntry } = require("./helpers");

const NO_HOLIDAYS = buildHolidayKeys([]);
const LUNCH = [{ startTime: "13:00", endTime: "14:00" }];
const entry = (dayKey, startTime, endTime, over = {}) => ({ dayKey, startTime, endTime, breaks: [], unplacedBreakMinutes: 0, working: true, edited: true, note: "", ...over });

// Mon 5 Oct: 09-17 with lunch (7h); Tue 6 Oct: 10-14 (4h); Wed 7 Oct: 08-18 no breaks (10h)
const WEEK = () => [
  entry("2026-10-05", "09:00", "17:00", { breaks: LUNCH }),
  entry("2026-10-06", "10:00", "14:00"),
  entry("2026-10-07", "08:00", "18:00", { note: "rush" }),
];

const expand = (daySchedule, { draft = {}, end = new Date(2026, 9, 7), ...rest } = {}) =>
  expandPlanToDays({ draft: makeDraft(draft), endDate: end, daySchedule, holidayKeys: NO_HOLIDAYS, ...rest });
const codes = (r) => r.problems.map((p) => p.code);

test("each day gets its own window, productive minutes and breaks; no shift is needed", () => {
  const r = expand(WEEK());
  assert.equal(r.ok, true);
  assert.deepEqual(r.days.map((d) => d.dayKey), ["2026-10-05", "2026-10-06", "2026-10-07"]);
  assert.deepEqual(r.days.map((d) => d.productiveMinutes), [420, 240, 600]);
  assert.deepEqual(r.days.map((d) => d.window), [
    { startTime: "09:00", endTime: "17:00" },
    { startTime: "10:00", endTime: "14:00" },
    { startTime: "08:00", endTime: "18:00" },
  ]);
  assert.equal(r.days[1].absStart, dayNumber("2026-10-06") * 1440 + 600);
  assert.equal(r.days[1].absEnd, dayNumber("2026-10-06") * 1440 + 840);
  assert.deepEqual(r.days[0].breaks, LUNCH);
  assert.equal(r.days[2].note, "rush");
  assert.ok(r.days.every((d) => d.custom === true && d.rows.length === 2));
  assert.equal(r.days[0].isStartDay, true);
  assert.deepEqual(r.calendar, { startKey: "2026-10-05", endKey: "2026-10-07", workingDays: 3, window: { startTime: "09:00", endTime: "17:00" }, truncated: false, scheduleMode: "custom" });
});

test("days are ordered by date whatever order they arrive in, and days off are left out", () => {
  const list = [WEEK()[2], entry("2026-10-06", "10:00", "14:00", { working: false }), WEEK()[0]];
  const r = expand(list);
  assert.deepEqual(r.days.map((d) => d.dayKey), ["2026-10-05", "2026-10-07"]);
});

test("an overnight custom day ends after midnight and belongs to the day it starts", () => {
  const r = expand([entry("2026-10-05", "21:00", "05:00"), entry("2026-10-06", "21:00", "05:00")], { end: new Date(2026, 9, 6) });
  const base = dayNumber("2026-10-05") * 1440;
  assert.equal(r.days[0].absStart, base + 1260);
  assert.equal(r.days[0].absEnd, base + 1740);
  assert.equal(r.days[0].productiveMinutes, 480);
});

test("a list with errors is refused, with the SCH code that says why", () => {
  assert.deepEqual(codes(expand([entry("2026-10-05", "bad", "17:00")])), ["SCH-001"]);
  assert.deepEqual(codes(expand([entry("2026-10-05", "21:00", "05:00"), entry("2026-10-06", "02:00", "08:00")])), ["SCH-003"]);
  assert.deepEqual(codes(expand([entry("2026-10-20", "09:00", "17:00")])), ["SCH-004"]);
  assert.deepEqual(codes(expand([entry("2026-10-05", "09:00", "09:00")])), ["SCH-002"]);
  const none = expand([entry("2026-10-05", "09:00", "17:00", { working: false })]);
  assert.equal(none.ok, false);
  assert.deepEqual(codes(none), ["CAL-004"]);
  assert.ok([expand([entry("2026-10-05", "bad", "17:00")]), none].every((r) => r.ok === false && r.days.length === 0));
});

test("warnings do not stop the expansion but are carried on the result", () => {
  const holidayKeys = buildHolidayKeys([{ holidayDate: new Date("2026-10-06T00:00:00.000Z") }]);
  const r = expand(WEEK(), { holidayKeys, shift: DAY_SHIFT });
  assert.equal(r.ok, true);
  assert.ok(codes(r).includes("SCH-005"), "Tuesday is a holiday but scheduled");
  assert.ok(codes(r).includes("SCH-008"), "hours differ from the template shift");
});

test("the working-day cap applies to custom schedules too", () => {
  const r = expand(WEEK(), { maxDays: 2 });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["DAY-006"]);
  assert.equal(r.calendar.truncated, true);
  assert.equal(expand(WEEK(), { maxDays: 3 }).ok, true);
});

test("an invalid start or end date is still refused first", () => {
  assert.deepEqual(codes(expand(WEEK(), { draft: { startDate: "" } })), ["CAL-004"]);
  assert.deepEqual(codes(expand(WEEK(), { end: null })), ["DAY-008"]);
  assert.deepEqual(codes(expand(WEEK(), { end: new Date(2026, 9, 1) })), ["CAL-005"]);
});

// ---- capacity with per-day hours -------------------------------------------------------------

const plan = (days, options = {}) => computeDayPlan({ days, processStages: PROCESS.stages, quantity: 1000, ...options });

test("each day's output follows that day's hours, and every scheduled day produces", () => {
  // Functional is the slowest stage at 40/h: 7h = 280, 4h = 160, 10h = 400
  const r = plan(expand(WEEK()).days);
  assert.deepEqual(r.perDay.map((d) => d.capacityMinutes), [420, 240, 600]);
  assert.deepEqual(r.perDay.map((d) => d.capacityUnits), [280, 160, 400]);
  assert.deepEqual(r.perDay.map((d) => d.plannedUnits), [280, 160, 400], "the first day produces: no set-up day in a custom schedule");
  assert.ok(r.perDay.every((d) => d.setupDay === false));
  assert.equal(r.forecast.totalPlanned, 840);
  assert.equal(r.forecast.shortfallUnits, 160);
  assert.ok(r.problems.some((p) => p.code === "DAY-002" && p.shortfallUnits === 160));
  assert.ok(!r.problems.some((p) => p.code === "DAY-007"));
});

test("adding a day to the schedule closes the gap and moves the forecast end", () => {
  const list = [...WEEK(), entry("2026-10-08", "09:00", "17:00", { breaks: LUNCH })];
  const r = plan(expand(list, { end: new Date(2026, 9, 8) }).days);
  assert.deepEqual(r.perDay.map((d) => d.plannedUnits), [280, 160, 400, 160]);
  assert.equal(r.forecast.shortfallUnits, 0);
  assert.equal(r.forecast.forecastEndKey, "2026-10-08");
});

test("a shorter day loses output in proportion, an unscheduled day makes nothing", () => {
  const list = [entry("2026-10-05", "09:00", "17:00", { breaks: LUNCH }), entry("2026-10-06", "09:00", "17:00", { working: false }), entry("2026-10-07", "09:00", "13:00")];
  const r = plan(expand(list).days);
  assert.deepEqual(r.perDay.map((d) => [d.dayKey, d.capacityUnits]), [["2026-10-05", 280], ["2026-10-07", 160]]);
});

test("a custom schedule built from a shift template reproduces that shift's daily capacity", () => {
  const template = templateFromShift(DAY_SHIFT);
  const built = buildDaySchedule({ startKey: "2026-10-05", endKey: "2026-10-09", defaults: template });
  const custom = plan(expand(built.days, { end: new Date(2026, 9, 9) }).days);
  const shiftMode = plan(expandPlanToDays({ draft: makeDraft(), endDate: new Date(2026, 9, 9), shift: DAY_SHIFT, holidayKeys: NO_HOLIDAYS }).days, { shift: DAY_SHIFT });
  assert.deepEqual(custom.perDay.map((d) => d.capacityUnits), shiftMode.perDay.map((d) => d.capacityUnits));
  assert.deepEqual(custom.perDay.map((d) => d.capacityMinutes), shiftMode.perDay.map((d) => d.capacityMinutes));
  assert.deepEqual(custom.perDay.map((d) => d.capacityUnits), [320, 320, 320, 320, 320]);
});

test("overtime and downtime still adjust a custom day", () => {
  const days = expand(WEEK()).days;
  const withOvertime = plan(days, { overtimeWindows: [{ from: new Date(2026, 9, 6, 14, 0), to: new Date(2026, 9, 6, 16, 0), active: true }] });
  assert.equal(withOvertime.perDay[1].capacityMinutes, 360, "4 hours + 2 hours of overtime");
  const withDowntime = plan(days, { downTime: { from: new Date(2026, 9, 7, 9, 0), to: new Date(2026, 9, 7, 11, 0) } });
  assert.equal(withDowntime.perDay[2].capacityMinutes, 480, "10 hours minus 2 hours of downtime inside the day");
});

test("a custom day with no productive time makes nothing", () => {
  const list = [entry("2026-10-05", "09:00", "17:00", { breaks: [{ startTime: "09:00", endTime: "17:00" }] })];
  const r = plan(expand(list, { end: new Date(2026, 9, 5) }).days);
  assert.equal(r.perDay[0].capacityUnits, 0);
  assert.equal(r.perDay[0].plannedUnits, 0);
});

test("shift mode is untouched: the start day is still a set-up day there", () => {
  const days = expandPlanToDays({ draft: makeDraft(), endDate: new Date(2026, 9, 9), shift: DAY_SHIFT, holidayKeys: NO_HOLIDAYS }).days;
  assert.ok(days.every((d) => !d.custom));
  assert.equal(plan(days, { shift: DAY_SHIFT }).perDay[0].setupDay, true);
});
