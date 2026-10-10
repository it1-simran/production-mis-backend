const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeActuals } = require("../../services/planning/planActuals");
const { buildOverview, buildBoardPlan, progressOf, lastStageName } = require("../../services/planning/planOverview");
const { buildHolidayKeys } = require("../../utils/planDates");
const { DAY_SHIFT, PROCESS, stageEntry } = require("./helpers");

const PLAN_ID = "plan-1";
const NO_HOLIDAYS = buildHolidayKeys([]);

// Mon 5 Oct to Fri 9 Oct 2026; Visual 50/h on seat 0-0 and Functional 40/h on seat 0-1 (the last stage); quantity 1000
const shiftPlan = (over = {}) => ({
  _id: PLAN_ID,
  processName: "AIS140",
  selectedProcess: "proc-1",
  selectedRoom: "room-1",
  selectedShift: "shift-day",
  isDrafted: 0,
  startDate: new Date(2026, 9, 5),
  estimatedEndDate: new Date(2026, 9, 9),
  ProcessShiftMappings: { startTime: "09:00", endTime: "18:00" },
  assignedStages: JSON.stringify({ "0-0": [{ ...stageEntry("Visual Inspection", 50), passedDevice: 30, ngDevice: 1 }], "0-1": [stageEntry("Functional", 40)] }),
  assignedOperators: JSON.stringify({ "0-0": [{ _id: "u1", name: "Asha Rao" }] }),
  assignedJigs: "{}",
  assignedCustomStagesOp: "[]",
  ...over,
});
const last = lastStageName(PROCESS);
const rows = (list) => list.map(([day, stage, status, n]) => ({ _id: { plan: PLAN_ID, day, stage, status }, n }));
const actualsOf = (list) => summarizeActuals(rows(list), new Map([[PLAN_ID, last]])).get(PLAN_ID);
const overview = (over = {}) =>
  buildOverview({ plan: shiftPlan(), process: PROCESS, room: null, shift: DAY_SHIFT, holidayKeys: NO_HOLIDAYS, actuals: undefined, todayKey: "2026-10-08", ...over });

test("the last stage of a process is the one that counts as finished", () => {
  assert.equal(last, "Functional");
  assert.equal(lastStageName({ stages: [] }), "");
  assert.equal(lastStageName(null), "");
});

test("summarizeActuals counts passes and failures per day, and finished means the last stage", () => {
  const a = actualsOf([
    ["2026-10-06", "Visual Inspection", "Pass", 40],
    ["2026-10-06", "Functional", "Pass", 25],
    ["2026-10-06", "functional", "pass", 5], // case does not matter
    ["2026-10-06", "Functional", "NG", 2],
    ["2026-10-06", "Functional", "Resolved", 9], // not output
    ["2026-10-07", "Functional", "Pass", 300],
  ]);
  assert.deepEqual(a.byDay.get("2026-10-06"), { finished: 30, passedAny: 70, failed: 2 });
  assert.deepEqual(a.byDay.get("2026-10-07"), { finished: 300, passedAny: 300, failed: 0 });
  assert.deepEqual(a.totals, { finished: 330, passedAny: 370, failed: 2 });
  assert.equal(a.firstKey, "2026-10-06");
  assert.equal(a.lastKey, "2026-10-07");
  assert.deepEqual(a.byStage.get("functional"), { name: "Functional", passed: 330, failed: 2 });
  assert.equal(summarizeActuals([], new Map()).size, 0);
  assert.equal(summarizeActuals(rows([["", "Functional", "Pass", 5], ["2026-10-06", "Functional", "Pass", 0]]), new Map()).size, 0, "rows without a day or a count are ignored");
});

