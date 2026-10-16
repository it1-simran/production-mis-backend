const test = require("node:test");
const assert = require("node:assert/strict");
const { templateHash, calendarHash, computeAllocationHash, stalenessOf } = require("../../services/planning/allocationHash");
const { buildHolidayKeys } = require("../../utils/planDates");
const { DAY_SHIFT, makeDraft, stageEntry } = require("./helpers");

const ID_A = "507f1f77bcf86cd799439011";
const ID_B = "507f1f77bcf86cd799439012";

const calendar = (over = {}) => ({
  startKey: "2026-10-05",
  endKey: "2026-10-09",
  window: { startTime: "09:00", endTime: "18:00" },
  weekDays: DAY_SHIFT.weekDays,
  holidayKeys: new Set(),
  ...over,
});

test("the template hash is stable and ignores production counters", () => {
  const a = makeDraft();
  const b = makeDraft({
    assignedStages: {
      "0-0": [{ ...stageEntry("Visual Inspection", 50), passedDevice: 40, ngDevice: 3, totalUPHA: 37 }],
      "0-1": [{ ...stageEntry("Functional", 40), passedDevice: 11 }],
    },
  });
  assert.equal(templateHash(a), templateHash(makeDraft()));
  assert.equal(templateHash(a), templateHash(b), "running production does not make a plan stale");
});

test("the template hash changes when the pattern changes", () => {
  const base = templateHash(makeDraft());
  assert.notEqual(base, templateHash(makeDraft({ assignedOperators: { "0-0": [{ _id: ID_A }] } })), "operator added");
  assert.notEqual(templateHash(makeDraft({ assignedOperators: { "0-0": [{ _id: ID_A }] } })), templateHash(makeDraft({ assignedOperators: { "0-0": [{ _id: ID_B }] } })), "operator swapped");
  assert.notEqual(base, templateHash(makeDraft({ assignedJigs: { "0-1": [{ _id: ID_A }] } })), "jig added");
  assert.notEqual(base, templateHash(makeDraft({ assignedStages: { "0-0": [stageEntry("Visual Inspection", 50)] } })), "seat removed");
  assert.notEqual(base, templateHash(makeDraft({ assignedStages: { "0-0": [stageEntry("Visual Inspection", 60)], "0-1": [stageEntry("Functional", 40)] } })), "UPHA changed");
  assert.notEqual(base, templateHash(makeDraft({ assignedCustomStagesOp: [[{ _id: ID_A }]] })), "common-stage person added");
});

test("the template hash ignores ordering and duplicates that mean the same thing", () => {
  const a = templateHash(makeDraft({ assignedOperators: { "0-0": [{ _id: ID_A }, { _id: ID_B }] } }));
  const b = templateHash(makeDraft({ assignedOperators: { "0-0": [{ _id: ID_B }, { _id: ID_A }, { _id: ID_A }] } }));
  assert.equal(a, b);
  const keysAB = makeDraft({ assignedStages: { "0-1": [stageEntry("Functional", 40)], "0-0": [stageEntry("Visual Inspection", 50)] } });
  assert.equal(templateHash(keysAB), templateHash(makeDraft()), "seat key order is irrelevant");
});

test("reserved entries and empty seats do not affect the template hash", () => {
  const base = templateHash(makeDraft());
  const noisy = makeDraft({
    assignedStages: {
      "0-0": [stageEntry("Visual Inspection", 50)],
      "0-1": [stageEntry("Functional", 40)],
      "0-2": [{ ...stageEntry("Functional", 40), reserved: true }],
      "0-3": [],
    },
  });
  assert.equal(templateHash(noisy), base);
});

test("the calendar hash reacts to holidays inside the plan's range only", () => {
  const base = calendarHash(calendar());
  assert.equal(base, calendarHash(calendar()));
  assert.notEqual(base, calendarHash(calendar({ holidayKeys: buildHolidayKeys([{ holidayDate: new Date("2026-10-07T00:00:00.000Z") }]) })), "holiday inside the range");
  assert.equal(base, calendarHash(calendar({ holidayKeys: buildHolidayKeys([{ holidayDate: new Date("2026-12-25T00:00:00.000Z") }]) })), "holiday outside the range");
});

test("the calendar hash reacts to the weekdays, the window and the dates", () => {
  const base = calendarHash(calendar());
  assert.notEqual(base, calendarHash(calendar({ weekDays: { ...DAY_SHIFT.weekDays, sat: true } })));
  assert.notEqual(base, calendarHash(calendar({ window: { startTime: "08:00", endTime: "17:00" } })));
  assert.notEqual(base, calendarHash(calendar({ endKey: "2026-10-12" })));
  assert.notEqual(base, calendarHash(calendar({ startKey: "2026-10-06" })));
});

test("staleness: fresh, edited template, changed calendar, and never generated", () => {
  const draft = makeDraft();
  const stored = computeAllocationHash({ draft, calendar: calendar() });
  assert.deepEqual(stalenessOf(stored, computeAllocationHash({ draft, calendar: calendar() })), { stale: false, reason: null });

  const edited = makeDraft({ assignedOperators: { "0-0": [{ _id: ID_A }] } });
  assert.deepEqual(stalenessOf(stored, computeAllocationHash({ draft: edited, calendar: calendar() })), { stale: true, reason: "template" });

  const holiday = calendar({ holidayKeys: buildHolidayKeys([{ holidayDate: new Date("2026-10-07T00:00:00.000Z") }]) });
  assert.deepEqual(stalenessOf(stored, computeAllocationHash({ draft, calendar: holiday })), { stale: true, reason: "calendar" });

  assert.deepEqual(stalenessOf(null, stored), { stale: true, reason: "missing" });
  assert.deepEqual(stalenessOf({}, stored), { stale: true, reason: "missing" });
});
