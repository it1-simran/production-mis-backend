const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlan } = require("../../services/planning/planValidator");
const { buildHolidayKeys } = require("../../utils/planDates");
const { DAY_SHIFT, NIGHT_SHIFT, PROCESS, makeDraft, makeCtx, otherPlan, user, stageEntry, codes } = require("./helpers");

const NOW = new Date(2026, 9, 1); // 1 Oct 2026

const validate = (draft, ctx) => validatePlan(draft, ctx, { now: NOW });

test("a clean plan has no errors and gets server-computed capacity and dates", () => {
  const result = validate(makeDraft(), makeCtx());
  assert.equal(result.valid, true);
  assert.equal(result.summary.errors, 0);
  // 1000 units, bottleneck Functional 40/h x 1 seat x 8 productive hours = 320/day -> 3.125 days
  assert.equal(result.computed.unitsPerDay, 320);
  assert.equal(result.computed.totalTimeEstimation, "3.13");
  assert.equal(result.computed.bottleneck.stage, "Functional");
  // Mon 5 Oct start, 3.125 days -> 4 working days after Monday = Fri 9 Oct
  assert.equal(result.computed.endKey, "2026-10-09");
  assert.equal(result.computed.estimatedEndDate, "09/10/26 00:00:00");
});

test("missing process, room, shift and start date are errors", () => {
  const draft = makeDraft({ startDate: "" });
  const result = validate(draft, makeCtx({ process: null, room: null, shift: null }));
  assert.equal(result.valid, false);
  const c = codes(result);
  assert.equal(c.filter((x) => x === "STRUCT-002").length, 3);
  assert.ok(c.includes("CAL-004"));
});

test("a process that is not waiting for a schedule cannot get a new plan, a completed one cannot be edited", () => {
  const live = { ...PROCESS, status: "active" };
  assert.ok(codes(validate(makeDraft(), makeCtx({ process: live }))).includes("STRUCT-002"));
  // editing an already-published plan on an active process is allowed
  const editing = validate(makeDraft(), makeCtx({ process: live, existingPlan: { isDrafted: 0 } }));
  assert.ok(!codes(editing).includes("STRUCT-002"));
  // but a completed process never is
  const done = { ...PROCESS, status: "completed" };
  assert.ok(codes(validate(makeDraft(), makeCtx({ process: done, existingPlan: { isDrafted: 0 } }))).includes("STRUCT-002"));
  // publishing a draft counts as new
  assert.ok(codes(validate(makeDraft(), makeCtx({ process: live, existingPlan: { isDrafted: 1 } }))).includes("STRUCT-002"));
});

test("empty seat map: error when publishing, info for a draft", () => {
  const publish = validate(makeDraft({ assignedStages: {} }), makeCtx());
  assert.equal(publish.issues.find((i) => i.code === "STRUCT-001").severity, "error");
  const draft = validate(makeDraft({ assignedStages: {}, isDrafted: 1 }), makeCtx());
  assert.equal(draft.issues.find((i) => i.code === "STRUCT-001").severity, "info");
});

test("seat keys outside the room and unknown stages are errors", () => {
  const draft = makeDraft({
    assignedStages: {
      "0-0": [stageEntry("Visual Inspection", 50)],
      "0-1": [stageEntry("Functional", 40)],
      "9-9": [stageEntry("Functional", 40)],
      "1-0": [stageEntry("Not A Stage", 10)],
    },
  });
  const result = validate(draft, makeCtx());
  assert.ok(result.issues.some((i) => i.code === "STRUCT-003" && i.seatKey === "9-9"));
  assert.ok(result.issues.some((i) => i.code === "STRUCT-004" && i.severity === "error"));
});

test("a UPHA that differs from the process definition is only a warning", () => {
  const draft = makeDraft({ assignedStages: { "0-0": [stageEntry("Visual Inspection", 99)], "0-1": [stageEntry("Functional", 40)] } });
  const issue = validate(draft, makeCtx()).issues.find((i) => i.code === "STRUCT-004");
  assert.equal(issue.severity, "warning");
});

test("a process stage without any seat is an error when publishing and a warning for a draft", () => {
  const stages = { "0-0": [stageEntry("Visual Inspection", 50)] };
  const publish = validate(makeDraft({ assignedStages: stages }), makeCtx());
  assert.equal(publish.issues.find((i) => i.code === "STRUCT-005").severity, "error");
  const draft = validate(makeDraft({ assignedStages: stages, isDrafted: 1 }), makeCtx());
  assert.equal(draft.issues.find((i) => i.code === "STRUCT-005").severity, "warning");
});

