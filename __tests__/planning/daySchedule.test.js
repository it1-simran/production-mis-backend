const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../services/planning/daySchedule");
const { getProductiveMinutes } = require("../../services/planning/capacity");
const { buildHolidayKeys } = require("../../utils/planDates");
const { DAY_SHIFT, NIGHT_SHIFT } = require("./helpers");

const WEEKDAYS = { sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false };
const NO_HOLIDAYS = buildHolidayKeys([]);
const MON_HOLIDAY = buildHolidayKeys([{ holidayDate: new Date("2026-10-12T00:00:00.000Z") }]);

const entry = (over = {}) => ({ dayKey: "2026-10-12", startTime: "09:00", endTime: "17:00", breaks: [], unplacedBreakMinutes: 0, working: true, edited: false, note: "", ...over });
const codes = (problems) => problems.map((p) => p.code);

// ---- time and break maths -------------------------------------------------------------------

test("normTime accepts H:mm and HH:mm:ss and rejects nonsense", () => {
  assert.equal(S.normTime("9:30"), "09:30");
  assert.equal(S.normTime("09:30:45"), "09:30");
  assert.equal(S.normTime("24:00"), "");
  assert.equal(S.normTime("abc"), "");
  assert.equal(S.normTime(""), "");
  assert.equal(S.normTime(undefined), "");
});

test("productive minutes of a day equal Phase 1's figure for the same shift", () => {
  [DAY_SHIFT, NIGHT_SHIFT].forEach((shift) => {
    const t = S.templateFromShift(shift);
    const e = entry({ startTime: t.startTime, endTime: t.endTime, breaks: t.breaks, unplacedBreakMinutes: t.unplacedBreakMinutes });
    assert.equal(S.productiveMinutesOf(e), getProductiveMinutes(shift), shift.name);
  });
  assert.equal(S.productiveMinutesOf(entry({ startTime: "09:00", endTime: "18:00", breaks: [{ startTime: "13:00", endTime: "14:00" }] })), 480);
});

test("template breaks are clipped to a shorter day: only the ones inside the window are lost", () => {
  const lunch = [{ startTime: "13:00", endTime: "14:00" }];
  assert.equal(S.productiveMinutesOf(entry({ startTime: "10:00", endTime: "15:00", breaks: lunch })), 240, "lunch inside the day");
  assert.equal(S.productiveMinutesOf(entry({ startTime: "09:00", endTime: "12:00", breaks: lunch })), 180, "lunch is after the day ends");
  assert.equal(S.productiveMinutesOf(entry({ startTime: "09:00", endTime: "13:30", breaks: lunch })), 240, "half an hour of lunch falls inside a 4.5 hour day");
});

test("breaks after midnight belong to an overnight day, and overlapping breaks are counted once", () => {
  const night = { startTime: "21:00", endTime: "05:00" };
  assert.equal(S.productiveMinutesOf(entry({ ...night, breaks: [{ startTime: "01:00", endTime: "01:30" }] })), 450, "01:00 is the next morning");
  assert.equal(S.productiveMinutesOf(entry({ ...night, breaks: [{ startTime: "23:00", endTime: "23:30" }] })), 450);
  assert.equal(S.productiveMinutesOf(entry({ breaks: [{ startTime: "12:00", endTime: "13:00" }, { startTime: "12:30", endTime: "13:30" }] })), 480 - 90);
  assert.equal(S.productiveMinutesOf(entry({ breaks: [{ startTime: "12:00", endTime: "13:00" }, { startTime: "12:00", endTime: "13:00" }] })), 480 - 60);
});

test("unplaced break minutes come off the day, and a day never goes below zero", () => {
  assert.equal(S.productiveMinutesOf(entry({ startTime: "09:00", endTime: "18:00", unplacedBreakMinutes: 50 })), 490);
  assert.equal(S.productiveMinutesOf(entry({ startTime: "09:00", endTime: "10:00", unplacedBreakMinutes: 90 })), 0);
  assert.equal(S.productiveMinutesOf(entry({ startTime: "bad", endTime: "10:00" })), 0);
});

