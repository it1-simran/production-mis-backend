const test = require("node:test");
const assert = require("node:assert/strict");
const { diffPlans } = require("../../services/planning/planDiff");
const { planRevision } = require("../../services/planning/planRevision");

const entry = (name, extra = {}) => ({ name, stageName: name, upha: "40", ...extra });
const op = (id, name) => ({ _id: id, name });
const view = (over = {}) => ({
  mode: "shift",
  startKey: "2026-10-05",
  endKey: "2026-10-09",
  plannedEndKey: "",
  roomId: "room-1",
  shiftId: "s1",
  hours: { startTime: "", endTime: "" },
  stages: { "0-0": [entry("Visual Inspection")], "0-1": [entry("Functional")] },
  operators: { "0-0": [op("u1", "Asha Rao")], "0-1": [op("u2", "Vikram Shah")] },
  jigs: { "0-1": [{ _id: "j1", name: "Jig One" }] },
  common: [[op("q1", "Quinn QC")]],
  daySchedule: [],
  ...over,
});
const sched = (hours = {}) => ["2026-10-05", "2026-10-06", "2026-10-07"].map((k) => ({ dayKey: k, startTime: "09:00", endTime: "17:00", breaks: [], working: true, ...(hours[k] || {}) }));
const labelOf = (k) => `Line ${Number(k.split("-")[0]) + 1} · Seat ${Number(k.split("-")[1]) + 1}`;
const diff = (a, b, extra = {}) => diffPlans(a, b, { beforeSchedule: sched(), afterSchedule: sched(), labelOf, ...extra });

test("an identical plan has no changes", () => {
  const d = diff(view(), view());
  assert.deepEqual(d.changes, []);
  assert.equal(d.summary, "No changes.");
  assert.deepEqual(d.impact, { operatorsFreed: [], jigsFreed: [], seatsChanged: [] });
});

test("dates, floor and mode changes are described in plain words", () => {
  const d = diff(view(), view({ startKey: "2026-10-06", endKey: "2026-10-12", roomId: "room-2", mode: "custom" }), { names: { rooms: { "room-1": "Floor A", "room-2": "Floor B" } } });
  const texts = d.changes.map((c) => c.text);
  assert.ok(texts.includes("Start date: Mon 5 Oct 2026 becomes Tue 6 Oct 2026."));
  assert.ok(texts.includes("End date: Fri 9 Oct 2026 becomes Mon 12 Oct 2026."));
  assert.ok(texts.includes("Floor: Floor A becomes Floor B."));
  assert.ok(texts.some((t) => /a shift becomes a custom day-wise schedule/.test(t)));
  assert.equal(d.counts.dates, 4);
});

test("hours are compared day by day, including days added, removed and switched off", () => {
  const before = sched();
  const after = [
    { dayKey: "2026-10-05", startTime: "09:00", endTime: "17:00", breaks: [], working: true }, // same
    { dayKey: "2026-10-06", startTime: "14:00", endTime: "18:30", breaks: [{ startTime: "16:00", endTime: "16:10" }], working: true },
    { dayKey: "2026-10-07", startTime: "09:00", endTime: "17:00", breaks: [], working: false },
    { dayKey: "2026-10-08", startTime: "09:00", endTime: "13:00", breaks: [], working: true },
  ];
  const d = diff(view(), view(), { beforeSchedule: before, afterSchedule: after });
  assert.deepEqual(d.changes.map((c) => c.text), [
    "Tue 6 Oct 2026: 09:00 to 17:00 becomes 14:00 to 18:30 (1 break).",
    "Wed 7 Oct 2026: 09:00 to 17:00 becomes day off.",
    "Thu 8 Oct 2026: day off becomes 09:00 to 13:00.",
  ]);
  assert.equal(d.counts.hours, 3);
  assert.equal(d.summary, "3 changes: 3 days' hours.");
});

test("stages: replaced, added, removed, and moved from one seat to another", () => {
  const replaced = diff(view(), view({ stages: { "0-0": [entry("Visual Inspection")], "0-1": [entry("Packaging")] } }));
  assert.deepEqual(replaced.changes.map((c) => c.text), ["Line 1 · Seat 2: Functional is replaced by Packaging."]);
  const added = diff(view(), view({ stages: { ...view().stages, "0-2": [entry("Calibration")] } }));
  assert.deepEqual(added.changes.map((c) => c.text), ["Calibration is added to Line 1 · Seat 3."]);
  const removed = diff(view(), view({ stages: { "0-0": [entry("Visual Inspection")] } }));
  assert.deepEqual(removed.changes.map((c) => c.text), ["Functional is removed from Line 1 · Seat 2."]);
  const moved = diff(view(), view({ stages: { "0-0": [entry("Visual Inspection")], "1-3": [entry("Functional")] } }));
  assert.deepEqual(moved.changes.map((c) => c.text), ["Functional moves from Line 1 · Seat 2 to Line 2 · Seat 4."]);
  assert.deepEqual(moved.impact.seatsChanged.sort(), ["0-1", "1-3"]);
});

