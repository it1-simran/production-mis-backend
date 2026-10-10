const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateEditGuard } = require("../../services/planning/editGuard");
const { buildFootprint, summarizeFootprint } = require("../../services/planning/planFootprint");
const { storedView, draftView, scheduleOf } = require("../../services/planning/planViews");
const { buildDaySchedule, templateFromShift } = require("../../services/planning/daySchedule");
const { normalizeDraft } = require("../../services/planning/draft");
const { buildHolidayKeys } = require("../../utils/planDates");
const { DAY_SHIFT, stageEntry } = require("./helpers");

const TODAY = "2026-10-07"; // a Wednesday
const entry = (name) => ({ name, stageName: name, upha: "40" });
const view = (over = {}) => ({
  mode: "shift",
  startKey: "2026-10-05",
  endKey: "2026-10-09",
  plannedEndKey: "",
  roomId: "room-1",
  shiftId: "s1",
  hours: { startTime: "", endTime: "" },
  stages: { "0-0": [entry("Visual Inspection")], "0-1": [entry("Functional")] },
  operators: { "0-0": [{ _id: "u1" }], "0-1": [{ _id: "u2" }] },
  jigs: {},
  common: [],
  daySchedule: [],
  ...over,
});
const day = (dayKey, startTime = "09:00", endTime = "17:00", over = {}) => ({ dayKey, startTime, endTime, breaks: [], working: true, ...over });
const week = (over = {}) => ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].map((k) => day(k, "09:00", "17:00", over[k] || {}));
const labelOf = (k) => `Seat ${k}`;
const guard = (existing, draft, footprint, extra = {}) =>
  evaluateEditGuard({ existing, draft, footprint, todayKey: TODAY, labelOf, existingSchedule: week(), draftSchedule: week(), ...extra });
const codes = (issues) => issues.map((i) => i.code);

const running = () =>
  buildFootprint({
    processStatus: "active",
    outputRows: [
      { _id: { seat: "0-0", stage: "Visual Inspection" }, n: 40, first: new Date(2026, 9, 5, 10), last: new Date(2026, 9, 6, 16) },
      { _id: { seat: "0-1", stage: "Functional" }, n: 12, first: new Date(2026, 9, 6, 9), last: new Date(2026, 9, 6, 15) },
    ],
  });

// ---- the footprint ---------------------------------------------------------------------------

test("buildFootprint reads counters, test records, kits and open sessions", () => {
  const plan = { assignedStages: JSON.stringify({ "0-2": [{ name: "Packaging", passedDevice: 5, ngDevice: 1 }] }) };
  const fp = buildFootprint({
    processStatus: "waiting_for_line_feeding",
    plan,
    outputRows: [
      { _id: { seat: "0-0", stage: "Visual Inspection" }, n: 3, first: new Date(2026, 9, 5, 9), last: new Date(2026, 9, 6, 9) },
      { _id: { seat: "", stage: "Calibration" }, n: 2, first: new Date(2026, 9, 4, 9), last: new Date(2026, 9, 8, 9) },
    ],
    kitRows: [
      { status: "CONFIRM", seatDetails: [{ rowNumber: "0", seatNumber: "0", issuedKits: 100 }] },
      { status: "ASSIGN_TO_OPERATOR", seatDetails: [{ rowNumber: "0", seatNumber: "1", issuedKits: 50 }, { rowNumber: "0", seatNumber: "2", issuedKits: 0 }] },
    ],
    sessions: [{ operatorId: "u1" }, { operatorId: "u1" }, { operatorId: "u9" }],
  });
  assert.equal(fp.outputBySeatStage.get("0-2|packaging"), 6);
  assert.equal(fp.outputBySeatStage.get("0-0|visual inspection"), 3);
  assert.ok(fp.stagesWithOutput.has("calibration"), "a record with no seat still protects its stage");
  assert.equal(fp.outputBySeatStage.size, 2);
  assert.equal(fp.firstActivityKey, "2026-10-04");
  assert.equal(fp.lastActivityKey, "2026-10-08");
  assert.deepEqual(Array.from(fp.kitSeats.keys()).sort(), ["0-0", "0-1"], "a seat with zero kits is not listed");
  assert.equal(fp.kitSeats.get("0-1").awaitingConfirmation, true);
  assert.equal(fp.kitSeats.get("0-0").awaitingConfirmation, false);
  assert.equal(fp.kitsAssigned, true);
  assert.deepEqual(Array.from(fp.openSessionOperatorIds).sort(), ["u1", "u9"]);
  assert.equal(fp.started, true);
});