test("templateFromShift reads times, weekdays and break intervals; a shift with only a break total keeps it", () => {
  const t = S.templateFromShift(DAY_SHIFT);
  assert.equal(t.startTime, "09:00");
  assert.equal(t.endTime, "18:00");
  assert.deepEqual(t.breaks, [{ startTime: "13:00", endTime: "14:00" }]);
  assert.equal(t.productiveMinutes, 480);
  assert.equal(t.weekDays.sat, false);
  const totalOnly = S.templateFromShift({ startTime: "09:00", endTime: "18:00", totalBreakTime: 50, weekDays: WEEKDAYS });
  assert.deepEqual(totalOnly.breaks, []);
  assert.equal(totalOnly.unplacedBreakMinutes, 50);
  assert.equal(totalOnly.productiveMinutes, 490);
  assert.equal(S.templateFromShift(null), null);
});

// ---- normalising input -----------------------------------------------------------------------

test("normalizeDaySchedule cleans untrusted input and keeps duplicates for validation", () => {
  const out = S.normalizeDaySchedule([
    { dayKey: " 2026-10-12 ", startTime: "9:30", endTime: "18:30:00", breaks: new Array(9).fill({ startTime: "13:00", endTime: "13:30" }), working: "false", note: "x".repeat(500), edited: "true" },
    { dayKey: "2026-10-12", startTime: "bad" },
    null,
    "junk",
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].dayKey, "2026-10-12");
  assert.equal(out[0].startTime, "09:30");
  assert.equal(out[0].endTime, "18:30");
  assert.equal(out[0].breaks.length, 6);
  assert.equal(out[0].working, false);
  assert.equal(out[0].edited, true);
  assert.equal(out[0].note.length, 200);
  assert.equal(out[1].startTime, "");
  assert.equal(out[1].working, true, "working by default");
  assert.deepEqual(S.normalizeDaySchedule(JSON.stringify([{ dayKey: "2026-10-12" }])).length, 1);
  assert.deepEqual(S.normalizeDaySchedule("{not json"), []);
  assert.deepEqual(S.normalizeDaySchedule(undefined), []);
});

// ---- building the table ----------------------------------------------------------------------

const DEFAULTS = { startTime: "09:00", endTime: "18:00", weekDays: WEEKDAYS, breaks: [{ startTime: "13:00", endTime: "14:00" }] };

