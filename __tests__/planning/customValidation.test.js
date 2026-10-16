const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlan, collectSeatReservations } = require("../../services/planning/planValidator");
const { plansOverlap } = require("../../services/planning/planOverlap");
const { summarizePlan } = require("../../services/planning/planSummary");
const { rangesOverlap, windowsOverlap, buildWindow, dayNumber } = require("../../utils/planDates");
const { DAY_SHIFT, makeDraft, makeCtx, otherPlan, stageEntry, codes } = require("./helpers");

const NOW = new Date(2026, 9, 1);
const LUNCH = [{ startTime: "13:00", endTime: "14:00" }];
const day = (dayKey, startTime, endTime, over = {}) => ({ dayKey, startTime, endTime, breaks: [], unplacedBreakMinutes: 0, working: true, edited: true, note: "", ...over });

// Mon 5 Oct 09-17 (lunch, 7h), Tue 6 Oct 10-14 (4h), Wed 7 Oct 08-18 (10h)
const WEEK = () => [day("2026-10-05", "09:00", "17:00", { breaks: LUNCH }), day("2026-10-06", "10:00", "14:00"), day("2026-10-07", "08:00", "18:00")];

const custom = (over = {}) => makeDraft({ scheduleMode: "custom", daySchedule: WEEK(), plannedEndDate: "07/10/26 00:00:00", ...over });
const validate = (draft, ctx = makeCtx({ shift: null })) => validatePlan(draft, ctx, { now: NOW });

test("a custom plan needs no shift, and its numbers come from the days", () => {
  const r = validate(custom());
  assert.equal(r.valid, true, JSON.stringify(r.issues));
  assert.ok(!codes(r).includes("STRUCT-002"));
  assert.equal(r.computed.scheduleMode, "custom");
  assert.deepEqual(r.computed.days.map((d) => [d.dayKey, d.productiveMinutes, d.plannedUnits]), [
    ["2026-10-05", 420, 280],
    ["2026-10-06", 240, 160],
    ["2026-10-07", 600, 400],
  ]);
  assert.equal(r.computed.startKey, "2026-10-05");
  assert.equal(r.computed.endKey, "2026-10-07");
  assert.equal(r.computed.estimatedEndDate, "07/10/26 00:00:00");
  assert.equal(r.computed.unitsPerDay, 280, "average of 280, 160 and 400");
  assert.equal(r.computed.totalUPHA, "280.00");
});

test("a schedule that is too short for the quantity reports the exact shortfall (DAY-002), not the shift-plan checks", () => {
  const r = validate(custom());
  const short = r.issues.find((i) => i.code === "DAY-002");
  assert.ok(short);
  assert.equal(short.shortfallUnits, 160);
  assert.equal(r.computed.shortfallUnits, 160);
  assert.ok(!codes(r).some((c) => ["CAP-004", "CAL-005", "CAL-006", "CAL-007", "SHIFT-002"].includes(c)));
});

test("a long enough schedule has no shortfall and finishes when the quantity is covered", () => {
  const list = [...WEEK(), day("2026-10-08", "09:00", "17:00", { breaks: LUNCH })];
  const r = validate(custom({ daySchedule: list, plannedEndDate: "08/10/26 00:00:00" }));
  assert.equal(r.computed.shortfallUnits, 0);
  assert.ok(!codes(r).includes("DAY-002"));
  assert.equal(r.computed.forecastEndKey, "2026-10-08");
  assert.equal(r.computed.capacityEndKey, "2026-10-08");
});

test("schedule errors become validation errors", () => {
  assert.ok(codes(validate(custom({ daySchedule: [day("2026-10-05", "bad", "17:00")] }))).includes("SCH-001"));
  const overlap = validate(custom({ daySchedule: [day("2026-10-05", "21:00", "05:00"), day("2026-10-06", "02:00", "08:00")] }));
  assert.ok(codes(overlap).includes("SCH-003"));
  assert.equal(overlap.valid, false);
  const none = validate(custom({ daySchedule: [], plannedEndDate: undefined }));
  assert.equal(none.valid, false);
  assert.ok(codes(none).includes("CAL-004"));
  assert.equal(none.computed.days.length, 0);
});

test("a missing start date is reported once, not once by each rule group", () => {
  const r = validate(custom({ startDate: "" }));
  assert.equal(r.issues.filter((i) => i.code === "CAL-004" && /Start date/.test(i.message)).length, 1);
});