test("a plan is 'started' by output or by a live process, not by waiting for kits", () => {
  assert.equal(buildFootprint({ processStatus: "Waiting_Kits_allocation" }).started, false);
  assert.equal(buildFootprint({ processStatus: "waiting_for_kits_confirmation" }).started, false);
  assert.equal(buildFootprint({ processStatus: "active" }).started, true);
  assert.equal(buildFootprint({ processStatus: "down_time_hold" }).started, true);
  assert.equal(buildFootprint({ processStatus: "Waiting_Kits_approval", outputRows: [{ _id: { seat: "0-0", stage: "A" }, n: 1 }] }).started, true);
});

test("summarizeFootprint is plain data the page can use", () => {
  const s = summarizeFootprint(running());
  assert.equal(s.started, true);
  assert.deepEqual(s.seatsWithOutput.sort(), ["0-0", "0-1"]);
  assert.deepEqual(s.stagesWithOutput.sort(), ["functional", "visual inspection"]);
  assert.equal(s.lastActivityKey, "2026-10-06");
  assert.deepEqual(summarizeFootprint(buildFootprint({ processStatus: "active", sessions: [{ operatorId: "u1" }] })).openSessionOperatorIds, ["u1"]);
  assert.doesNotThrow(() => JSON.stringify(s));
});

// ---- the principle: a draft equal to the stored plan never raises anything --------------------

test("an unchanged plan raises nothing, even when the footprint mentions seats the plan no longer has", () => {
  const odd = buildFootprint({
    processStatus: "active",
    outputRows: [{ _id: { seat: "5-5", stage: "Gone Stage" }, n: 99, first: new Date(2026, 8, 1), last: new Date(2026, 8, 2) }],
    kitRows: [{ status: "CONFIRM", seatDetails: [{ rowNumber: "7", seatNumber: "7", issuedKits: 10 }] }],
    sessions: [{ operatorId: "ghost" }],
  });
  assert.deepEqual(guard(view(), view(), odd), []);
  assert.deepEqual(guard(view(), view(), running()), []);
});

// ---- EDIT-001 / 002 --------------------------------------------------------------------------

test("EDIT-001: a completed process is read-only", () => {
  const issues = guard(view(), view(), buildFootprint({ processStatus: "completed" }));
  assert.deepEqual(codes(issues), ["EDIT-001"]);
});

test("EDIT-002: a stage with output cannot be replaced, removed or moved off its seat", () => {
  const replaced = guard(view(), view({ stages: { "0-0": [entry("Packaging")], "0-1": [entry("Functional")] } }), running());
  assert.deepEqual(codes(replaced), ["EDIT-002"]);
  assert.equal(replaced[0].seatKey, "0-0");
  assert.match(replaced[0].message, /40 devices/);

  const moved = guard(view(), view({ stages: { "0-5": [entry("Visual Inspection")], "0-1": [entry("Functional")] } }), running());
  assert.ok(codes(moved).includes("EDIT-002"), "moving it to another seat leaves the old seat without its stage");

  const removed = guard(view(), view({ stages: { "0-0": [entry("Visual Inspection")] } }), running());
  assert.deepEqual(codes(removed), ["EDIT-002"]);
  assert.match(removed[0].message, /Functional|functional/);
});

test("EDIT-002: more seats for a stage with output is allowed, and so is changing a seat with no output", () => {
  const more = guard(view(), view({ stages: { "0-0": [entry("Visual Inspection")], "0-1": [entry("Functional")], "0-2": [entry("Functional")] } }), running());
  assert.deepEqual(more, []);
  const fresh = view({ stages: { ...view().stages, "1-0": [entry("Packaging")] } });
  assert.deepEqual(guard(fresh, view({ stages: { ...view().stages, "1-0": [entry("Calibration")] } }), running()), [], "Packaging has no output yet");
});

test("EDIT-002: a stage known only from a record with no seat cannot disappear", () => {
  const fp = buildFootprint({ processStatus: "Waiting_Kits_approval", outputRows: [{ _id: { seat: "", stage: "Functional" }, n: 4 }] });
  assert.deepEqual(codes(guard(view(), view({ stages: { "0-0": [entry("Visual Inspection")] } }), fp)), ["EDIT-002"]);
  assert.deepEqual(guard(view(), view({ stages: { "0-0": [entry("Visual Inspection")], "3-3": [entry("Functional")] } }), fp), [], "moving it is fine: only the seat-level history is unknown");
});

// ---- EDIT-003 / 004 / 005 ---------------------------------------------------------------------

