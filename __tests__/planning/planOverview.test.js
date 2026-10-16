const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeActuals, loadActualsPerPlan } = require("../../services/planning/planActuals");
const { buildOverview, buildBoardPlan, boardSummary, mergeDayFigures, achievedUph, elapsedMinutesToday, progressOf, lastStageName } = require("../../services/planning/planOverview");
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

test("the planned total is added up from the unrounded daily targets, not from the rounded days", () => {
  // 40.4 units an hour over an 8 hour day is 323.2 a day: each day shows 323, and rounding first would lose a unit
  const process = { ...PROCESS, stages: [PROCESS.stages[0], { ...PROCESS.stages[1], upha: "40.4" }] };
  const o = overview({ process, todayKey: "2026-10-09", actuals: actualsOf([["2026-10-06", "Functional", "Pass", 550], ["2026-10-07", "Functional", "Pass", 550]]) });
  assert.deepEqual(o.days.map((d) => d.plannedUnits), [0, 323, 323, 323, 30], "each day is rounded for display");
  assert.equal(o.totals.planned, 1000, "the total is not 999");
  assert.equal(o.days[4].cumulativePlanned, 1000);
  assert.match(o.progress.detail, /^130 units ahead/, "the plan through yesterday is 970, not 969");
});

test("a board row summary carries the plan's totals and the overview's progress chip, and no progress for a draft", () => {
  const actuals = actualsOf([["2026-10-06", "Functional", "Pass", 310], ["2026-10-07", "Functional", "Pass", 330]]);
  const args = { plan: shiftPlan(), process: PROCESS, shift: DAY_SHIFT, holidayKeys: NO_HOLIDAYS, actuals, todayKey: "2026-10-08" };
  const s = boardSummary(args);
  assert.deepEqual([s.quantity, s.plannedTotal, s.finishedTotal], [1000, 1000, 640]);
  assert.equal(s.shiftName, "Day");
  assert.deepEqual(s.progress, (({ state, label, detail }) => ({ state, label, detail }))(overview({ actuals }).progress), "the same chip as the overview");
  assert.equal(boardSummary({ ...args, plan: shiftPlan({ isDrafted: 1 }) }).progress, null);
});

test("whole-history actuals are loaded one plan at a time, a few at once, and merged", async () => {
  let running = 0;
  let peak = 0;
  const asked = [];
  const load = async ({ planIds }) => {
    asked.push(planIds);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return new Map(planIds.map((id) => [id, { totals: { finished: Number(id.slice(1)) } }]));
  };
  const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  const out = await loadActualsPerPlan({ planIds: ids, lastStageByPlan: new Map(), concurrency: 3, load });
  assert.deepEqual(asked.map((a) => a.length), ids.map(() => 1), "never more than one plan per query");
  assert.ok(peak > 1 && peak <= 3, `at most 3 queries at once (saw ${peak})`);
  assert.deepEqual([...out.keys()].sort(), ids);
  assert.equal(out.get("p6").totals.finished, 6);
  assert.equal((await loadActualsPerPlan({ planIds: [], lastStageByPlan: new Map(), load })).size, 0, "nothing to load");
});

test("each overview day carries the rate it is planned at and the minutes that rate applies to", () => {
  const o = overview();
  assert.deepEqual(o.days.map((d) => d.targetUph), [40, 40, 40, 40, 40], "the line runs at its slowest stage, Functional at 40 an hour");
  assert.deepEqual(o.days.map((d) => d.capacityMinutes), [480, 480, 480, 480, 480], "8 productive hours: 9 to 6 less the lunch hour");
});

test("achieved UPH needs half an hour of work time and is null for a coming day", () => {
  const base = { finished: 100, capacityMinutes: 480, todayKey: "2026-10-08" };
  assert.equal(achievedUph({ ...base, dayKey: "2026-10-07" }), 12.5, "a finished day is judged over its whole 8 hours");
  assert.equal(achievedUph({ ...base, dayKey: "2026-10-09" }), null, "a coming day");
  assert.equal(achievedUph({ ...base, dayKey: "2026-10-08", elapsedMinutes: 20 }), null, "twenty minutes in is too early to judge");
  assert.equal(achievedUph({ ...base, dayKey: "2026-10-08", elapsedMinutes: 120 }), 50, "today is judged over the hours gone");
  assert.equal(achievedUph({ ...base, dayKey: "2026-10-08", elapsedMinutes: null }), null);
  assert.equal(achievedUph({ ...base, dayKey: "2026-10-07", capacityMinutes: 0 }), null, "a day with no work time");
});

test("the hours gone today are read on the plant's clock, capped at the day's capacity, and unknown across midnight", () => {
  const day = { startTime: "09:00", endTime: "18:00", capacityMinutes: 480 };
  assert.equal(elapsedMinutesToday(day, new Date("2026-10-08T04:30:00Z")), 60, "10:00 in Asia/Kolkata is an hour into the 09:00 shift");
  assert.equal(elapsedMinutesToday(day, new Date("2026-10-08T02:00:00Z")), 0, "07:30, before the shift");
  assert.equal(elapsedMinutesToday(day, new Date("2026-10-08T14:00:00Z")), 480, "19:30, after the shift: all of the capacity, not the 540 clock minutes");
  assert.equal(elapsedMinutesToday({ startTime: "21:00", endTime: "05:00", capacityMinutes: 480 }, new Date("2026-10-08T04:30:00Z")), null, "a night shift");
});

test("the board summary carries each day's target rate, the rate achieved and the running totals, and a row can take them in", () => {
  const actuals = actualsOf([["2026-10-06", "Functional", "Pass", 310], ["2026-10-07", "Functional", "Pass", 330]]);
  const now = new Date("2026-10-08T04:30:00Z"); // 10:00 at the plant, an hour into the shift
  const s = boardSummary({ plan: shiftPlan(), process: PROCESS, shift: DAY_SHIFT, holidayKeys: NO_HOLIDAYS, actuals, todayKey: "2026-10-08", now });
  const f = s.dayFigures;
  assert.deepEqual(Object.keys(f), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.equal(f["2026-10-05"].targetUph, null, "no target on the set-up day");
  assert.deepEqual([f["2026-10-06"].targetUph, f["2026-10-06"].achievedUph], [40, 38.8], "310 in 8 hours");
  assert.deepEqual([f["2026-10-07"].achievedUph, f["2026-10-07"].completedToDate], [41.3, 640]);
  assert.deepEqual([f["2026-10-08"].achievedUph, f["2026-10-08"].uphSoFar], [0, true], "today: nothing finished in the first hour");
  assert.deepEqual([f["2026-10-09"].achievedUph, f["2026-10-09"].uphSoFar], [null, false], "a coming day");
  const row = buildBoardPlan({ plan: shiftPlan(), process: PROCESS, shift: DAY_SHIFT, holidayKeys: NO_HOLIDAYS, actuals, fromKey: "2026-10-06", toKey: "2026-10-07", todayKey: "2026-10-08" });
  const merged = mergeDayFigures(row, f);
  assert.deepEqual(merged.days.map((d) => [d.dayKey, d.finished, d.achievedUph, d.completedToDate]), [["2026-10-06", 310, 38.8, 310], ["2026-10-07", 330, 41.3, 640]]);
  assert.equal(merged.planId, row.planId, "the rest of the row is untouched");
  assert.deepEqual(mergeDayFigures(row, undefined).days, row.days, "with no figures the days are as they were");
});

test("progressOf handles an empty schedule", () => {
  assert.equal(progressOf({ days: [], todayKey: "2026-10-08", processStatus: "active", quantity: 100, finishedTotal: 0 }).state, "unknown");
});