test("another published plan for the same process is flagged", () => {
  const ctx = makeCtx({ samePlanForProcess: otherPlan({ id: "dup" }) });
  assert.ok(codes(validate(makeDraft(), ctx)).includes("PROC-001"));
});

test("calendar: a start on a day off warns, and the end date skips holidays", () => {
  const sat = validate(makeDraft({ startDate: "10/10/26 00:00:00" }), makeCtx());
  assert.ok(codes(sat).includes("CAL-001"));
  const withHoliday = makeCtx({ holidayKeys: buildHolidayKeys([{ holidayDate: new Date("2026-10-07T00:00:00.000Z") }]) });
  const result = validate(makeDraft(), withHoliday);
  assert.equal(result.computed.endKey, "2026-10-12"); // Wed 7 Oct is skipped, Fri 9 -> Mon 12
});

test("calendar: a past start date is informational, and only for new plans", () => {
  const past = makeDraft({ startDate: "01/09/26 00:00:00" });
  assert.ok(codes(validate(past, makeCtx())).includes("CAL-003"));
  assert.ok(!codes(validate(past, makeCtx({ existingPlan: { isDrafted: 0 } }))).includes("CAL-003"));
});

test("an unusable shift or malformed override is an error", () => {
  const breakOnly = { ...DAY_SHIFT, intervals: [{ startTime: "09:00", endTime: "18:00", breakTime: true }] };
  assert.ok(codes(validate(makeDraft(), makeCtx({ shift: breakOnly }))).includes("SHIFT-002"));
  const bad = makeDraft({ ProcessShiftMappings: { startTime: "xx", endTime: "18:00" } });
  assert.ok(codes(validate(bad, makeCtx())).includes("SHIFT-001"));
});

test("capacity: invalid quantity and missing UPHA are errors; absurd durations warn", () => {
  assert.ok(codes(validate(makeDraft(), makeCtx({ process: { ...PROCESS, quantity: "abc" } }))).includes("CAP-001"));
  const noUpha = { ...PROCESS, stages: PROCESS.stages.map((s) => ({ ...s, upha: "0" })) };
  assert.ok(codes(validate(makeDraft(), makeCtx({ process: noUpha }))).includes("CAP-002"));
  const huge = { ...PROCESS, quantity: "100000000" };
  assert.ok(codes(validate(makeDraft(), makeCtx({ process: huge }))).includes("CAP-003"));
});

test("SEAT-001: same room, overlapping dates and shift, shared seat", () => {
  const ctx = makeCtx({ otherPlans: [otherPlan({ seats: { "0-0": "Visual Inspection", "1-1": "Functional" } })] });
  const result = validate(makeDraft(), ctx);
  const conflicts = result.issues.filter((i) => i.code === "SEAT-001");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].seatKey, "0-0");
  assert.equal(conflicts[0].conflictsWith.processName, "Other Process");
  assert.equal(result.valid, false);
});

test("SEAT-001 is not raised for a different room, disjoint dates, or a non-overlapping shift", () => {
  const base = { seats: { "0-0": "Visual Inspection" } };
  assert.ok(!codes(validate(makeDraft(), makeCtx({ otherPlans: [otherPlan({ ...base, room: "room-2" })] }))).includes("SEAT-001"));
  assert.ok(!codes(validate(makeDraft(), makeCtx({ otherPlans: [otherPlan({ ...base, start: "19/10/26", end: "23/10/26" })] }))).includes("SEAT-001"));
  const night = otherPlan({ ...base, shiftTimes: ["21:00", "05:00"] });
  assert.ok(!codes(validate(makeDraft(), makeCtx({ otherPlans: [night] }))).includes("SEAT-001"));
});

test("SEAT-001 for night shifts that overlap each other across midnight", () => {
  const draft = makeDraft({ selectedShift: "shift-night", ProcessShiftMappings: { startTime: "22:00", endTime: "06:00" } });
  const night = otherPlan({ seats: { "0-0": "Visual Inspection" }, shiftTimes: ["21:00", "05:00"] });
  const result = validate(draft, makeCtx({ shift: NIGHT_SHIFT, otherPlans: [night] }));
  assert.ok(codes(result).includes("SEAT-001"));
});

test("SEAT-002: a plan past its end date but still live keeps its seat", () => {
  const overrun = otherPlan({ seats: { "0-1": "Functional" }, start: "21/09/26", end: "25/09/26" });
  const result = validate(makeDraft(), makeCtx({ overrunPlans: [overrun] }));
  const issue = result.issues.find((i) => i.code === "SEAT-002");
  assert.equal(issue.severity, "warning");
  assert.equal(issue.seatKey, "0-1");
  assert.equal(result.valid, true);
});

