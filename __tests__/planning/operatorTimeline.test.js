const test = require("node:test");
const assert = require("node:assert/strict");
const svc = require("../../services/planInsightsService");
const { buildOperatorTimeline, attemptSpan, union, subtract, intersect } = require("../../services/planning/operatorTimeline");

// midnight of 7 Oct 2026 in plant time (Asia/Kolkata, UTC+5:30)
const DAY = Date.UTC(2026, 9, 6, 18, 30);
const t = (h, m = 0) => DAY + (h * 60 + m) * 60000;
const WINDOW = { startTime: "09:00", endTime: "18:00" };
const LOOKUP = svc.buildStageAliasLookup({ processStages: [{ stageName: "Visual Inspection" }, { stageName: "Functional" }], commonStages: [] });
const NAMES = new Map([["op1", { name: "Asha Rao", employeeCode: "E1" }], ["op2", { name: "Bala K", employeeCode: "E2" }]]);

let seq = 0;
const attempt = (operatorId, from, to, extra = {}) => ({ _id: `r${++seq}`, operatorId, deviceId: `d${seq}`, serialNo: `S${seq}`, stageName: "Visual Inspection", status: "Pass", startTime: new Date(from), endTime: new Date(to), testDurationMs: to - from, createdAt: new Date(to), ...extra });
const session = (operatorId, from, to, extra = {}) => ({ operatorId, startedAt: new Date(from), endedAt: to === null ? null : new Date(to), breaks: [], ...extra });
const build = (over = {}) => buildOperatorTimeline({ dayStartMs: DAY, window: WINDOW, breaks: [], names: NAMES, aliasLookup: LOOKUP, ...over });
const one = (over) => build(over).operators[0];
const kinds = (op, type) => op.segments.filter((s) => s.type === type).map((s) => [s.startMin, s.endMin]);
const mins = (ms) => ms / 60000;

test("interval helpers: union, subtract and intersect", () => {
  assert.deepEqual(union([[5, 9], [1, 3], [2, 4], [9, 10]]), [[1, 4], [5, 10]]);
  assert.deepEqual(subtract([[0, 10]], [[2, 4], [6, 7]]), [[0, 2], [4, 6], [7, 10]]);
  assert.deepEqual(intersect([[0, 5], [8, 12]], [[3, 9]]), [[3, 5], [8, 9]]);
  assert.deepEqual(subtract([[0, 10]], [[0, 10]]), []);
});

test("an attempt's span is its recorded start and end, unless the start contradicts the timer", () => {
  assert.deepEqual(attemptSpan({ startTime: new Date(1000), endTime: new Date(61000), testDurationMs: 60000 }), [1000, 61000]);
  assert.deepEqual(attemptSpan({ startTime: new Date(1000), endTime: new Date(3600000), testDurationMs: 60000 }), [3540000, 3600000], "an hour-long span for a one-minute timer");
  assert.deepEqual(attemptSpan({ endTime: new Date(61000), testDurationMs: 60000 }), [1000, 61000], "no start: end minus the timer");
  assert.deepEqual(attemptSpan({ createdAt: new Date(5000) }), [5000, 5000], "no start and no timer is a point");
  assert.equal(attemptSpan({}), null);
});

test("overlapping attempts are merged so time is never counted twice", () => {
  const op = one({ records: [attempt("op1", t(9), t(9, 10)), attempt("op1", t(9, 5), t(9, 15))] });
  assert.deepEqual(kinds(op, "test"), [[540, 555]]);
  assert.equal(mins(op.totals.testMs), 15);
  assert.equal(op.totals.devices, 2);
  assert.equal(op.segments[0].devices, 2);
});

test("with no session the day is judged from the first test to the last, and the gap between is idle", () => {
  const op = one({ records: [attempt("op1", t(9), t(9, 10)), attempt("op1", t(9, 50), t(10))] });
  assert.equal(mins(op.totals.presentMs), 60);
  assert.deepEqual(kinds(op, "long_idle"), [[550, 590]], "40 minutes is long idle");
  assert.equal(mins(op.totals.longIdleMs), 40);
  assert.equal(op.totals.utilisationPct, 33.3);
  assert.equal(op.milestones.login, null);
  assert.equal(op.milestones.firstDevice, new Date(t(9)).toISOString());
  assert.equal(op.milestones.lastDevice, new Date(t(10)).toISOString());
});

test("planned breaks are not idle: lunch is shown as a break and left out of the working time", () => {
  const op = one({ breaks: [{ startTime: "13:00", endTime: "14:00" }], records: [attempt("op1", t(12, 30), t(12, 50)), attempt("op1", t(14, 20), t(14, 40))] });
  assert.deepEqual(kinds(op, "break"), [[780, 840]]);
  assert.deepEqual(kinds(op, "idle"), [[770, 780], [840, 860]], "10 minutes before lunch and 20 after, both short");
  assert.equal(mins(op.totals.breakMs), 60);
  assert.equal(mins(op.totals.idleMs), 30);
  assert.equal(mins(op.totals.longIdleMs), 0);
  // working time = present (130) - break (60) = 70; tests = 40
  assert.equal(op.totals.utilisationPct, 57.1);
});