test("buildDaySchedule lists every day; weekly days off and holidays are listed but not working", () => {
  const r = S.buildDaySchedule({ startKey: "2026-10-08", endKey: "2026-10-13", defaults: DEFAULTS, holidayKeys: MON_HOLIDAY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.days.map((d) => [d.dayKey, d.working, d.offReason]), [
    ["2026-10-08", true, null],
    ["2026-10-09", true, null],
    ["2026-10-10", false, "weekly_off"],
    ["2026-10-11", false, "weekly_off"],
    ["2026-10-12", false, "holiday"],
    ["2026-10-13", true, null],
  ]);
  assert.equal(r.days[0].startTime, "09:00");
  assert.deepEqual(r.days[0].breaks, [{ startTime: "13:00", endTime: "14:00" }]);
  assert.ok(r.days.every((d) => d.edited === false));
});

test("holidays can be scheduled on request, weekly days off cannot be switched on by the default", () => {
  const r = S.buildDaySchedule({ startKey: "2026-10-10", endKey: "2026-10-12", defaults: DEFAULTS, holidayKeys: MON_HOLIDAY, includeHolidays: true });
  assert.deepEqual(r.days.map((d) => d.working), [false, false, true]);
});

test("with no template weekdays every day is a working day (except holidays)", () => {
  const r = S.buildDaySchedule({ startKey: "2026-10-10", endKey: "2026-10-12", defaults: { startTime: "08:00", endTime: "12:00" }, holidayKeys: MON_HOLIDAY });
  assert.deepEqual(r.days.map((d) => d.working), [true, true, false]);
});

test("regenerating keeps hand-edited days exactly and refreshes the rest", () => {
  const existing = [
    entry({ dayKey: "2026-10-08", startTime: "08:00", endTime: "09:00" }), // not edited: should be replaced
    entry({ dayKey: "2026-10-09", startTime: "10:00", endTime: "14:00", edited: true, note: "short day", breaks: [] }),
    entry({ dayKey: "2026-10-20", edited: true }), // outside the new range
  ];
  const r = S.buildDaySchedule({ startKey: "2026-10-08", endKey: "2026-10-09", defaults: DEFAULTS, existing });
  assert.equal(r.days.length, 2);
  assert.equal(r.days[0].startTime, "09:00", "unedited day follows the new defaults");
  assert.equal(r.days[1].startTime, "10:00");
  assert.equal(r.days[1].note, "short day");
  assert.equal(r.days[1].edited, true);
  assert.deepEqual(r.dropped, ["2026-10-20"]);
});

test("a hand-edited day keeps its own working flag even on a weekly day off", () => {
  const existing = [entry({ dayKey: "2026-10-10", edited: true, working: true })]; // a Saturday switched on by the planner
  const r = S.buildDaySchedule({ startKey: "2026-10-09", endKey: "2026-10-11", defaults: DEFAULTS, existing });
  assert.deepEqual(r.days.map((d) => d.working), [true, true, false]);
  assert.equal(r.days[1].offReason, "weekly_off");
});

test("generated days do not share break objects", () => {
  const r = S.buildDaySchedule({ startKey: "2026-10-08", endKey: "2026-10-09", defaults: DEFAULTS });
  r.days[0].breaks[0].startTime = "11:00";
  assert.equal(r.days[1].breaks[0].startTime, "13:00");
  assert.equal(DEFAULTS.breaks[0].startTime, "13:00");
});

test("buildDaySchedule refuses bad dates, a reversed range, an over-long range and bad default times", () => {
  const build = (over) => S.buildDaySchedule({ startKey: "2026-10-08", endKey: "2026-10-09", defaults: DEFAULTS, ...over });
  assert.deepEqual(codes(build({ startKey: "nonsense" }).problems), ["SCH-004"]);
  assert.deepEqual(codes(build({ endKey: "2026-10-01" }).problems), ["CAL-005"]);
  assert.deepEqual(codes(build({ endKey: "2028-01-01" }).problems), ["SCH-010"]);
  assert.deepEqual(codes(build({ defaults: { startTime: "bad", endTime: "18:00" } }).problems), ["SCH-001"]);
  assert.equal(build({ endKey: "2026-10-01" }).ok, false);
  assert.equal(S.buildDaySchedule({ startKey: "2026-01-01", endKey: "2026-12-31", defaults: DEFAULTS }).days.length, 365, "a full year is allowed");
});

// ---- the SCH checks -------------------------------------------------------------------------

// SCH-007 (missing days) is expected whenever a test lists only a few days of the week, so it is hidden
// unless a test asks for it with { keepMissing: true }.
const validate = (days, { keepMissing = false, ...over } = {}) =>
  S.validateDaySchedule({ days, startKey: "2026-10-12", endKey: "2026-10-16", weekDays: WEEKDAYS, holidayKeys: NO_HOLIDAYS, ...over }).filter((p) => keepMissing || p.code !== "SCH-007");

test("a schedule generated from the defaults has no problems", () => {
  const built = S.buildDaySchedule({ startKey: "2026-10-12", endKey: "2026-10-16", defaults: DEFAULTS });
  assert.deepEqual(validate(built.days), []);
});

test("SCH-001: a working day needs valid times; a day off may be blank", () => {
  assert.deepEqual(codes(validate([entry({ startTime: "" })])), ["SCH-001"]);
  assert.deepEqual(codes(validate([entry({ endTime: "99:99" })])), ["SCH-001"]);
  assert.deepEqual(validate([entry({ startTime: "", endTime: "", working: false })]), []);
});

test("SCH-002: equal times is a 24-hour day (error); beyond the limit is a warning; exactly the limit is fine", () => {
  const equal = validate([entry({ startTime: "09:00", endTime: "09:00" })]);
  assert.deepEqual(equal.map((p) => [p.code, p.severity]), [["SCH-002", "error"]]);
  const long = validate([entry({ startTime: "08:00", endTime: "01:00" })]); // 17 hours
  assert.deepEqual(long.map((p) => [p.code, p.severity]), [["SCH-002", "warning"]]);
  assert.deepEqual(validate([entry({ startTime: "08:00", endTime: "00:00" })]), [], "16 hours is allowed");
  assert.deepEqual(validate([entry({ startTime: "08:00", endTime: "22:00" })], { maxDayHours: 12 }).map((p) => p.code), ["SCH-002"]);
});

test("SCH-003: consecutive days of one plan may touch but not overlap", () => {
  const overlap = validate([entry({ dayKey: "2026-10-12", startTime: "21:00", endTime: "05:00" }), entry({ dayKey: "2026-10-13", startTime: "02:00", endTime: "10:00" })]);
  assert.deepEqual(codes(overlap), ["SCH-003"]);
  assert.equal(overlap[0].otherDayKey, "2026-10-13");
  const touching = validate([entry({ dayKey: "2026-10-12", startTime: "21:00", endTime: "05:00" }), entry({ dayKey: "2026-10-13", startTime: "05:00", endTime: "13:00" })]);
  assert.deepEqual(touching, []);
  assert.deepEqual(codes(validate([entry({ dayKey: "2026-10-12", startTime: "21:00", endTime: "05:00" }), entry({ dayKey: "2026-10-14", startTime: "02:00", endTime: "08:00" })])), [], "a day between them breaks the chain");
});

test("SCH-004: invalid, duplicate and out-of-range days", () => {
  assert.deepEqual(codes(validate([entry({ dayKey: "12/10/2026" })])), ["SCH-004"]);
  assert.deepEqual(codes(validate([entry(), entry()])), ["SCH-004"]);
  assert.deepEqual(codes(validate([entry({ dayKey: "2026-10-20" })])), ["SCH-004"]);
  assert.deepEqual(codes(validate([entry({ dayKey: "2026-10-05" })])), ["SCH-004"]);
});

test("SCH-005: scheduling a holiday or a weekly day off is a warning, not an error", () => {
  const holiday = validate([entry()], { holidayKeys: MON_HOLIDAY });
  assert.deepEqual(holiday.map((p) => [p.code, p.severity, p.reason]), [["SCH-005", "warning", "holiday"]]);
  const weekend = validate([entry({ dayKey: "2026-10-17" })], { endKey: "2026-10-18" });
  assert.deepEqual(weekend.map((p) => [p.code, p.reason]), [["SCH-005", "weekly_off"]]);
  assert.deepEqual(validate([entry({ dayKey: "2026-10-17", working: false })], { endKey: "2026-10-18" }), [], "a day off listed as off is fine");
});

test("SCH-006: breaks outside the day, running past it, overlapping, invalid, or taking all the time", () => {
  assert.match(validate([entry({ breaks: [{ startTime: "18:00", endTime: "18:30" }] })])[0].message, /outside the working hours/);
  assert.match(validate([entry({ breaks: [{ startTime: "16:30", endTime: "17:30" }] })])[0].message, /runs past/);
  assert.match(validate([entry({ breaks: [{ startTime: "12:00", endTime: "13:00" }, { startTime: "12:30", endTime: "13:30" }] })])[0].message, /overlap/);
  assert.match(validate([entry({ breaks: [{ startTime: "", endTime: "13:30" }] })])[0].message, /valid start and end/);
  const allBreak = validate([entry({ breaks: [{ startTime: "09:00", endTime: "17:00" }] })]);
  assert.ok(allBreak.some((p) => /no productive time/.test(p.message)));
  assert.ok(allBreak.every((p) => p.code === "SCH-006" && p.severity === "warning"));
  assert.deepEqual(validate([entry({ breaks: [{ startTime: "12:00", endTime: "13:00" }] })]), []);
});

test("SCH-007: working weekdays missing from the list are reported once, as information", () => {
  const found = validate([entry({ dayKey: "2026-10-12" }), entry({ dayKey: "2026-10-14" })], { keepMissing: true });
  assert.deepEqual(found.map((p) => [p.code, p.severity]), [["SCH-007", "info"]]);
  assert.deepEqual(found[0].dayKeys, ["2026-10-13", "2026-10-15", "2026-10-16"]);
  assert.deepEqual(codes(validate([entry({ dayKey: "2026-10-12" })], { weekDays: null, keepMissing: true })), [], "no calendar, nothing to compare");
});

test("SCH-008: hours that differ from the template shift are summarised in one note", () => {
  const template = S.templateFromShift(DAY_SHIFT);
  const days = [
    entry({ dayKey: "2026-10-12", startTime: "09:00", endTime: "18:00" }),
    entry({ dayKey: "2026-10-13", startTime: "10:00", endTime: "14:00" }),
    entry({ dayKey: "2026-10-14", startTime: "08:00", endTime: "12:00" }),
  ];
  const found = validate(days, { template, weekDays: null });
  assert.deepEqual(found.map((p) => p.code), ["SCH-008"]);
  assert.deepEqual(found[0].dayKeys, ["2026-10-13", "2026-10-14"]);
  assert.deepEqual(validate(days, { weekDays: null }), [], "no template, no comparison");
});