test("with a template shift, weekly days off are warned about and the hours are compared", () => {
  const ctx = makeCtx({ shift: DAY_SHIFT });
  const r = validate(custom({ daySchedule: [...WEEK(), day("2026-10-10", "09:00", "17:00")], plannedEndDate: "10/10/26 00:00:00" }), ctx);
  assert.ok(codes(r).includes("SCH-005"), "Saturday is a day off for the template");
  assert.ok(codes(r).includes("SCH-008"), "hours differ from the template");
  assert.equal(r.valid, true);
});

test("overtime already on the plan being edited adds to that day's output", () => {
  const existingPlan = { isDrafted: 0, overtimeWindows: [{ from: new Date(2026, 9, 6, 14, 0), to: new Date(2026, 9, 6, 16, 0), active: true }] };
  const r = validate(custom(), makeCtx({ shift: null, existingPlan }));
  assert.equal(r.computed.days[1].capacityUnits, 240, "4 hours + 2 hours overtime = 6 hours at 40/h");
});

test("shift plans are unchanged: a missing shift is still an error and the shift rules still run", () => {
  const r = validatePlan(makeDraft(), makeCtx({ shift: null }), { now: NOW });
  assert.ok(codes(r).includes("STRUCT-002"));
  assert.equal(validatePlan(makeDraft(), makeCtx(), { now: NOW }).computed.scheduleMode, undefined);
});

// ---- conflicts between plans -----------------------------------------------------------------

const shiftPlan = (over = {}) => otherPlan({ seats: { "0-0": "Visual Inspection" }, start: "05/10/26", end: "09/10/26", ...over }); // 09:00-18:00 every day
const ctxWith = (plans) => makeCtx({ shift: null, otherPlans: plans });

test("a custom day outside another plan's hours does not clash with it, one inside does", () => {
  const outside = custom({ daySchedule: [day("2026-10-05", "05:00", "08:00"), day("2026-10-06", "19:00", "23:00")], plannedEndDate: "06/10/26 00:00:00" });
  assert.ok(!codes(validate(outside, ctxWith([shiftPlan()]))).includes("SEAT-001"), "before and after the other plan's 09:00-18:00");
  const inside = custom({ daySchedule: [day("2026-10-05", "05:00", "08:00"), day("2026-10-06", "10:00", "14:00")], plannedEndDate: "06/10/26 00:00:00" });
  assert.ok(codes(validate(inside, ctxWith([shiftPlan()]))).includes("SEAT-001"), "Tuesday 10:00-14:00 is inside it");
});

test("a custom day on a date the other plan does not run does not clash", () => {
  const later = custom({ daySchedule: [day("2026-10-12", "10:00", "14:00")], startDate: "12/10/26 00:00:00", plannedEndDate: "12/10/26 00:00:00" });
  assert.ok(!codes(validate(later, ctxWith([shiftPlan()]))).includes("SEAT-001"));
});

test("two custom plans are compared day by day", () => {
  const other = summarizePlan({
    _id: "plan-c",
    selectedProcess: "proc-c",
    selectedRoom: "room-1",
    isDrafted: 0,
    startDate: "05/10/26 00:00:00",
    estimatedEndDate: "07/10/26 00:00:00",
    scheduleMode: "custom",
    daySchedule: [day("2026-10-05", "09:00", "12:00"), day("2026-10-07", "09:00", "12:00")],
    ProcessShiftMappings: { startTime: "09:00", endTime: "12:00" },
    assignedStages: JSON.stringify({ "0-0": [stageEntry("Visual Inspection", 50)] }),
    assignedOperators: "{}",
    assignedJigs: "{}",
    assignedCustomStagesOp: "[]",
  });
  assert.equal(other.custom, true);
  assert.equal(other.dayWindows.length, 2);
  const tuesday = custom({ daySchedule: [day("2026-10-06", "09:00", "12:00")], startDate: "06/10/26 00:00:00", plannedEndDate: "06/10/26 00:00:00" });
  assert.ok(!codes(validate(tuesday, ctxWith([{ ...other, processName: "Other" }]))).includes("SEAT-001"), "the other plan has no Tuesday");
  const wednesday = custom({ daySchedule: [day("2026-10-07", "11:00", "15:00")], startDate: "07/10/26 00:00:00", plannedEndDate: "07/10/26 00:00:00" });
  assert.ok(codes(validate(wednesday, ctxWith([{ ...other, processName: "Other" }]))).includes("SEAT-001"));
});