test("a work session makes the operator present from login to logout, so waiting before the first device is idle", () => {
  const op = one({ sessions: [session("op1", t(9), t(12))], records: [attempt("op1", t(9, 30), t(9, 40))] });
  assert.deepEqual(kinds(op, "long_idle"), [[540, 570], [580, 720]]);
  assert.equal(mins(op.totals.presentMs), 180);
  assert.equal(op.milestones.login, new Date(t(9)).toISOString());
  assert.equal(op.milestones.logout, new Date(t(12)).toISOString());
  assert.equal(op.milestones.stillLoggedIn, false);
  assert.equal(op.totals.utilisationPct, 5.6);
});

test("idle the operator explained is shown with its reason and kept apart from unexplained idle, and a test wins where they overlap", () => {
  const op = one({
    sessions: [session("op1", t(9), t(12))],
    records: [attempt("op1", t(9, 30), t(9, 40))],
    idleLogs: [
      { operatorId: "op1", idleStartTime: new Date(t(10)), idleEndTime: new Date(t(10, 20)), reasonLabel: "Machine Breakdown", reasonCode: "MACHINE_BREAKDOWN", category: "DOWNTIME", remarks: "jig stuck" },
      { operatorId: "op1", idleStartTime: new Date(t(9, 35)), idleEndTime: new Date(t(9, 45)), reasonLabel: "Tea Break", reasonCode: "TEA_BREAK", category: "BREAK" },
    ],
  });
  const logged = op.segments.filter((s) => s.type === "logged_idle");
  assert.deepEqual(logged.map((s) => [s.startMin, s.endMin, s.reason, s.category]), [[580, 585, "Tea Break", "BREAK"], [600, 620, "Machine Breakdown", "DOWNTIME"]], "the tea break loses the minutes the operator was testing");
  assert.equal(logged[1].remarks, "jig stuck");
  assert.equal(mins(op.totals.loggedDowntimeMs), 20);
  assert.equal(mins(op.totals.breakMs), 5, "a logged BREAK counts with the breaks");
  assert.deepEqual(op.reasons.map((r) => [r.reason, r.category, mins(r.ms), r.count]), [["Machine Breakdown", "DOWNTIME", 20, 1], ["Tea Break", "BREAK", 5, 1]]);
  // 180 present = 10 test + 5 tea + 20 breakdown + idle; the explained time is not counted as unexplained idle
  assert.equal(mins(op.totals.idleMs + op.totals.longIdleMs), 180 - 10 - 5 - 20);
});

test("the breaks an operator took in their session are shown as breaks", () => {
  const op = one({ sessions: [session("op1", t(9), t(12), { breaks: [{ startedAt: new Date(t(10)), endedAt: new Date(t(10, 15)), reason: "tea" }] })], records: [attempt("op1", t(9), t(9, 30))] });
  assert.deepEqual(kinds(op, "break"), [[600, 615]]);
});

test("an open session on today runs to now; on a past day it ends after the last test or the day's hours, never more than ten hours", () => {
  const today = one({ nowMs: t(11), sessions: [session("op1", t(9), null)], records: [attempt("op1", t(9), t(9, 20))] });
  assert.equal(mins(today.totals.presentMs), 120);
  assert.equal(today.milestones.stillLoggedIn, true);
  assert.equal(today.milestones.logout, null);
  const past = one({ sessions: [session("op1", t(9), null)], records: [attempt("op1", t(9), t(9, 20))] });
  assert.equal(mins(past.totals.presentMs), 9 * 60, "to the end of the day's hours (18:00)");
  const longOpen = one({ sessions: [session("op1", t(7), null)], records: [attempt("op1", t(7), t(7, 10))] });
  assert.equal(mins(longOpen.totals.presentMs), 10 * 60, "capped at ten hours: 07:00 to 17:00");
});

test("gaps under a minute are ignored", () => {
  const op = one({ records: [attempt("op1", t(9), t(9, 10)), attempt("op1", t(9, 10) + 30000, t(9, 20))] });
  assert.equal(op.segments.filter((s) => s.type === "idle" || s.type === "long_idle").length, 0);
});

test("results other than pass and NG are not testing, and a stage filter keeps an operator's whole day", () => {
  const records = [
    attempt("op1", t(9), t(9, 10)),
    attempt("op1", t(10), t(10, 10), { stageName: "Functional" }),
    attempt("op2", t(9), t(9, 10), { stageName: "Functional" }),
    attempt("op2", t(11), t(11, 5), { status: "Resolved" }),
  ];
  const all = build({ records });
  assert.deepEqual(all.operators.map((o) => [o.name, o.totals.attempts]), [["Asha Rao", 2], ["Bala K", 1]], "the resolved record is not an attempt");
  const vi = build({ records, stage: "visual_inspection" });
  assert.deepEqual(vi.operators.map((o) => o.name), ["Asha Rao"]);
  assert.equal(vi.operators[0].totals.attempts, 2, "her Functional attempt still counts in her day");
  assert.deepEqual(vi.operators[0].stages.sort(), ["Functional", "Visual Inspection"]);
});