test("EDIT-003: the stage of a seat with kits issued cannot change; its operator can (with a note if kits await confirmation)", () => {
  const fp = buildFootprint({ processStatus: "waiting_for_kits_confirmation", kitRows: [{ status: "ASSIGN_TO_OPERATOR", seatDetails: [{ rowNumber: "0", seatNumber: "1", issuedKits: 500 }] }] });
  const changed = guard(view(), view({ stages: { "0-0": [entry("Visual Inspection")], "0-1": [entry("Packaging")] } }), fp);
  assert.deepEqual(codes(changed), ["EDIT-003"]);
  assert.match(changed[0].message, /500 kits/);
  const emptied = guard(view(), view({ stages: { "0-0": [entry("Visual Inspection")] } }), fp);
  assert.deepEqual(codes(emptied), ["EDIT-003"]);
  const operatorChanged = guard(view(), view({ operators: { "0-0": [{ _id: "u1" }], "0-1": [{ _id: "u7" }] } }), fp);
  assert.deepEqual(operatorChanged.map((i) => [i.code, i.severity]), [["EDIT-009", "warning"]]);
  const confirmed = buildFootprint({ processStatus: "waiting_for_kits_confirmation", kitRows: [{ status: "CONFIRM", seatDetails: [{ rowNumber: "0", seatNumber: "1", issuedKits: 500 }] }] });
  assert.deepEqual(guard(view(), view({ operators: { "0-0": [{ _id: "u1" }], "0-1": [{ _id: "u7" }] } }), confirmed), [], "confirmed kits do not wait on the operator");
});

test("EDIT-004: the floor is free to change until kits are issued or production starts", () => {
  const moved = view({ roomId: "room-2" });
  assert.deepEqual(guard(view(), moved, buildFootprint({ processStatus: "Waiting_Kits_allocation" })), []);
  assert.deepEqual(codes(guard(view(), moved, buildFootprint({ processStatus: "Waiting_Kits_approval", kitRows: [{ status: "CONFIRM", seatDetails: [] }] }))), ["EDIT-004"]);
  assert.deepEqual(codes(guard(view(), moved, running())), ["EDIT-004"]);
});

test("EDIT-005: the start date is locked once production has started", () => {
  const later = view({ startKey: "2026-10-06" });
  assert.deepEqual(guard(view(), later, buildFootprint({ processStatus: "Waiting_Kits_approval" })), []);
  assert.deepEqual(codes(guard(view(), later, running())), ["EDIT-005"]);
});

// ---- EDIT-006 --------------------------------------------------------------------------------

test("EDIT-006: days that have passed keep their hours; today and later can change", () => {
  const edit = (k, patch) => week({ [k]: patch });
  const past = guard(view(), view(), running(), { draftSchedule: edit("2026-10-06", { startTime: "10:00" }) });
  assert.deepEqual(past.map((i) => [i.code, i.dayKey]), [["EDIT-006", "2026-10-06"]]);
  const removedPast = guard(view(), view(), running(), { draftSchedule: week().filter((d) => d.dayKey !== "2026-10-05") });
  assert.deepEqual(removedPast.map((i) => [i.code, i.dayKey]), [["EDIT-006", "2026-10-05"]]);
  assert.deepEqual(guard(view(), view(), running(), { draftSchedule: edit("2026-10-08", { startTime: "10:00" }) }), [], "tomorrow is free");
  const added = guard(view(), view(), running(), { existingSchedule: week().slice(1), draftSchedule: week() });
  assert.deepEqual(added.map((i) => i.code), ["EDIT-006"], "adding a day in the past rewrites history too");
  const notStarted = buildFootprint({ processStatus: "Waiting_Kits_allocation" });
  assert.deepEqual(guard(view(), view(), notStarted, { draftSchedule: edit("2026-10-06", { startTime: "10:00" }) }), []);
});

test("EDIT-006: today's hours may change (a warning only while people are working); the end date cannot move before the last activity", () => {
  const today = week({ "2026-10-07": { startTime: "10:00" } });
  assert.deepEqual(guard(view(), view(), running(), { draftSchedule: today }), [], "nobody working: nothing to say");
  const working = buildFootprint({ processStatus: "active", sessions: [{ operatorId: "uX" }], outputRows: [{ _id: { seat: "0-0", stage: "Visual Inspection" }, n: 1, first: new Date(2026, 9, 5), last: new Date(2026, 9, 6) }] });
  const warned = guard(view(), view(), working, { draftSchedule: today });
  assert.deepEqual(warned.map((i) => [i.code, i.severity]), [["EDIT-008", "warning"]]);
  const early = guard(view(), view({ endKey: "2026-10-05" }), running());
  assert.deepEqual(codes(early), ["EDIT-006"]);
  assert.match(early[0].message, /2026-10-06/);
  assert.deepEqual(guard(view(), view({ endKey: "2026-10-06" }), running()), []);
});

// ---- EDIT-007 --------------------------------------------------------------------------------