test("OPER-001: the same operator in an overlapping plan, in any room", () => {
  const draft = makeDraft({ assignedOperators: { "0-0": [user("u1")] } });
  const clash = otherPlan({ room: "room-2", seats: { "0-0": "Visual Inspection" }, operators: { "0-0": [{ _id: "u1" }] } });
  const result = validate(draft, makeCtx({ users: new Map([["u1", user("u1")]]), otherPlans: [clash] }));
  assert.ok(codes(result).includes("OPER-001"));
  assert.ok(!codes(result).includes("SEAT-001")); // different room
});

test("OPER-001 is not raised when the other plan runs on a different shift window", () => {
  const draft = makeDraft({ assignedOperators: { "0-0": [user("u1")] } });
  const night = otherPlan({ shiftTimes: ["21:00", "05:00"], operators: { "0-0": [{ _id: "u1" }] } });
  const result = validate(draft, makeCtx({ users: new Map([["u1", user("u1")]]), otherPlans: [night] }));
  assert.ok(!codes(result).includes("OPER-001"));
});

test("OPER-002 for a stale assignment row, but not when OPER-001 already covers the operator", () => {
  const draft = makeDraft({ assignedOperators: { "0-0": [user("u1")] } });
  const rows = new Map([["u1", [{ processId: "p9", processName: "Old Process" }]]]);
  const stale = validate(draft, makeCtx({ users: new Map([["u1", user("u1")]]), operatorRows: rows }));
  assert.ok(codes(stale).includes("OPER-002"));
  const clash = otherPlan({ operators: { "0-0": [{ _id: "u1" }] } });
  const both = validate(draft, makeCtx({ users: new Map([["u1", user("u1")]]), operatorRows: rows, otherPlans: [clash] }));
  assert.ok(codes(both).includes("OPER-001"));
  assert.ok(!codes(both).includes("OPER-002"));
});

test("OPER-003: unknown or inactive operators are errors", () => {
  const draft = makeDraft({ assignedOperators: { "0-0": [user("ghost")], "0-1": [user("gone")] } });
  const users = new Map([["gone", user("gone", { status: "Discarded" })]]);
  const result = validate(draft, makeCtx({ users }));
  assert.equal(result.issues.filter((i) => i.code === "OPER-003").length, 2);
});

test("OPER-004: skill or role mismatch warns; OPER-005: one operator on two seats errors", () => {
  const unskilled = user("u1", { skills: ["Soldering"] });
  const mismatch = validate(makeDraft({ assignedOperators: { "0-0": [unskilled] } }), makeCtx({ users: new Map([["u1", unskilled]]) }));
  assert.equal(mismatch.issues.find((i) => i.code === "OPER-004").severity, "warning");

  const twice = validate(
    makeDraft({ assignedOperators: { "0-0": [user("u1")], "0-1": [user("u1")] } }),
    makeCtx({ users: new Map([["u1", user("u1")]]) }),
  );
  assert.equal(twice.issues.find((i) => i.code === "OPER-005").severity, "error");
});

test("OPER-006: common-stage operators must be an eligible role", () => {
  const hr = user("u2", { userType: "Human Resource" });
  const result = validate(makeDraft({ assignedCustomStagesOp: [[hr]] }), makeCtx({ users: new Map([["u2", hr]]) }));
  assert.ok(codes(result).includes("OPER-006"));
  const qc = user("u3", { userType: "QC" });
  assert.ok(!codes(validate(makeDraft({ assignedCustomStagesOp: [[qc]] }), makeCtx({ users: new Map([["u3", qc]]) }))).includes("OPER-006"));
});

test("jigs: unknown jig, double booking, stale row, and a jig stage with no jig", () => {
  const jigs = new Map([["j1", { _id: "j1", name: "Jig One" }]]);
  const withJig = makeDraft({ assignedJigs: { "0-1": [{ _id: "j1" }] } });

  assert.ok(codes(validate(makeDraft({ assignedJigs: { "0-1": [{ _id: "nope" }] } }), makeCtx({ jigs }))).includes("JIG-002"));

  const clash = otherPlan({ jigs: { "2-2": [{ _id: "j1" }] }, seats: { "2-2": "Functional" } });
  assert.ok(codes(validate(withJig, makeCtx({ jigs, otherPlans: [clash] }))).includes("JIG-001"));

  const stale = new Map([["j1", [{ processId: "p9", processName: "Old Process" }]]]);
  const staleResult = validate(withJig, makeCtx({ jigs, jigRows: stale }));
  assert.ok(codes(staleResult).includes("JIG-005"));
  assert.ok(!codes(staleResult).includes("JIG-003")); // seat 0-1 runs Functional and has a jig

  // Functional is a jig stage in PROCESS; without a jig the seat is flagged
  assert.ok(codes(validate(makeDraft(), makeCtx({ jigs }))).includes("JIG-003"));
});