test("totals count pass and NG attempts and the devices once", () => {
  const op = one({ records: [attempt("op1", t(9), t(9, 5)), attempt("op1", t(9, 6), t(9, 8), { status: "NG", deviceId: "dX", serialNo: "SX" }), attempt("op1", t(9, 9), t(9, 12), { deviceId: "dX", serialNo: "SX" })] });
  assert.deepEqual([op.totals.attempts, op.totals.pass, op.totals.ng, op.totals.devices], [3, 2, 1, 2]);
});

test("work the next morning belongs to a night shift's day; an attempt with no operator is listed as not recorded", () => {
  const night = build({ window: { startTime: "21:00", endTime: "05:00" }, records: [attempt("op1", t(25, 30), t(25, 40)), attempt("", t(22), t(22, 10))] });
  assert.equal(night.operators.length, 2);
  assert.deepEqual(night.operators.map((o) => o.name), ["Not recorded", "Asha Rao"]);
  assert.equal(night.operators[1].segments[0].startMin, 1530);
});

test("the drawing range holds the plan's hours with an hour either side, widened for work outside them", () => {
  const quiet = build({ records: [attempt("op1", t(9), t(9, 10))] });
  assert.deepEqual(quiet.axis, { startMin: 480, endMin: 1140 });
  assert.deepEqual(quiet.window, { startMin: 540, endMin: 1080, startTime: "09:00", endTime: "18:00" });
  const wide = build({ records: [attempt("op1", t(6, 10), t(6, 30)), attempt("op1", t(20, 5), t(20, 20))] });
  assert.deepEqual(wide.axis, { startMin: 360, endMin: 1260 });
  assert.equal(build({ nowMs: t(10, 30), records: [] }).nowMin, 630);
  assert.equal(build({ records: [] }).nowMin, null);
});

test("a day with no usable hours is refused, and nothing recorded gives an empty day", () => {
  assert.equal(buildOperatorTimeline({ dayStartMs: DAY, window: { startTime: "", endTime: "" }, aliasLookup: LOOKUP }).ok, false);
  assert.deepEqual(build({ records: [] }).operators, []);
});

test("a session recorded as ending days later counts for no more than the system's session limit, and says it was ended by the system", () => {
  const op = one({ sessions: [session("op1", t(9), t(9) + 5 * 24 * 3600000)], records: [attempt("op1", t(9), t(9, 10))] });
  assert.equal(mins(op.totals.presentMs), 10 * 60, "ten hours, not five days");
  assert.equal(op.milestones.sessionEndedBySystem, true);
  assert.equal(op.milestones.logout, null, "a close days later is not a logout");
  const normal = one({ sessions: [session("op1", t(9), t(12))], records: [attempt("op1", t(9), t(9, 10))] });
  assert.equal(normal.milestones.sessionEndedBySystem, false);
  assert.equal(normal.milestones.logout, new Date(t(12)).toISOString());
});

test("only the part of a session inside the day counts, and the next morning's work belongs to the next day", () => {
  const late = one({ sessions: [session("op1", t(20), t(30))], records: [attempt("op1", t(20), t(20, 10))] });
  assert.equal(mins(late.totals.presentMs), 4 * 60, "20:00 to midnight on a day shift; the rest is the next day's");
  const morning = build({ records: [attempt("op1", t(9), t(9, 10)), attempt("op1", t(26), t(26, 10))] }); // 02:00 the next morning
  assert.equal(morning.operators[0].totals.attempts, 1, "02:00 tomorrow is not today's work");
  assert.equal(mins(morning.operators[0].totals.presentMs), 10);
  const logged = one({ sessions: [session("op1", t(23), t(23, 59))], records: [attempt("op1", t(23), t(23, 10))], idleLogs: [{ operatorId: "op1", idleStartTime: new Date(t(23, 30)), idleEndTime: new Date(t(25)), reasonLabel: "Power Cut", category: "DOWNTIME" }] });
  assert.equal(mins(logged.totals.loggedDowntimeMs), 30, "an idle log that runs past midnight is cut there");
});

test("a night shift keeps the morning hours as its own", () => {
  const night = build({ window: { startTime: "21:00", endTime: "05:00" }, records: [attempt("op1", t(25, 30), t(25, 40)), attempt("op1", t(31), t(31, 10))] }); // 01:30 and 07:00 next day
  assert.equal(night.operators[0].totals.attempts, 1, "01:30 is inside the shift; 07:00 is two hours past its end");
});