test("EDIT-007: replacing or moving an operator who has an open work session is allowed, with a warning", () => {
  const fp = buildFootprint({ processStatus: "active", sessions: [{ operatorId: "u1" }] });
  const removed = guard(view(), view({ operators: { "0-1": [{ _id: "u2" }] } }), fp);
  assert.deepEqual(removed.map((i) => [i.code, i.seatKey, i.severity]), [["EDIT-007", "0-0", "warning"]]);
  const moved = guard(view(), view({ operators: { "0-3": [{ _id: "u1" }], "0-1": [{ _id: "u2" }] } }), fp);
  assert.deepEqual(codes(moved), ["EDIT-007"]);
  assert.deepEqual(guard(view(), view({ operators: { "0-0": [{ _id: "u1" }, { _id: "u5" }], "0-1": [{ _id: "u2" }] } }), fp), [], "adding someone is fine");
  assert.deepEqual(guard(view(), view({ operators: { "0-1": [{ _id: "u2" }] } }), buildFootprint({ processStatus: "active", sessions: [{ operatorId: "stranger" }] })), [], "a session of someone not on the plan is not this plan's concern");
});

// ---- views and schedules --------------------------------------------------------------------

test("storedView and draftView describe the same plan the same way", () => {
  const stored = {
    selectedRoom: "room-1",
    selectedShift: "s1",
    startDate: new Date(2026, 9, 5),
    estimatedEndDate: new Date(2026, 9, 9),
    ProcessShiftMappings: { startTime: "09:00", endTime: "18:00" },
    assignedStages: JSON.stringify({ "0-0": [stageEntry("Visual Inspection", 50)] }),
    assignedOperators: JSON.stringify({ "0-0": [{ _id: "u1" }] }),
    assignedJigs: "{}",
    assignedCustomStagesOp: "[[]]",
  };
  const a = storedView(stored);
  assert.deepEqual([a.mode, a.startKey, a.endKey, a.roomId, a.shiftId], ["shift", "2026-10-05", "2026-10-09", "room-1", "s1"]);
  const d = normalizeDraft({ selectedRoom: "room-1", selectedShift: "s1", startDate: "05/10/26 00:00:00", assignedStages: stored.assignedStages, assignedOperators: stored.assignedOperators });
  const b = draftView(d, { endKey: "2026-10-09" });
  assert.deepEqual([b.mode, b.startKey, b.endKey, b.roomId, b.shiftId], ["shift", "2026-10-05", "2026-10-09", "room-1", "s1"]);
  assert.deepEqual(Object.keys(b.stages), Object.keys(a.stages));
});

test("a shift plan's schedule equals the custom schedule built from that shift, so modes compare on equal terms", () => {
  const shiftPlan = view({ hours: { startTime: "09:00", endTime: "18:00" } });
  const holidayKeys = buildHolidayKeys([]);
  const asShift = scheduleOf(shiftPlan, { shift: DAY_SHIFT, holidayKeys });
  assert.equal(asShift.filter((d) => d.working).length, 5);
  const custom = view({ mode: "custom", daySchedule: buildDaySchedule({ startKey: "2026-10-05", endKey: "2026-10-09", defaults: templateFromShift(DAY_SHIFT), holidayKeys }).days });
  const asCustom = scheduleOf(custom, { shift: DAY_SHIFT, holidayKeys });
  assert.deepEqual(asShift.map((d) => [d.dayKey, d.startTime, d.endTime, d.working]), asCustom.map((d) => [d.dayKey, d.startTime, d.endTime, d.working]));
  // so switching a started plan from a shift to an identical custom schedule is not flagged
  assert.deepEqual(guard(shiftPlan, custom, running(), { existingSchedule: asShift, draftSchedule: asCustom }), []);
});

test("EDIT-006: a plan that already ran past its end date is not flagged unless the end moves earlier; no stored schedule means no past-day check", () => {
  const overran = buildFootprint({ processStatus: "active", outputRows: [{ _id: { seat: "0-0", stage: "Visual Inspection" }, n: 5, first: new Date(2026, 9, 5), last: new Date(2026, 9, 12) }] });
  assert.deepEqual(guard(view(), view(), overran), [], "end date untouched");
  assert.deepEqual(guard(view(), view({ endKey: "2026-10-10" }), overran), [], "end moved LATER but still before the last activity: not made worse");
  assert.deepEqual(codes(guard(view(), view({ endKey: "2026-10-08" }), overran)), ["EDIT-006"], "end moved earlier than before and before the activity");
  assert.deepEqual(guard(view(), view(), running(), { existingSchedule: [], draftSchedule: week() }), [], "nothing stored to compare with");
});