test("a truncated conflict search is reported", () => {
  assert.ok(codes(validate(makeDraft(), makeCtx({ truncated: true }))).includes("LOADER-001"));
});

test("issues are ordered errors first, then warnings, then info", () => {
  const draft = makeDraft({ startDate: "10/10/26 00:00:00", assignedStages: { "0-0": [stageEntry("Visual Inspection", 50)] } });
  const result = validate(draft, makeCtx());
  const order = result.issues.map((i) => i.severity);
  const sorted = [...order].sort((a, b) => ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]);
  assert.deepEqual(order, sorted);
});

test("planned end earlier than capacity: warns with the shortfall, and the planned date is the effective end", () => {
  const result = validate(makeDraft({ plannedEndDate: "07/10/26 00:00:00" }), makeCtx());
  assert.equal(result.computed.capacityEndKey, "2026-10-09");
  assert.equal(result.computed.plannedEndKey, "2026-10-07");
  assert.equal(result.computed.endKey, "2026-10-07");
  assert.equal(result.computed.plannedWorkingDays, 2);
  assert.equal(result.computed.plannedCapacityUnits, 640);
  assert.equal(result.computed.shortfallUnits, 360);
  assert.ok(codes(result).includes("CAP-004"));
  assert.equal(result.valid, true);
});

test("planned end later than capacity: info about spare days, no shortfall", () => {
  const result = validate(makeDraft({ plannedEndDate: "15/10/26 00:00:00" }), makeCtx());
  assert.equal(result.computed.endKey, "2026-10-15");
  assert.equal(result.computed.capacityEndKey, "2026-10-09");
  assert.equal(result.computed.shortfallUnits, 0);
  assert.ok(codes(result).includes("CAL-006"));
  assert.ok(!codes(result).includes("CAP-004"));
});

test("planned end before the start is an error; a day-off end warns", () => {
  const before = validate(makeDraft({ plannedEndDate: "01/10/26 00:00:00" }), makeCtx());
  assert.ok(codes(before).includes("CAL-005"));
  assert.equal(before.valid, false);
  assert.equal(before.computed.endKey, "2026-10-05");
  const sat = validate(makeDraft({ plannedEndDate: "10/10/26 00:00:00" }), makeCtx());
  assert.ok(codes(sat).includes("CAL-007"));
});

test("no planned end: behaviour is unchanged", () => {
  const result = validate(makeDraft(), makeCtx());
  assert.equal(result.computed.endKey, result.computed.capacityEndKey);
  assert.equal(result.computed.shortfallUnits, null);
  assert.ok(!codes(result).some((c) => ["CAL-005", "CAL-006", "CAL-007", "CAP-004"].includes(c)));
});

test("several seats on one stage add up in capacity", () => {
  const draft = makeDraft({
    assignedStages: {
      "0-0": [stageEntry("Visual Inspection", 50)],
      "0-1": [stageEntry("Visual Inspection", 50)],
      "0-2": [stageEntry("Functional", 40)],
      "0-3": [stageEntry("Functional", 40)],
    },
  });
  const result = validate(draft, makeCtx());
  // Functional 40 x 2 seats = 80/h is the slowest stage -> 640/day
  assert.equal(result.computed.unitsPerDay, 640);
  assert.equal(result.computed.bottleneck.stage, "Functional");
  assert.equal(result.computed.endKey, "2026-10-07");
});

const ID1 = "6a61d4dd83de7e6e00b272a5";
test("OPER-001 is only a warning for an operator the planner chose from another process on purpose", () => {
  const clash = otherPlan({ room: "room-2", seats: { "0-0": "Visual Inspection" }, operators: { "0-0": [{ _id: ID1 }] } });
  const ctx = () => makeCtx({ users: new Map([[ID1, user(ID1)]]), otherPlans: [clash] });
  const plain = validate(makeDraft({ assignedOperators: { "0-0": [user(ID1)] } }), ctx());
  assert.equal(plain.issues.find((i) => i.code === "OPER-001").severity, "error");
  const chosen = validate(makeDraft({ assignedOperators: { "0-0": [user(ID1)] }, takeOverOperatorIds: [ID1] }), ctx());
  const issue = chosen.issues.find((i) => i.code === "OPER-001");
  assert.equal(issue.severity, "warning");
  assert.match(issue.message, /saving moves them here/);
  const other = validate(makeDraft({ assignedOperators: { "0-0": [user(ID1)] }, takeOverOperatorIds: ["6a701e8076c2061d9c6a015c"] }), ctx());
  assert.equal(other.issues.find((i) => i.code === "OPER-001").severity, "error", "choosing a different operator does not excuse this one");
});