test("seat reservations for a custom draft respect each day's hours", () => {
  const r = validate(custom({ daySchedule: [day("2026-10-06", "19:00", "23:00")], startDate: "06/10/26 00:00:00", plannedEndDate: "06/10/26 00:00:00" }), ctxWith([shiftPlan()]));
  const ctx = ctxWith([shiftPlan()]);
  assert.equal(collectSeatReservations("room-1", r._computed, ctx).length, 0, "evening day: the seat is free");
  const day2 = validate(custom({ daySchedule: [day("2026-10-06", "10:00", "14:00")], startDate: "06/10/26 00:00:00", plannedEndDate: "06/10/26 00:00:00" }), ctx);
  assert.equal(collectSeatReservations("room-1", day2._computed, ctx).length, 1, "daytime: the seat is held");
});

// ---- plansOverlap ----------------------------------------------------------------------------

const shiftSide = (startKey, endKey, startTime, endTime) => ({ custom: false, startDay: dayNumber(startKey), endDay: dayNumber(endKey), window: buildWindow(startTime, endTime) });
const customSide = (entries) => ({
  custom: true,
  dayWindows: entries.map(([key, s, e]) => {
    const w = buildWindow(s, e);
    const base = dayNumber(key) * 1440;
    return { absStart: base + w.start, absEnd: base + w.end, start: w.start, end: w.end };
  }),
});

test("plansOverlap is exactly the old test when neither plan is custom", () => {
  const cases = [
    ["2026-10-05", "2026-10-09", "09:00", "18:00", "2026-10-09", "2026-10-12", "10:00", "12:00"],
    ["2026-10-05", "2026-10-09", "09:00", "18:00", "2026-10-10", "2026-10-12", "10:00", "12:00"],
    ["2026-10-05", "2026-10-09", "09:00", "18:00", "2026-10-06", "2026-10-07", "19:00", "23:00"],
    ["2026-10-05", "2026-10-09", "21:00", "05:00", "2026-10-05", "2026-10-09", "03:00", "08:00"],
    ["2026-10-05", "2026-10-09", "09:00", "18:00", "2026-10-05", "2026-10-09", "18:00", "20:00"],
  ];
  cases.forEach(([s1, e1, a1, b1, s2, e2, a2, b2]) => {
    const a = shiftSide(s1, e1, a1, b1);
    const b = shiftSide(s2, e2, a2, b2);
    const old = rangesOverlap(a.startDay, a.endDay, b.startDay, b.endDay) && windowsOverlap(a.window, b.window);
    assert.equal(plansOverlap(a, b), old, `${s1}..${e1} ${a1}-${b1} vs ${s2}..${e2} ${a2}-${b2}`);
    assert.equal(plansOverlap(a, b, { ignoreRange: true }), windowsOverlap(a.window, b.window));
  });
});

test("custom days: touching windows do not clash, overlapping ones do, overnight spill is caught", () => {
  const shift = shiftSide("2026-10-05", "2026-10-09", "09:00", "18:00");
  assert.equal(plansOverlap(customSide([["2026-10-06", "18:00", "20:00"]]), shift), false, "starts when the other ends");
  assert.equal(plansOverlap(customSide([["2026-10-06", "17:59", "20:00"]]), shift), true);
  const night = customSide([["2026-10-06", "21:00", "05:00"]]); // runs into Wednesday morning
  assert.equal(plansOverlap(night, customSide([["2026-10-07", "03:00", "06:00"]])), true, "Tuesday night overlaps Wednesday 03:00");
  assert.equal(plansOverlap(night, customSide([["2026-10-07", "05:00", "08:00"]])), false);
  assert.equal(plansOverlap(customSide([]), shift), false, "a plan with no days clashes with nothing");
});

test("an overrun plan (already ended) is compared by time of day only", () => {
  const ended = shiftSide("2026-09-01", "2026-09-05", "09:00", "18:00");
  assert.equal(plansOverlap(customSide([["2026-10-06", "10:00", "14:00"]]), ended, { ignoreRange: true }), true);
  assert.equal(plansOverlap(customSide([["2026-10-06", "19:00", "23:00"]]), ended, { ignoreRange: true }), false);
});