test("the overview lists each scheduled day with its planned output and what was actually finished", () => {
  const o = overview({ actuals: actualsOf([["2026-10-06", "Functional", "Pass", 310], ["2026-10-07", "Functional", "Pass", 330], ["2026-10-07", "Functional", "NG", 4]]) });
  assert.deepEqual(o.days.map((d) => d.dayKey), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.deepEqual(o.days.map((d) => d.plannedUnits), [0, 320, 320, 320, 40], "Monday is the set-up day; 1000 units finish on Friday");
  assert.deepEqual(o.days.map((d) => d.finished), [0, 310, 330, 0, 0]);
  assert.deepEqual(o.days.map((d) => d.cumulativePlanned), [0, 320, 640, 960, 1000]);
  assert.deepEqual(o.days.map((d) => d.cumulativeFinished), [0, 310, 640, 640, 640]);
  assert.deepEqual(o.days.map((d) => d.state), ["past", "past", "past", "today", "upcoming"]);
  assert.equal(o.days[0].setupDay, true);
  assert.equal(o.days[2].failed, 4);
  assert.equal(o.days[1].startTime, "09:00");
  assert.equal(o.days[1].productiveMinutes, 480);
  assert.deepEqual([o.totals.quantity, o.totals.planned, o.totals.finished, o.totals.remaining, o.totals.failed], [1000, 1000, 640, 360, 4]);
  assert.equal(o.totals.firstActivityKey, "2026-10-06");
  assert.equal(o.plan.mode, "shift");
  assert.equal(o.plan.startKey, "2026-10-05");
  assert.equal(o.plan.endKey, "2026-10-09");
  assert.equal(o.process.lastStage, "Functional");
});

test("progress is judged on output through yesterday against the plan through yesterday", () => {
  const through = (finishedEachDay) => overview({ actuals: actualsOf([["2026-10-06", "Functional", "Pass", finishedEachDay], ["2026-10-07", "Functional", "Pass", finishedEachDay]]) }).progress;
  // the plan through yesterday (Wednesday) is 0 + 320 + 320 = 640
  assert.equal(through(340).state, "ahead", "680 against 640");
  assert.equal(through(320).state, "on_track");
  assert.equal(through(280).state, "on_track", "560 is within the usual build-up");
  const behind = through(100);
  assert.equal(behind.state, "behind");
  assert.match(behind.detail, /440 units behind/);
  assert.equal(overview({ todayKey: "2026-10-01" }).progress.state, "not_started");
  assert.equal(overview({ todayKey: "2026-10-05" }).progress.state, "on_track", "nothing planned before the first full day");
  assert.equal(overview({ process: { ...PROCESS, status: "completed" } }).progress.state, "completed");
});

test("work done outside the scheduled days is shown separately", () => {
  const o = overview({ actuals: actualsOf([["2026-10-10", "Functional", "Pass", 50], ["2026-10-06", "Functional", "Pass", 10]]) });
  assert.deepEqual(o.outside, [{ dayKey: "2026-10-10", finished: 50, passedAny: 50, failed: 0 }]);
  assert.equal(o.totals.finished, 60, "it still counts towards the total");
});

test("per-stage figures combine the seats on the plan with what each stage has passed", () => {
  const o = overview({ actuals: actualsOf([["2026-10-06", "Visual Inspection", "Pass", 40], ["2026-10-06", "Functional", "Pass", 25], ["2026-10-06", "Visual Inspection", "NG", 3]]) });
  assert.deepEqual(o.stages, [
    { name: "Visual Inspection", upha: 50, seats: 1, passed: 40, failed: 3 },
    { name: "Functional", upha: 40, seats: 1, passed: 25, failed: 0 },
  ]);
  assert.deepEqual(o.seats.counters, { "0-0": { passed: 30, failed: 1 }, "0-1": { passed: 0, failed: 0 } });
  assert.equal(o.seats.operators["0-0"][0].name, "Asha Rao");
});

test("a custom-schedule plan shows its own hours, and a plan with no schedule says so", () => {
  const custom = overview({
    plan: shiftPlan({
      scheduleMode: "custom",
      selectedShift: "",
      startDate: new Date(2026, 9, 5),
      estimatedEndDate: new Date(2026, 9, 7),
      plannedEndDate: new Date(2026, 9, 7),
      daySchedule: [
        { dayKey: "2026-10-05", startTime: "09:00", endTime: "17:00", breaks: [{ startTime: "13:00", endTime: "14:00" }], working: true },
        { dayKey: "2026-10-06", startTime: "10:00", endTime: "14:00", breaks: [], working: true },
        { dayKey: "2026-10-07", startTime: "08:00", endTime: "18:00", breaks: [], working: true },
      ],
    }),
    shift: null,
  });
  assert.equal(custom.plan.mode, "custom");
  assert.deepEqual(custom.days.map((d) => [d.startTime, d.endTime, d.productiveMinutes, d.plannedUnits]), [["09:00", "17:00", 420, 280], ["10:00", "14:00", 240, 160], ["08:00", "18:00", 600, 400]]);
  assert.equal(custom.days[0].setupDay, false, "every day of a custom schedule produces");
  assert.equal(custom.plan.shiftName, "Custom schedule");

  const none = overview({ plan: shiftPlan({ estimatedEndDate: null }) });
  assert.deepEqual(none.days, []);
  assert.equal(none.progress.state, "unknown");
  assert.ok(none.problems.some((p) => p.code === "DAY-008"));
});

test("the board row keeps only the days inside the window, with planned and actual output and the seats used", () => {
  const row = buildBoardPlan({
    plan: shiftPlan(),
    process: PROCESS,
    shift: DAY_SHIFT,
    holidayKeys: NO_HOLIDAYS,
    actuals: actualsOf([["2026-10-06", "Functional", "Pass", 310], ["2026-10-10", "Functional", "Pass", 20], ["2026-10-04", "Functional", "Pass", 7]]),
    fromKey: "2026-10-06",
    toKey: "2026-10-10",
    todayKey: "2026-10-08",
  });
  assert.deepEqual(row.days.map((d) => [d.dayKey, d.plannedUnits, d.finished]), [["2026-10-06", 320, 310], ["2026-10-07", 320, 0], ["2026-10-08", 320, 0], ["2026-10-09", 40, 0]]);
  assert.deepEqual(row.seatKeys.sort(), ["0-0", "0-1"]);
  assert.deepEqual(row.extraDays, [{ dayKey: "2026-10-10", finished: 20, passedAny: 20, failed: 0 }], "work on a day off, inside the window");
  assert.equal(row.scheduled, true);
  assert.equal(row.mode, "shift");
  const unscheduled = buildBoardPlan({ plan: shiftPlan({ estimatedEndDate: null }), process: PROCESS, shift: DAY_SHIFT, holidayKeys: NO_HOLIDAYS, fromKey: "2026-10-05", toKey: "2026-10-09", todayKey: "2026-10-08" });
  assert.equal(unscheduled.scheduled, false);
  assert.deepEqual(unscheduled.days, []);
});

test("progressOf handles an empty schedule", () => {
  assert.equal(progressOf({ days: [], todayKey: "2026-10-08", processStatus: "active", quantity: 100, finishedTotal: 0 }).state, "unknown");
});