test("operators and jigs: added, removed and moved", () => {
  const after = view({
    operators: { "0-1": [op("u1", "Asha Rao")], "0-5": [op("u9", "New Person")] }, // Asha moves 0-0 -> 0-1, Vikram leaves
    jigs: { "0-1": [{ _id: "j1", name: "Jig One" }], "0-0": [{ _id: "j2", name: "Jig Two" }] },
  });
  const d = diff(view(), after);
  const texts = d.changes.map((c) => c.text);
  assert.ok(texts.includes("Asha Rao (operator) moves from Line 1 · Seat 1 to Line 1 · Seat 2."));
  assert.ok(texts.includes("Vikram Shah (operator) is removed from Line 1 · Seat 2."));
  assert.ok(texts.includes("New Person (operator) is added to Line 1 · Seat 6."));
  assert.ok(texts.includes("Jig Two (jig) is added to Line 1 · Seat 1."));
  assert.deepEqual(d.impact.operatorsFreed, [{ id: "u2", name: "Vikram Shah" }], "only someone who leaves the plan entirely is freed");
  assert.deepEqual(d.impact.jigsFreed, []);
  assert.equal(d.counts.people, 3);
  assert.equal(d.counts.jigs, 1);
});

test("a jig dropped from the plan is reported as freed, and common-stage people are tracked", () => {
  const d = diff(view(), view({ jigs: {}, common: [[op("q2", "Other QC")]] }));
  assert.deepEqual(d.impact.jigsFreed, [{ id: "j1", name: "Jig One" }]);
  assert.deepEqual(d.impact.operatorsFreed, [{ id: "q1", name: "Quinn QC" }]);
  const texts = d.changes.map((c) => c.text);
  assert.ok(texts.includes("Quinn QC is removed from common stage 1."));
  assert.ok(texts.includes("Other QC is added to common stage 1."));
});

test("the summary counts each kind of change and caps a runaway list", () => {
  const many = {};
  for (let i = 0; i < 300; i += 1) many[`${Math.floor(i / 20)}-${i % 20}`] = [entry(`S${i}`)];
  const d = diff(view({ stages: {} }), view({ stages: many }));
  assert.equal(d.changes.length, 200);
  const small = diff(view(), view({ startKey: "2026-10-06", stages: { ...view().stages, "0-2": [entry("Calibration")] } }));
  assert.equal(small.summary, "2 changes: 1 date or setting, 1 seat.");
});

// ---- the revision ---------------------------------------------------------------------------

const stored = (over = {}) => ({
  isDrafted: 0,
  selectedRoom: "room-1",
  selectedShift: "s1",
  startDate: new Date(2026, 9, 5),
  estimatedEndDate: new Date(2026, 9, 9),
  ProcessShiftMappings: { startTime: "09:00", endTime: "18:00" },
  assignedStages: JSON.stringify({ "0-0": [{ name: "Visual Inspection", upha: "50", passedDevice: 0 }] }),
  assignedOperators: JSON.stringify({ "0-0": [{ _id: "u1", name: "Asha Rao" }] }),
  assignedJigs: "{}",
  assignedCustomStagesOp: "[[]]",
  ...over,
});

test("the revision is stable and ignores production counters and names", () => {
  const base = planRevision(stored());
  assert.equal(base, planRevision(stored()));
  assert.equal(base, planRevision(stored({ assignedStages: JSON.stringify({ "0-0": [{ name: "Visual Inspection", upha: "50", passedDevice: 40, ngDevice: 3, totalUPHA: 320 }] }) })), "output being recorded is not an edit");
  assert.equal(base, planRevision(stored({ assignedOperators: JSON.stringify({ "0-0": [{ _id: "u1", name: "Asha R. (renamed)", email: "x@y" }] }) })), "a profile change is not an edit");
});

test("the revision changes with every edit a planner can make", () => {
  const base = planRevision(stored());
  const changed = [
    stored({ startDate: new Date(2026, 9, 6) }),
    stored({ estimatedEndDate: new Date(2026, 9, 12) }),
    stored({ selectedRoom: "room-2" }),
    stored({ selectedShift: "s2" }),
    stored({ ProcessShiftMappings: { startTime: "10:00", endTime: "18:00" } }),
    stored({ assignedOperators: JSON.stringify({ "0-0": [{ _id: "u2" }] }) }),
    stored({ assignedJigs: JSON.stringify({ "0-0": [{ _id: "j1" }] }) }),
    stored({ assignedStages: JSON.stringify({ "0-0": [{ name: "Packaging", upha: "50" }] }) }),
    stored({ assignedCustomStagesOp: JSON.stringify([[{ _id: "q1" }]]) }),
    stored({ isDrafted: 1 }),
    stored({ scheduleMode: "custom", daySchedule: [{ dayKey: "2026-10-05", startTime: "09:00", endTime: "17:00", working: true }] }),
  ].map(planRevision);
  changed.forEach((r) => assert.notEqual(r, base));
  assert.equal(new Set(changed).size, changed.length, "each edit gives its own revision");
  const withDay = stored({ scheduleMode: "custom", daySchedule: [{ dayKey: "2026-10-05", startTime: "09:00", endTime: "17:00", working: true }] });
  const otherHours = stored({ scheduleMode: "custom", daySchedule: [{ dayKey: "2026-10-05", startTime: "10:00", endTime: "17:00", working: true }] });
  assert.notEqual(planRevision(withDay), planRevision(otherHours), "a day's hours are part of it");
});
