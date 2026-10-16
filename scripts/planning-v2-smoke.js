/* eslint-disable no-console */
// End-to-end smoke test for the v2 planner. It calls the REAL controller handlers against a real
// MongoDB, but inside a throwaway database ("planning-v2-e2e-<timestamp>") that it seeds with its
// own fixtures and drops at the end, so no existing data is read or changed.
//
// It also exercises LEGACY handlers on the plans v2 creates, to prove the old screens and the
// operator task list can still read them.
//
// Usage:   node scripts/planning-v2-smoke.js          (uses .env.development)
// Refuses to run with NODE_ENV=production.
const path = require("path");
const fs = require("fs");
const dns = require("dns");
const assert = require("node:assert/strict");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const env = process.env.NODE_ENV || "development";
if (env === "production") {
  console.error("Refusing to run the smoke test with NODE_ENV=production.");
  process.exit(2);
}
const envPath = path.resolve(__dirname, "..", `.env.${env}`);
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const SCRATCH_PREFIX = "planning-v2-e2e-";
const scratchName = `${SCRATCH_PREFIX}${Date.now()}`;

const oid = () => new mongoose.Types.ObjectId();
const results = [];
let failures = 0;

const step = async (name, fn) => {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL ${name}\n         ${String(error.message).split("\n").join("\n         ")}`);
  }
};

// Invoke an Express handler with a fake req/res and return { status, body }.
const call = async (handler, { body = {}, params = {}, query = {}, user } = {}) => {
  const out = { status: 200, body: null };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(payload) {
      out.body = payload;
      return this;
    },
  };
  await handler({ body, params, query, user, headers: {}, requestId: "smoke" }, res);
  return out;
};

const nextMonday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7) + 14);
  return d;
};

const main = async () => {
  try {
    const existing = dns.getServers();
    dns.setServers(["8.8.8.8", "1.1.1.1", ...existing.filter((s) => s !== "8.8.8.8" && s !== "1.1.1.1")]);
  } catch {
    // keep system resolvers
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: scratchName, autoIndex: false, serverSelectionTimeoutMS: 15000 });
  assert.equal(mongoose.connection.name, scratchName);
  console.log(`Scratch database: ${mongoose.connection.name}\n`);

  const { formatPlanDate, dayKeyLocal } = require("../utils/planDates");
  const controller = require("../controller/planningV2Controller");
  const legacyPlanning = require("../controller/planningAndSchedulingController");
  const operatorTask = require("../controller/operatorTaskController");
  const flags = ["PLAN_VALIDATION_MODE", "PLAN_ENFORCED_CODES", "PLAN_DELETE_GUARD", "PLAN_CUSTOM_SCHEDULE", "PLAN_EDIT_GUARD"];
  const resetFlags = () => flags.forEach((f) => delete process.env[f]);

  const Process = require("../models/process");
  const Room = require("../models/roomPlan");
  const Shift = require("../models/shiftManagement");
  const User = require("../models/User");
  const Jig = require("../models/jig");
  const JigCategory = require("../models/jigCategory");
  const Plan = require("../models/planingAndSchedulingModel");
  const AssignOperator = require("../models/assignOperatorToPlan");
  const AssignJig = require("../models/assignJigToPlan");
  const ProcessLog = require("../models/ProcessLogs");
  const PlanValidationEvent = require("../models/planValidationEvent");

  // ---- fixtures ----
  const room = await Room.create({
    floorName: "E2E Floor",
    lines: [0, 1].map((l) => ({ rowName: `Line 0${l + 1}`, seats: Array.from({ length: 6 }, (_, s) => ({ seatNumber: String(s + 1) })) })),
  });
  const weekdays = { sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false };
  const shift = await Shift.create({
    name: "E2E Day",
    startTime: "09:00",
    endTime: "18:00",
    weekDays: weekdays,
    intervals: [
      { startTime: "09:00", endTime: "13:00", breakTime: false },
      { startTime: "13:00", endTime: "14:00", breakTime: true },
      { startTime: "14:00", endTime: "18:00", breakTime: false },
    ],
  });
  const stageDef = (name, upha, jig) => ({
    stageName: name,
    requiredSkill: name,
    managedBy: "Operator",
    cycleTime: "10",
    upha: String(upha),
    subSteps: jig ? [{ stepName: "Run jig", stepType: "jig" }] : [],
  });
  const makeProcess = (n) =>
    Process.create({
      name: `E2E Process ${n}`,
      processID: `E2E-${n}`,
      quantity: "800",
      selectedProduct: oid(),
      status: "waiting_schedule",
      stages: [stageDef("Visual Inspection", 50, false), stageDef("Functional", 40, true)],
      commonStages: [{ stageName: "QC Check", managedBy: "QC", requiredSkill: "QC" }],
    });
  const [p1, p2] = [await makeProcess(1), await makeProcess(2)];
  const makeUser = (n, type = "Operator", skills = ["Visual Inspection", "Functional"]) =>
    User.create({ name: `E2E ${type} ${n}`, employeeCode: `E2E-${n}`, gender: "Male", password: "x", userType: type, skills, status: "Active" });
  const [u1, u2, u3] = [await makeUser(1), await makeUser(2), await makeUser(3)];
  const qc = await makeUser(4, "QC", ["QC"]);
  const cat = await JigCategory.create({ name: "E2E Cat", status: "Active" });
  const j1 = await Jig.create({ name: "E2E Jig 1", jigCategory: cat._id });

  const admin = { id: String(oid()), name: "E2E Admin", userType: "Admin", department: "E2E" };
  const manager = { id: String(oid()), name: "E2E Manager", userType: "Production Manager", department: "E2E" };

  const monday = nextMonday();
  const entry = (name, upha) => ({ name, stageName: name, upha: String(upha), requiredSkill: name, hasJigStepType: false });
  const baseBody = (proc, extra = {}) => ({
    processName: proc.name,
    selectedProcess: String(proc._id),
    selectedRoom: String(room._id),
    selectedShift: String(shift._id),
    startDate: formatPlanDate(monday),
    repeatCount: 1,
    isDrafted: 0,
    assignedStages: { "0-0": [entry("Visual Inspection", 50)], "0-1": [entry("Functional", 40)] },
    assignedOperators: { "0-0": [{ _id: String(u1._id) }], "0-1": [{ _id: String(u2._id) }] },
    assignedJigs: { "0-1": [{ _id: String(j1._id) }] },
    assignedCustomStagesOp: [[{ _id: String(qc._id) }]],
    ...extra,
  });
  const rowsFor = (proc) => AssignOperator.countDocuments({ processId: proc._id });
  const jigRowsFor = (proc) => AssignJig.countDocuments({ processId: proc._id });
  const statusOf = async (proc) => (await Process.findById(proc._id).lean()).status;

  let draftPlanId;
  let publishedPlanId;

  resetFlags();

  await step("lookups returns the planable process, room, shift and jigs", async () => {
    const r = await call(controller.lookups, { user: admin });
    assert.equal(r.status, 200);
    assert.ok(r.body.processes.some((p) => p._id === String(p1._id)));
    assert.equal(r.body.rooms.length, 1);
    assert.equal(r.body.shifts.length, 1);
    assert.equal(r.body.jigs.length, 1);
    const view = r.body.processes.find((p) => p._id === String(p1._id));
    assert.equal(view.stages.find((s) => s.stageName === "Functional").hasJigStepType, true);
  });

  await step("validate: a clean plan is valid and the server computes capacity and dates", async () => {
    const r = await call(controller.validate, { body: baseBody(p1), user: admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.errors, 0, JSON.stringify(r.body.issues));
    assert.equal(r.body.computed.unitsPerDay, 320); // 40 UPHA x 1 seat x 8 productive hours
    assert.equal(r.body.computed.totalTimeEstimation, "2.50");
    const expectedEnd = new Date(monday);
    expectedEnd.setDate(expectedEnd.getDate() + 3); // Mon + 3 working days = Thu
    assert.equal(r.body.computed.endKey, dayKeyLocal(expectedEnd));
    assert.equal(r._computed, undefined);
  });

  await step("create draft: saved, process untouched, no assignment rows", async () => {
    const r = await call(controller.create, { body: baseBody(p1, { isDrafted: 1, status: "Draft" }), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.plan.isDrafted, 1);
    draftPlanId = String(r.body.plan._id);
    assert.equal(await statusOf(p1), "waiting_schedule");
    assert.equal(await rowsFor(p1), 0);
    assert.equal(await jigRowsFor(p1), 0);
  });

  await step("publish the draft via update: mass-assignment ignored, server-authoritative values stored", async () => {
    const forged = { status: "completed", createdBy: "forged", totalUPHA: "99999", estimatedEndDate: "01/01/30 00:00:00", downTime: { from: new Date() } };
    const r = await call(controller.update, { params: { id: draftPlanId }, body: baseBody(p1, { isDrafted: 0, ...forged }), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    publishedPlanId = draftPlanId;
    const plan = await Plan.findById(publishedPlanId).lean();
    assert.equal(plan.isDrafted, 0);
    assert.equal(plan.status, "Waiting_Kits_allocation"); // not the forged "completed"
    assert.equal(String(plan.createdBy), admin.id); // set at draft creation, not forged
    assert.equal(plan.totalUPHA, "320.00");
    assert.equal(plan.totalTimeEstimation, "2.50");
    assert.notEqual(new Date(plan.estimatedEndDate).getFullYear(), 2030);
    assert.equal(plan.downTime?.from ?? null, null);
    assert.equal(plan.issuedKits, "800");
    assert.equal(plan.ProcessShiftMappings.startTime, "09:00");
    assert.equal(plan.ProcessShiftMappings.endTime, "18:00");
    const stages = JSON.parse(plan.assignedStages);
    const first = stages["0-0"][0];
    assert.equal(first.totalUPHA, 320);
    assert.equal(stages["0-1"][0].totalUPHA, 0);
    assert.ok(first.parallelGroupKey && first.stageInstanceId && first.seatKey === "0-0", "normalised like the legacy planner");
    assert.equal(first.passedDevice, 0);
    assert.equal(stages["0-1"][0].hasJigStepType, true);
    const ops = JSON.parse(plan.assignedOperators);
    assert.equal(ops["0-0"][0].name, "E2E Operator 1"); // rebuilt from the database
    assert.deepEqual(ops["0-0"][0].skills, ["Visual Inspection", "Functional"]);
    const custom = JSON.parse(plan.assignedCustomStagesOp);
    assert.equal(custom[0][0].userType, "QC");
    assert.equal(await statusOf(p1), "Waiting_Kits_allocation");
    assert.equal(await rowsFor(p1), 3); // u1, u2 and the common-stage QC
    assert.equal(await jigRowsFor(p1), 1);
    const seatRow = await AssignOperator.findOne({ processId: p1._id, userId: u1._id }).lean();
    assert.equal(seatRow.seatDetails.rowNumber, "0");
    assert.equal(seatRow.seatDetails.seatNumber, "0");
    const commonRow = await AssignOperator.findOne({ processId: p1._id, userId: qc._id }).lean();
    assert.equal(commonRow.stageType, "common");
  });

  await step("a second plan for the same process is refused (409)", async () => {
    const r = await call(controller.create, { body: baseBody(p1), user: admin });
    assert.equal(r.status, 409, JSON.stringify(r.body));
  });

  await step("update cannot move a plan to another process, or revert it to a draft", async () => {
    const a = await call(controller.update, { params: { id: publishedPlanId }, body: baseBody(p2), user: admin });
    assert.equal(a.status, 409);
    const b = await call(controller.update, { params: { id: publishedPlanId }, body: baseBody(p1, { isDrafted: 1 }), user: admin });
    assert.equal(b.status, 409);
  });

  await step("update swaps an operator and drops the jig: freed rows are deleted (incl. the jig the legacy sync leaves behind)", async () => {
    const r = await call(controller.update, {
      params: { id: publishedPlanId },
      body: baseBody(p1, { assignedOperators: { "0-0": [{ _id: String(u1._id) }], "0-1": [{ _id: String(u3._id) }] }, assignedJigs: {} }),
      user: admin,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await AssignOperator.countDocuments({ processId: p1._id, userId: u2._id }), 0);
    assert.equal(await AssignOperator.countDocuments({ processId: p1._id, userId: u3._id }), 1);
    assert.equal(await jigRowsFor(p1), 0);
  });

  await step("production counters survive an edit", async () => {
    const plan = await Plan.findById(publishedPlanId).lean();
    const stages = JSON.parse(plan.assignedStages);
    stages["0-0"][0].passedDevice = 17;
    stages["0-0"][0].ngDevice = 2;
    await Plan.updateOne({ _id: publishedPlanId }, { $set: { assignedStages: JSON.stringify(stages) } });
    const r = await call(controller.update, { params: { id: publishedPlanId }, body: baseBody(p1, { assignedOperators: { "0-0": [{ _id: String(u1._id) }], "0-1": [{ _id: String(u3._id) }] }, assignedJigs: {} }), user: admin });
    assert.equal(r.status, 200);
    const after = JSON.parse((await Plan.findById(publishedPlanId).lean()).assignedStages);
    assert.equal(after["0-0"][0].passedDevice, 17);
    assert.equal(after["0-0"][0].ngDevice, 2);
  });

  await step("planned end date: stored, becomes the effective end; capacity numbers stay calculated; clearing restores the calculated end", async () => {
    const ops = { "0-0": [{ _id: String(u1._id) }], "0-1": [{ _id: String(u3._id) }] };
    const planned = new Date(monday);
    planned.setDate(planned.getDate() + 11); // well past the capacity end
    const r = await call(controller.update, { params: { id: publishedPlanId }, body: baseBody(p1, { assignedOperators: ops, assignedJigs: {}, plannedEndDate: formatPlanDate(planned) }), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v = await call(controller.validate, { body: baseBody(p1, { assignedOperators: ops, assignedJigs: {}, plannedEndDate: formatPlanDate(planned) }), user: admin });
    assert.equal(v.body.computed.endKey, dayKeyLocal(planned));
    assert.ok(v.body.computed.capacityEndKey < v.body.computed.endKey);
    const capacityKey = v.body.computed.capacityEndKey;
    const stored = await Plan.findById(publishedPlanId).lean();
    assert.equal(dayKeyLocal(new Date(stored.plannedEndDate)), dayKeyLocal(planned));
    assert.equal(dayKeyLocal(new Date(stored.estimatedEndDate)), dayKeyLocal(planned));
    assert.equal(stored.totalTimeEstimation, "2.50"); // still the capacity-based figure
    // a client cannot set estimatedEndDate directly
    const forged = await call(controller.update, { params: { id: publishedPlanId }, body: baseBody(p1, { assignedOperators: ops, assignedJigs: {}, plannedEndDate: undefined, estimatedEndDate: "01/01/30 00:00:00" }), user: admin });
    assert.equal(forged.status, 200, JSON.stringify(forged.body));
    const cleared = await Plan.findById(publishedPlanId).lean();
    assert.equal(cleared.plannedEndDate ?? null, null);
    assert.equal(dayKeyLocal(new Date(cleared.estimatedEndDate)), capacityKey);
  });

  await step("getPlan returns parsed blobs and the process view", async () => {
    const r = await call(controller.getPlan, { params: { id: publishedPlanId }, user: admin });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.plan.assignedStages, "object");
    assert.equal(r.body.process._id, String(p1._id));
  });

  await step("validate: a conflicting plan on process 2 reports SEAT-001 and the availability endpoint shows the held seats", async () => {
    const body = baseBody(p2, { assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] });
    const v = await call(controller.validate, { body, user: admin });
    const seat = v.body.issues.filter((i) => i.code === "SEAT-001").map((i) => i.seatKey).sort();
    assert.deepEqual(seat, ["0-0", "0-1"]);
    const a = await call(controller.availability, {
      body: { selectedRoom: String(room._id), selectedShift: String(shift._id), startDate: formatPlanDate(monday), estimatedEndDate: v.body.computed.estimatedEndDate },
      user: admin,
    });
    assert.equal(a.status, 200);
    assert.deepEqual(Object.keys(a.body.seats).sort(), ["0-0", "0-1"]);
    assert.equal(a.body.seats["0-0"].processName.startsWith("E2E Process 1"), true);
  });

  let conflictingPlanId;
  await step("warn mode (default): the conflicting save succeeds, returns the issues, and records a would-have-blocked event", async () => {
    const r = await call(controller.create, { body: baseBody(p2, { assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] }), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.validation.issues.some((i) => i.code === "SEAT-001"));
    conflictingPlanId = String(r.body.plan._id);
    const ev = await PlanValidationEvent.findOne({ action: "create", processId: p2._id }).lean();
    assert.equal(ev.mode, "warn");
    assert.equal(ev.wouldHaveBlocked, true);
    assert.equal(ev.blocked, false);
    assert.ok(ev.issues.some((i) => i.code === "SEAT-001"));
    assert.equal(await statusOf(p2), "Waiting_Kits_allocation");
  });

  await step("delete frees the plan's operators/jigs and returns the process to waiting_schedule", async () => {
    const r = await call(controller.remove, { params: { id: conflictingPlanId }, user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.processReset, true);
    assert.equal(await Plan.countDocuments({ _id: conflictingPlanId }), 0);
    assert.equal(await statusOf(p2), "waiting_schedule");
    assert.ok(await ProcessLog.findOne({ action: "PLAN_DELETED", processId: p2._id }));
  });

  await step("enforce mode blocks only the listed codes (422), leaves the process untouched, and records the block", async () => {
    process.env.PLAN_VALIDATION_MODE = "enforce";
    process.env.PLAN_ENFORCED_CODES = "SEAT-001";
    const body = baseBody(p2, { assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] });
    const r = await call(controller.create, { body, user: admin });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.ok(r.body.validation.issues.some((i) => i.code === "SEAT-001"));
    assert.equal(await statusOf(p2), "waiting_schedule");
    assert.equal(await Plan.countDocuments({ selectedProcess: p2._id }), 0);
    const ev = await PlanValidationEvent.findOne({ mode: "enforce", blocked: true }).lean();
    assert.ok(ev);

    // A rule that is not listed does not block
    process.env.PLAN_ENFORCED_CODES = "OPER-001";
    const ok = await call(controller.validate, { body, user: admin });
    assert.equal(ok.status, 200);
  });

  await step("enforce override: needs an admin and a reason of 10+ characters", async () => {
    process.env.PLAN_VALIDATION_MODE = "enforce";
    process.env.PLAN_ENFORCED_CODES = "SEAT-001";
    const body = baseBody(p2, { assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [], overrideReason: "Line 1 is free that week, previous plan finished early" });
    const byManager = await call(controller.create, { body, user: manager });
    assert.equal(byManager.status, 422);
    const short = await call(controller.create, { body: { ...body, overrideReason: "because" }, user: admin });
    assert.equal(short.status, 422);
    const byAdmin = await call(controller.create, { body, user: admin });
    assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
    assert.equal(byAdmin.body.overrideUsed, true);
    const ev = await PlanValidationEvent.findOne({ overrideReason: /Line 1 is free/ }).lean();
    assert.ok(ev);
    resetFlags();
    await call(controller.remove, { params: { id: String(byAdmin.body.plan._id) }, user: admin });
    assert.equal(await statusOf(p2), "waiting_schedule");
  });

  await step("LEGACY compatibility: the old handlers read a v2 plan", async () => {
    const byProcess = await call(legacyPlanning.getPlaningAnDschedulingByProcessId, { params: { id: String(p1._id) } });
    assert.equal(byProcess.status, 200);
    assert.equal(String(byProcess.body._id), publishedPlanId);
    assert.ok(JSON.parse(byProcess.body.assignedStages)["0-0"]);

    const byId = await call(legacyPlanning.getPlaningAnDschedulingByID, { params: { id: publishedPlanId }, user: admin });
    assert.equal(byId.status, 200, JSON.stringify(byId.body).slice(0, 300));

    const plan = await Plan.findById(publishedPlanId).lean();
    const avail = await call(legacyPlanning.checkAvailability, {
      body: {
        roomId: String(room._id),
        shiftId: String(shift._id),
        startDate: formatPlanDate(monday),
        expectedEndDate: formatPlanDate(new Date(plan.estimatedEndDate)),
        shiftDataChange: JSON.stringify({ startTime: "09:00", endTime: "18:00" }),
      },
    });
    assert.equal(avail.status, 200, JSON.stringify(avail.body).slice(0, 300));
    assert.ok((avail.body.plans || []).some((p) => String(p._id) === publishedPlanId), "legacy availability sees the v2 plan");

    const tasks = await call(operatorTask.getTaskByUserID, { params: { id: String(u1._id) }, user: admin });
    assert.equal(tasks.status, 200, JSON.stringify(tasks.body).slice(0, 300));
    assert.ok(Array.isArray(tasks.body.task) && tasks.body.task.length >= 1, "operator sees the process in their task list");
  });

  await step("delete guard: warn lets a risky delete through without freeing rows; enforce blocks it", async () => {
    await Process.updateOne({ _id: p1._id }, { $set: { status: "active" } });
    process.env.PLAN_DELETE_GUARD = "enforce";
    const blocked = await call(controller.remove, { params: { id: publishedPlanId }, user: admin });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(await Plan.countDocuments({ _id: publishedPlanId }), 1);
    process.env.PLAN_DELETE_GUARD = "warn";
    const warned = await call(controller.remove, { params: { id: publishedPlanId }, user: admin });
    assert.equal(warned.status, 200);
    assert.equal(warned.body.processReset, false);
    assert.equal(await statusOf(p1), "active"); // never reset an active process
    assert.ok((await rowsFor(p1)) > 0, "operators on a live process are not freed");
    resetFlags();
  });

  // ---- custom day-wise schedule ------------------------------------------------------------------------
  const p3 = await makeProcess(3);
  const p4 = await makeProcess(4);
  const later = new Date(monday);
  later.setDate(later.getDate() + 28); // a Monday well clear of the other fixtures
  const dayAt = (n) => {
    const d = new Date(later);
    d.setDate(d.getDate() + n);
    return d;
  };
  const cDay = (n, startTime, endTime, over = {}) => ({ dayKey: dayKeyLocal(dayAt(n)), startTime, endTime, breaks: [], unplacedBreakMinutes: 0, working: true, edited: true, note: "", ...over });
  const LUNCH = [{ startTime: "13:00", endTime: "14:00" }];
  const customDays = () => [cDay(0, "09:00", "17:00", { breaks: LUNCH }), cDay(1, "10:00", "14:00"), cDay(2, "08:00", "18:00")];
  const customBody = (proc, extra = {}) =>
    baseBody(proc, {
      selectedShift: "",
      startDate: formatPlanDate(later),
      plannedEndDate: formatPlanDate(dayAt(2)),
      scheduleMode: "custom",
      scheduleDefaults: { startTime: "09:00", endTime: "17:00" },
      daySchedule: customDays(),
      assignedOperators: {},
      assignedJigs: {},
      assignedCustomStagesOp: [],
      ...extra,
    });
  let customPlanId;

  await step("custom schedules are refused while the feature flag is off", async () => {
    delete process.env.PLAN_CUSTOM_SCHEDULE;
    const body = customBody(p3);
    for (const [name, handler] of [["validate", controller.validate], ["create", controller.create], ["availability", controller.availability], ["schedulePreview", controller.schedulePreview]]) {
      const r = await call(handler, { body, user: admin });
      assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.body)}`);
      assert.match(JSON.stringify(r.body), /not enabled/, name);
    }
    assert.equal((await call(controller.lookups, { user: admin })).body.features.customSchedule, false);
    assert.equal(await Plan.countDocuments({ selectedProcess: p3._id }), 0);
    assert.equal(await statusOf(p3), "waiting_schedule");
  });

  process.env.PLAN_CUSTOM_SCHEDULE = "on";

  await step("schedule preview builds the day table from the template and keeps hand-edited days", async () => {
    assert.equal((await call(controller.lookups, { user: admin })).body.features.customSchedule, true);
    const r = await call(controller.schedulePreview, {
      body: baseBody(p3, { startDate: formatPlanDate(later), plannedEndDate: formatPlanDate(dayAt(6)), scheduleDefaults: {}, daySchedule: [cDay(1, "10:00", "14:00")], assignedOperators: {}, assignedJigs: {} }),
      user: admin,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.days.length, 7);
    assert.deepEqual(r.body.days.map((d) => d.working), [true, true, true, true, true, false, false]);
    assert.equal(r.body.days[5].offReason, "weekly_off");
    assert.equal(r.body.days[0].startTime, "09:00");
    assert.equal(r.body.days[0].endTime, "18:00");
    assert.deepEqual(r.body.days[0].breaks, [{ startTime: "13:00", endTime: "14:00" }], "breaks come from the template shift");
    assert.equal(r.body.days[1].startTime, "10:00", "the edited day is kept");
    assert.equal(r.body.days[1].edited, true);
    assert.ok(r.body.problems.some((p) => p.code === "SCH-008"));
    assert.equal(r.body.template.productiveMinutes, 480);
    assert.equal(r.body.suggestion, null, "extend-to-fit only runs when asked");

    const noHours = await call(controller.schedulePreview, { body: baseBody(p3, { selectedShift: "", startDate: formatPlanDate(later), plannedEndDate: formatPlanDate(dayAt(2)), scheduleDefaults: {} }), user: admin });
    assert.equal(noHours.status, 400);
    const noEnd = await call(controller.schedulePreview, { body: baseBody(p3, { plannedEndDate: undefined }), user: admin });
    assert.equal(noEnd.status, 400);
  });

  await step("extend-to-fit suggests the end date that covers the quantity", async () => {
    const r = await call(controller.schedulePreview, {
      body: baseBody(p3, { startDate: formatPlanDate(later), plannedEndDate: formatPlanDate(dayAt(1)), scheduleDefaults: {}, daySchedule: [cDay(1, "10:00", "14:00")], extendToFit: true, assignedOperators: {}, assignedJigs: {} }),
      user: admin,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // quantity 800 at 40/h: Mon 8h = 320, Tue (edited) 4h = 160, Wed 8h = 320 -> covered on Wednesday
    assert.deepEqual(r.body.suggestion && [r.body.suggestion.extraDays, r.body.suggestion.endKey], [1, dayKeyLocal(dayAt(2))]);
  });

  await step("validate: a custom plan is judged day by day, with no shift needed", async () => {
    const r = await call(controller.validate, { body: customBody(p3), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.summary.errors, 0, JSON.stringify(r.body.issues));
    assert.equal(r.body.computed.scheduleMode, "custom");
    assert.deepEqual(r.body.computed.days.map((d) => d.plannedUnits), [280, 160, 360]);
    assert.equal(r.body.computed.shortfallUnits, 0);
    assert.equal(r.body.computed.forecastEndKey, dayKeyLocal(dayAt(2)));
    assert.equal(r.body.computed.startKey, dayKeyLocal(later));
    const broken = await call(controller.validate, { body: customBody(p3, { daySchedule: [cDay(0, "21:00", "05:00"), cDay(1, "02:00", "08:00")] }), user: admin });
    assert.ok(broken.body.issues.some((i) => i.code === "SCH-003"));
  });

  await step("create a published custom plan: schedule stored, summary fields written for older screens", async () => {
    const r = await call(controller.create, { body: customBody(p3), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    customPlanId = String(r.body.plan._id);
    const plan = await Plan.findById(customPlanId).lean();
    assert.equal(plan.scheduleMode, "custom");
    assert.equal(plan.daySchedule.length, 3);
    assert.deepEqual(plan.daySchedule[0].breaks, LUNCH);
    assert.equal(plan.daySchedule[1].startTime, "10:00");
    assert.equal(plan.daySchedule[1].edited, true);
    assert.equal(plan.selectedShift ?? null, null, "no template shift was chosen");
    assert.equal(plan.scheduleDefaults.startTime, "09:00");
    assert.equal(plan.ProcessShiftMappings.startTime, "09:00", "the first working day's hours");
    assert.equal(plan.ProcessShiftMappings.endTime, "17:00");
    assert.equal(plan.ProcessShiftMappings.formattedShiftDate, formatPlanDate(later));
    assert.equal(dayKeyLocal(new Date(plan.estimatedEndDate)), dayKeyLocal(dayAt(2)), "the last scheduled day");
    assert.equal(plan.totalUPHA, "280.00", "average output per scheduled day");
    assert.equal(plan.totalTimeEstimation, "2.90");
    assert.equal(await statusOf(p3), "Waiting_Kits_allocation");
  });

  await step("a shift plan is still stored without any of the new fields", async () => {
    const r = await call(controller.create, { body: baseBody(p4, { startDate: formatPlanDate(dayAt(14)), assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] }), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const raw = await Plan.collection.findOne({ _id: r.body.plan._id });
    ["scheduleMode", "daySchedule", "scheduleDefaults"].forEach((field) => assert.ok(!(field in raw), `${field} must not be written for a shift plan`));
    await call(controller.remove, { params: { id: String(r.body.plan._id) }, user: admin });
    assert.equal(await statusOf(p4), "waiting_schedule");
  });

  await step("getPlan returns the schedule, and the legacy handlers read a plan that has no shift", async () => {
    const got = await call(controller.getPlan, { params: { id: customPlanId }, user: admin });
    assert.equal(got.status, 200);
    assert.equal(got.body.plan.scheduleMode, "custom");
    assert.equal(got.body.plan.daySchedule.length, 3);
    const byProcess = await call(legacyPlanning.getPlaningAnDschedulingByProcessId, { params: { id: String(p3._id) } });
    assert.equal(byProcess.status, 200);
    assert.equal(String(byProcess.body._id), customPlanId);
    const byId = await call(legacyPlanning.getPlaningAnDschedulingByID, { params: { id: customPlanId }, user: admin });
    assert.equal(byId.status, 200, JSON.stringify(byId.body).slice(0, 300));
    const list = await call(legacyPlanning.view, { query: {}, user: admin });
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
  });

  await step("the legacy update refuses a custom plan instead of overwriting its shift fields", async () => {
    const r = await call(legacyPlanning.update, { params: { id: customPlanId }, body: { selectedShift: String(shift._id) }, user: admin });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /custom day-wise schedule/);
    const plan = await Plan.findById(customPlanId).lean();
    assert.equal(plan.selectedShift ?? null, null, "untouched");
  });

  await step("conflicts are judged on each day's hours: an overlapping day clashes, a different time of day does not", async () => {
    const same = await call(controller.validate, { body: customBody(p4, { startDate: formatPlanDate(dayAt(1)), plannedEndDate: formatPlanDate(dayAt(1)), daySchedule: [cDay(1, "11:00", "13:00")] }), user: admin });
    assert.ok(same.body.issues.some((i) => i.code === "SEAT-001"), "Tuesday 11:00-13:00 is inside the other plan's 10:00-14:00");
    const evening = await call(controller.validate, { body: customBody(p4, { startDate: formatPlanDate(dayAt(1)), plannedEndDate: formatPlanDate(dayAt(1)), daySchedule: [cDay(1, "15:00", "19:00")] }), user: admin });
    assert.ok(!evening.body.issues.some((i) => i.code === "SEAT-001"), "after the other plan's Tuesday hours");
    const otherDay = await call(controller.validate, { body: customBody(p4, { startDate: formatPlanDate(dayAt(7)), plannedEndDate: formatPlanDate(dayAt(7)), daySchedule: [cDay(7, "10:00", "14:00")] }), user: admin });
    assert.ok(!otherDay.body.issues.some((i) => i.code === "SEAT-001"), "a different date");
    const availability = await call(controller.availability, { body: { selectedRoom: String(room._id), scheduleMode: "custom", startDate: formatPlanDate(dayAt(1)), daySchedule: [cDay(1, "11:00", "13:00")], planId: "" }, user: admin });
    assert.equal(availability.status, 200, JSON.stringify(availability.body));
    assert.ok(availability.body.seats["0-0"], "the seat is held at that time");
    const free = await call(controller.availability, { body: { selectedRoom: String(room._id), scheduleMode: "custom", startDate: formatPlanDate(dayAt(1)), daySchedule: [cDay(1, "15:00", "19:00")] }, user: admin });
    assert.ok(!free.body.seats["0-0"], "the seat is free in the evening");
  });

  await step("switching a custom plan back to a shift plan clears the schedule", async () => {
    const r = await call(controller.update, {
      params: { id: customPlanId },
      body: baseBody(p3, { startDate: formatPlanDate(later), scheduleMode: "shift", assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] }),
      user: admin,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const plan = await Plan.findById(customPlanId).lean();
    assert.equal(plan.scheduleMode, "shift");
    assert.deepEqual(plan.daySchedule, []);
    assert.equal(plan.scheduleDefaults ?? null, null);
    assert.equal(String(plan.selectedShift), String(shift._id));
    assert.equal(plan.ProcessShiftMappings.startTime, "09:00");
    assert.equal(plan.ProcessShiftMappings.endTime, "18:00");
    await call(controller.remove, { params: { id: customPlanId }, user: admin });
    delete process.env.PLAN_CUSTOM_SCHEDULE;
  });

  await step("legacy read paths survive a custom plan with no shift, and the operator's task carries the schedule", async () => {
    process.env.PLAN_CUSTOM_SCHEDULE = "on";
    const p5 = await makeProcess(5);
    const u9 = await makeUser(9);
    const r = await call(controller.create, {
      body: customBody(p5, {
        startDate: formatPlanDate(dayAt(35)),
        plannedEndDate: formatPlanDate(dayAt(37)),
        daySchedule: [cDay(35, "09:00", "17:00", { breaks: LUNCH }), cDay(36, "10:00", "14:00"), cDay(37, "08:00", "18:00")],
        assignedOperators: { "0-0": [{ _id: String(u9._id) }] },
      }),
      user: admin,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const planId = String(r.body.plan._id);
    assert.equal(await AssignOperator.countDocuments({ processId: p5._id, userId: u9._id }), 1, "the operator was assigned");

    const insights = await call(legacyPlanning.getPlanInsights, { params: { id: planId }, query: {}, user: admin });
    assert.equal(insights.status, 200, JSON.stringify(insights.body).slice(0, 300));
    const dateWise = await call(legacyPlanning.getPlaningAndSchedulingDateWise, { query: { startDate: dayKeyLocal(dayAt(30)), endDate: dayKeyLocal(dayAt(45)) }, user: admin });
    assert.equal(dateWise.status, 200, JSON.stringify(dateWise.body).slice(0, 300));
    assert.ok((dateWise.body.plans || []).some((p) => String(p._id) === planId), "the date-wise list includes it");
    const all = await call(legacyPlanning.fetchAllPlaningModel, { user: admin });
    assert.equal(all.status, 200);
    const detail = await call(legacyPlanning.getPlaningAnDschedulingByID, { params: { id: planId }, user: admin });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.scheduleMode, "custom", "the detail handler passes the mode on so the legacy screens can react");
    assert.equal(detail.body.daySchedule.length, 3);

    const tasks = await call(operatorTask.getTaskByUserID, { params: { id: String(u9._id) }, user: admin });
    assert.equal(tasks.status, 200, JSON.stringify(tasks.body).slice(0, 300));
    const row = tasks.body.task.find((t) => String(t.processId) === String(p5._id));
    assert.ok(row, "the operator sees the process");
    assert.equal(row.ProcessShiftMappings.startTime, "09:00", "older screens still get a single window");
    assert.equal(row.planDetails.scheduleMode, "custom");
    assert.equal(row.planDetails.daySchedule.length, 3, "and the new screen can show today's hours");

    await call(controller.remove, { params: { id: planId }, user: admin });
    delete process.env.PLAN_CUSTOM_SCHEDULE;
  });

  // ---- editing a plan that is already in progress (edit guards, review, revision, change log) -----------------
  const AssignKits = require("../models/assignKitsToLine");
  const WorkSession = require("../models/operatorWorkSession");
  const p6 = await makeProcess(6);
  const u10 = await makeUser(10);
  const u11 = await makeUser(11);
  const editStart = formatPlanDate(dayAt(70));
  const editBody = (extra = {}) =>
    baseBody(p6, {
      startDate: editStart,
      assignedOperators: { "0-0": [{ _id: String(u10._id) }], "0-1": [{ _id: String(u11._id) }] },
      assignedJigs: {},
      assignedCustomStagesOp: [],
      ...extra,
    });
  let editPlanId;
  const stageEntries = (map) => Object.fromEntries(Object.entries(map).map(([k, name]) => [k, [entry(name, name === "Visual Inspection" ? 50 : 40)]]));

  await step("edit guards: the plan opens with a revision and what has happened on it", async () => {
    process.env.PLAN_EDIT_GUARD = "enforce";
    const r = await call(controller.create, { body: editBody(), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    editPlanId = String(r.body.plan._id);
    // production has happened on seat 0-0: 17 devices
    const plan = await Plan.findById(editPlanId).lean();
    const stages = JSON.parse(plan.assignedStages);
    stages["0-0"][0].passedDevice = 17;
    await Plan.updateOne({ _id: editPlanId }, { $set: { assignedStages: JSON.stringify(stages) } });
    const got = await call(controller.getPlan, { params: { id: editPlanId }, user: admin });
    assert.equal(got.status, 200);
    assert.match(got.body.revision, /^[0-9a-f]{16}$/);
    assert.equal(got.body.editGuardMode, "enforce");
    assert.equal(got.body.footprint.started, true);
    assert.deepEqual(got.body.footprint.seatsWithOutput, ["0-0"]);
    assert.equal(got.body.footprint.kitsAssigned, false);
  });

  await step("edit guards: a stage with output cannot be replaced; extra seats and other changes are fine", async () => {
    const swapped = await call(controller.update, { params: { id: editPlanId }, body: editBody({ assignedStages: stageEntries({ "0-0": "Functional", "0-1": "Visual Inspection" }) }), user: admin });
    assert.equal(swapped.status, 422, JSON.stringify(swapped.body));
    assert.ok(swapped.body.validation.issues.some((i) => i.code === "EDIT-002" && i.seatKey === "0-0"));
    assert.deepEqual(swapped.body.guard.blocking.map((i) => i.code), ["EDIT-002"]);
    const stored = JSON.parse((await Plan.findById(editPlanId).lean()).assignedStages);
    assert.equal(stored["0-0"][0].name, "Visual Inspection", "nothing was written");
    assert.equal(stored["0-0"][0].passedDevice, 17, "the counter is untouched");

    const moved = await call(controller.update, { params: { id: editPlanId }, body: editBody({ assignedStages: stageEntries({ "0-3": "Visual Inspection", "0-1": "Functional" }), assignedOperators: { "0-3": [{ _id: String(u10._id) }], "0-1": [{ _id: String(u11._id) }] } }), user: admin });
    assert.equal(moved.status, 422, "moving it to another seat is refused too");

    const more = await call(controller.update, { params: { id: editPlanId }, body: editBody({ assignedStages: stageEntries({ "0-0": "Visual Inspection", "0-1": "Functional", "0-2": "Visual Inspection" }) }), user: admin });
    assert.equal(more.status, 200, JSON.stringify(more.body));
    const after = JSON.parse((await Plan.findById(editPlanId).lean()).assignedStages);
    assert.equal(after["0-0"][0].passedDevice, 17, "the counter survives");
    assert.equal(Object.keys(after).length, 3);
  });

  await step("edit guards: review shows what would change and whether it is allowed, and writes nothing", async () => {
    const before = await Plan.collection.findOne({ _id: new mongoose.Types.ObjectId(editPlanId) });
    const moreSeats = stageEntries({ "0-0": "Visual Inspection", "0-1": "Functional", "0-2": "Visual Inspection", "0-4": "Functional" });
    // with the end date left on "calculated", more capacity moves the end date, and the review says so
    const unpinned = await call(controller.review, { params: { id: editPlanId }, body: editBody({ assignedStages: moreSeats }), user: admin });
    assert.ok(unpinned.body.changes.some((c) => c.kind === "endDate"), "the end date would change with the seats");
    // the edit page keeps the stored end date and hours unless the planner changes them
    const saved = await Plan.findById(editPlanId).lean();
    const pinned = { plannedEndDate: formatPlanDate(new Date(saved.estimatedEndDate)), ProcessShiftMappings: { startTime: saved.ProcessShiftMappings.startTime, endTime: saved.ProcessShiftMappings.endTime } };
    const allowed = await call(controller.review, { params: { id: editPlanId }, body: editBody({ ...pinned, assignedStages: moreSeats }), user: admin });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.canSave, true);
    assert.deepEqual(allowed.body.changes.map((c) => c.kind), ["seat"]);
    assert.match(allowed.body.changes[0].text, /Functional is added to Line 01 · Seat 5/);
    assert.match(allowed.body.summary, /1 change: 1 seat/);
    assert.equal(allowed.body.footprint.started, true);
    assert.ok(allowed.body.after.unitsPerDay > 0 && allowed.body.before.unitsPerDay > 0);

    const refused = await call(controller.review, { params: { id: editPlanId }, body: editBody({ assignedStages: stageEntries({ "0-0": "Functional", "0-1": "Visual Inspection", "0-2": "Visual Inspection" }) }), user: admin });
    assert.equal(refused.status, 200);
    assert.equal(refused.body.canSave, false);
    assert.ok(refused.body.guard.blocking.some((i) => i.code === "EDIT-002"));
    assert.equal(refused.body.overrideAllowed, true, "an administrator may override with a reason");

    const raw = await Plan.collection.findOne({ _id: new mongoose.Types.ObjectId(editPlanId) });
    assert.deepEqual(raw, before, "review writes nothing");
  });

  await step("edit guards: an operator with an open work session can be replaced, with a warning", async () => {
    await WorkSession.create({ operatorId: u10._id, processId: p6._id, planId: editPlanId, status: "active", startedAt: new Date() });
    const removed = await call(controller.update, { params: { id: editPlanId }, body: editBody({ assignedOperators: { "0-1": [{ _id: String(u11._id) }] }, assignedStages: stageEntries({ "0-0": "Visual Inspection", "0-1": "Functional", "0-2": "Visual Inspection" }) }), user: admin });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const stored = JSON.parse((await Plan.collection.findOne({ _id: new mongoose.Types.ObjectId(editPlanId) })).assignedOperators);
    assert.equal(String(stored["0-1"][0]._id), String(u11._id), "the operator was changed");
    await WorkSession.deleteMany({ processId: p6._id });
    const freed = await call(controller.update, { params: { id: editPlanId }, body: editBody({ assignedOperators: { "0-1": [{ _id: String(u11._id) }] }, assignedStages: stageEntries({ "0-0": "Visual Inspection", "0-1": "Functional", "0-2": "Visual Inspection" }) }), user: admin });
    assert.equal(freed.status, 200);
    await call(controller.update, { params: { id: editPlanId }, body: editBody({ assignedStages: stageEntries({ "0-0": "Visual Inspection", "0-1": "Functional", "0-2": "Visual Inspection" }) }), user: admin });
  });

  await step("edit guards: a seat with kits issued keeps its stage", async () => {
    await AssignKits.create({ planId: editPlanId, processId: p6._id, issuedKits: 100, seatDetails: [{ rowNumber: "0", seatNumber: "1", issuedKits: 100 }], issuedKitsStatus: "ISSUED", status: "CONFIRM" });
    const same = stageEntries({ "0-0": "Visual Inspection", "0-1": "Functional", "0-2": "Visual Inspection" });
    const changed = await call(controller.update, { params: { id: editPlanId }, body: editBody({ assignedStages: { ...same, "0-1": [entry("Visual Inspection", 50)] } }), user: admin });
    assert.equal(changed.status, 422, JSON.stringify(changed.body));
    assert.ok(changed.body.validation.issues.some((i) => i.code === "EDIT-003" && i.seatKey === "0-1"));
    const floor = await Room.create({ floorName: "E2E Floor B", lines: [{ rowName: "Line 01", seats: Array.from({ length: 6 }, (_, s) => ({ seatNumber: String(s + 1) })) }] });
    const moved = await call(controller.update, { params: { id: editPlanId }, body: editBody({ selectedRoom: String(floor._id), assignedStages: same }), user: admin });
    assert.equal(moved.status, 422);
    assert.ok(moved.body.validation.issues.some((i) => i.code === "EDIT-004"));
    await AssignKits.deleteMany({ planId: editPlanId });
  });

  await step("edit guards: warn mode shows the findings without blocking, an administrator can override with a reason, and manager roles cannot", async () => {
    const swap = editBody({ assignedStages: stageEntries({ "0-0": "Functional", "0-1": "Visual Inspection", "0-2": "Visual Inspection" }) });
    process.env.PLAN_EDIT_GUARD = "warn";
    const warned = await call(controller.update, { params: { id: editPlanId }, body: swap, user: admin });
    assert.equal(warned.status, 200, JSON.stringify(warned.body));
    assert.ok(warned.body.validation.issues.some((i) => i.code === "EDIT-002"), "reported, not blocking");
    // put it back for the next checks
    await Plan.updateOne({ _id: editPlanId }, { $set: { assignedStages: JSON.stringify(Object.fromEntries(Object.entries(stageEntries({ "0-0": "Visual Inspection", "0-1": "Functional", "0-2": "Visual Inspection" })).map(([k, v]) => [k, k === "0-0" ? [{ ...v[0], passedDevice: 17 }] : v]))) } });

    process.env.PLAN_EDIT_GUARD = "enforce";
    const byManager = await call(controller.update, { params: { id: editPlanId }, body: { ...swap, overrideReason: "The two seats were labelled the wrong way round" }, user: manager });
    assert.equal(byManager.status, 422);
    const short = await call(controller.update, { params: { id: editPlanId }, body: { ...swap, overrideReason: "oops" }, user: admin });
    assert.equal(short.status, 422);
    const byAdmin = await call(controller.update, { params: { id: editPlanId }, body: { ...swap, overrideReason: "The two seats were labelled the wrong way round" }, user: admin });
    assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
    assert.equal(byAdmin.body.overrideUsed, true);
    await Plan.updateOne({ _id: editPlanId }, { $set: { assignedStages: JSON.stringify(Object.fromEntries(Object.entries(stageEntries({ "0-0": "Visual Inspection", "0-1": "Functional", "0-2": "Visual Inspection" })).map(([k, v]) => [k, k === "0-0" ? [{ ...v[0], passedDevice: 17 }] : v]))) } });

    process.env.PLAN_EDIT_GUARD = "off";
    const off = await call(controller.review, { params: { id: editPlanId }, body: swap, user: admin });
    assert.equal(off.body.guard.blocking.length, 0);
    assert.ok(!off.body.issues.some((i) => i.code.startsWith("EDIT-")), "off: not evaluated");
    process.env.PLAN_EDIT_GUARD = "enforce";
  });

  await step("two people editing at once: the second save is refused, and a save returns the new revision", async () => {
    const opened = await call(controller.getPlan, { params: { id: editPlanId }, user: admin });
    const rev = opened.body.revision;
    const body = editBody({ assignedStages: stageEntries({ "0-0": "Visual Inspection", "0-1": "Functional", "0-2": "Visual Inspection" }), assignedOperators: { "0-0": [{ _id: String(u10._id) }], "0-1": [{ _id: String(u11._id) }] } });
    const first = await call(controller.update, { params: { id: editPlanId }, body: { ...body, baseRevision: rev, assignedJigs: { "0-1": [{ _id: String(j1._id) }] } }, user: admin });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.notEqual(first.body.revision, rev, "the save changed the plan, so the fingerprint changed");
    const second = await call(controller.update, { params: { id: editPlanId }, body: { ...body, baseRevision: rev }, user: admin });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.code, "REVISION_CONFLICT");
    const review = await call(controller.review, { params: { id: editPlanId }, body: { ...body, baseRevision: rev }, user: admin });
    assert.equal(review.body.revisionOk, false);
    assert.equal(review.body.canSave, false);
    const fresh = await call(controller.update, { params: { id: editPlanId }, body: { ...body, assignedJigs: { "0-1": [{ _id: String(j1._id) }] }, baseRevision: first.body.revision }, user: admin });
    assert.equal(fresh.status, 200, "with the current revision it saves");
    const noRevision = await call(controller.update, { params: { id: editPlanId }, body, user: admin });
    assert.equal(noRevision.status, 200, "a caller that sends no revision keeps working");
  });

  await step("the change log says what changed", async () => {
    const logs = await ProcessLog.find({ action: "PLANING_UPDATED", processId: p6._id }).sort({ _id: -1 }).lean();
    assert.ok(logs.length >= 3);
    assert.ok(logs.some((l) => /\d+ changes?: /.test(l.description || l.message || "")), JSON.stringify(logs[0]));
    assert.ok(logs.some((l) => /No changes\./.test(l.description || l.message || "")), "a save with nothing changed says so");
  });

  await step("edit guards: a completed process is read-only, and a draft plan is never blocked", async () => {
    await Process.updateOne({ _id: p6._id }, { $set: { status: "completed" } });
    const done = await call(controller.update, { params: { id: editPlanId }, body: editBody(), user: admin });
    assert.equal(done.status, 409);
    const review = await call(controller.review, { params: { id: editPlanId }, body: editBody(), user: admin });
    assert.ok(review.body.issues.some((i) => i.code === "EDIT-001"));
    assert.equal(review.body.canSave, false);
    await Process.updateOne({ _id: p6._id }, { $set: { status: "Waiting_Kits_allocation" } });

    const p7 = await makeProcess(7);
    const draft = await call(controller.create, { body: baseBody(p7, { isDrafted: 1, startDate: formatPlanDate(dayAt(80)), assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] }), user: admin });
    assert.equal(draft.status, 200);
    const reDraft = await call(controller.update, { params: { id: String(draft.body.plan._id) }, body: baseBody(p7, { isDrafted: 1, startDate: formatPlanDate(dayAt(80)), assignedStages: { "0-0": [entry("Functional", 40)] }, assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] }), user: admin });
    assert.equal(reDraft.status, 200, "a draft has no activity to protect");
    assert.ok(!reDraft.body.validation.issues.some((i) => i.code.startsWith("EDIT-")));
    delete process.env.PLAN_EDIT_GUARD;
  });

  // ---- read-only views: the plan overview and the schedule board ---------------------------------------------
  const DeviceTest = require("../models/deviceTestModel");
  const p8 = await makeProcess(8);
  const viewStart = dayAt(98); // a Monday
  let viewPlanId;

  await step("overview: planned against actual output, day by day, for a published plan", async () => {
    const r = await call(controller.create, { body: baseBody(p8, { startDate: formatPlanDate(viewStart), assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] }), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    viewPlanId = String(r.body.plan._id);
    const at = (n, h) => {
      const d = dayAt(n);
      d.setHours(h, 0, 0, 0);
      return d;
    };
    const record = (n, stageName, status, count) =>
      Array.from({ length: count }, () => ({ planId: viewPlanId, processId: p8._id, stageName, status, seatNumber: stageName === "Functional" ? "0-1" : "0-0", createdAt: at(n, 12) }));
    await DeviceTest.insertMany([
      ...record(99, "Functional", "Pass", 12),
      ...record(99, "Functional", "NG", 3),
      ...record(99, "Visual Inspection", "Pass", 20),
      ...record(99, "Functional", "Resolved", 5), // not output
      ...record(103, "Functional", "Pass", 4), // a Saturday: outside the scheduled days
    ]);

    const o = await call(controller.overview, { params: { id: viewPlanId }, user: admin });
    assert.equal(o.status, 200, JSON.stringify(o.body).slice(0, 300));
    assert.equal(o.body.plan.mode, "shift");
    assert.equal(o.body.plan.startKey, dayKeyLocal(viewStart));
    assert.equal(o.body.process.lastStage, "Functional");
    assert.equal(o.body.process.quantity, 800);
    const tue = o.body.days.find((d) => d.dayKey === dayKeyLocal(dayAt(99)));
    assert.deepEqual([tue.finished, tue.passedAny, tue.failed], [12, 32, 3], "only passes at the last stage are finished");
    assert.ok(tue.plannedUnits > 0 && tue.startTime === "09:00");
    assert.equal(o.body.days[0].setupDay, true);
    assert.deepEqual(o.body.outside.map((d) => [d.dayKey, d.finished]), [[dayKeyLocal(dayAt(103)), 4]]);
    assert.equal(o.body.totals.finished, 16);
    assert.equal(o.body.totals.failed, 3);
    assert.equal(o.body.totals.remaining, 784);
    assert.equal(o.body.progress.state, "not_started", "the plan is months away");
    assert.deepEqual(o.body.stages.map((s) => [s.name, s.seats, s.passed, s.failed]), [["Visual Inspection", 1, 20, 0], ["Functional", 1, 16, 3]]);
    assert.equal(o.body.footprint.started, true, "recorded output counts as started");
    assert.ok(o.body.history.some((h) => h.action === "CREATE" && /planned by/.test(h.description)));
    assert.equal(o.body.history[0].by, "", "the log user is not a stored user in this scratch database");
    assert.ok(o.body.room.lines.length === 2 && o.body.seats.stages["0-0"]);
  });

  await step("overview: a draft, an unknown plan and a bad id are handled", async () => {
    const p9 = await makeProcess(9);
    const draft = await call(controller.create, { body: baseBody(p9, { isDrafted: 1, startDate: formatPlanDate(viewStart), assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] }), user: admin });
    const r = await call(controller.overview, { params: { id: String(draft.body.plan._id) }, user: admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.isDrafted, true);
    assert.equal(r.body.footprint, null);
    assert.equal(r.body.totals.finished, 0);
    assert.equal((await call(controller.overview, { params: { id: String(oid()) }, user: admin })).status, 404);
    assert.equal((await call(controller.overview, { params: { id: "nope" }, user: admin })).status, 400);
  });

  await step("schedule board: plans across days with planned and actual output, clipped to the range", async () => {
    const board = await call(controller.scheduleBoard, { query: { from: dayKeyLocal(viewStart), to: dayKeyLocal(dayAt(104)), room: String(room._id) }, user: admin });
    assert.equal(board.status, 200, JSON.stringify(board.body).slice(0, 300));
    assert.ok(board.body.rooms.some((r) => r._id === String(room._id) && r.lines.length === 2), "the floors come with the board");
    const row = board.body.plans.find((p) => p.planId === viewPlanId);
    assert.ok(row, "the plan is on the board");
    assert.deepEqual(row.seatKeys.sort(), ["0-0", "0-1"]);
    assert.equal(row.mode, "shift");
    const tue = row.days.find((d) => d.dayKey === dayKeyLocal(dayAt(99)));
    assert.deepEqual([tue.finished, tue.passedAny, tue.failed], [12, 32, 3]);
    assert.deepEqual(row.extraDays.map((d) => [d.dayKey, d.finished]), [[dayKeyLocal(dayAt(103)), 4]]);
    assert.ok(row.days.every((d) => d.dayKey >= dayKeyLocal(viewStart) && d.dayKey <= dayKeyLocal(dayAt(104))));

    // a window that misses the plan, a different floor, and drafts
    const away = await call(controller.scheduleBoard, { query: { from: dayKeyLocal(dayAt(200)), to: dayKeyLocal(dayAt(206)) }, user: admin });
    assert.ok(!away.body.plans.some((p) => p.planId === viewPlanId));
    const otherRoom = await call(controller.scheduleBoard, { query: { from: dayKeyLocal(viewStart), to: dayKeyLocal(dayAt(104)), room: String(oid()) }, user: admin });
    assert.equal(otherRoom.body.plans.length, 0);
    const noDrafts = await call(controller.scheduleBoard, { query: { from: dayKeyLocal(viewStart), to: dayKeyLocal(dayAt(104)) }, user: admin });
    assert.ok(noDrafts.body.plans.every((p) => !p.isDrafted), "drafts are left out unless asked for");
    const withDrafts = await call(controller.scheduleBoard, { query: { from: dayKeyLocal(viewStart), to: dayKeyLocal(dayAt(104)), drafts: "1" }, user: admin });
    assert.ok(withDrafts.body.plans.some((p) => p.isDrafted));
  });

  await step("schedule board: bad ranges are refused", async () => {
    const bad = (query) => call(controller.scheduleBoard, { query, user: admin });
    assert.equal((await bad({})).status, 400);
    assert.equal((await bad({ from: "2026-10-05", to: "nope" })).status, 400);
    assert.equal((await bad({ from: "2026-10-09", to: "2026-10-05" })).status, 400);
    assert.equal((await bad({ from: "2026-01-01", to: "2026-12-31" })).status, 400);
    assert.equal((await bad({ from: "2026-10-05", to: "2026-10-09", room: "zzz" })).status, 400);
  });

  // ---- production figures: the Production tab's endpoint ----------------------------------------------------------
  const KitDoc = require("../models/assignKitsToLine");
  const p10 = await makeProcess(10);
  let opsPlanId;

  await step("operations: pass, NG, stages, kits and planned operators for a plan with output", async () => {
    const r = await call(controller.create, { body: baseBody(p10, { startDate: formatPlanDate(dayAt(110)), assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] }), user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    opsPlanId = String(r.body.plan._id);
    const rec = (stageName, status, count, hour) =>
      Array.from({ length: count }, () => ({ planId: opsPlanId, processId: p10._id, deviceId: oid(), serialNo: `S${Math.random()}`, stageName, status, seatNumber: "0-0", createdAt: new Date(2026, 9, 7, hour, 0, 0) }));
    await DeviceTest.insertMany([
      ...rec("Visual Inspection", "Pass", 10, 9),
      ...rec("Visual Inspection", "NG", 2, 10),
      ...rec("Visual Inspection", "Resolved", 3, 11), // not counted as pass or NG
    ]);
    await KitDoc.create({ planId: opsPlanId, processId: p10._id, issuedKits: 30, status: "CONFIRM", issuedKitsStatus: "ISSUED", seatDetails: [{ rowNumber: "0", seatNumber: "0", issuedKits: 30 }] });

    const o = await call(controller.operations, { params: { id: opsPlanId }, query: {}, user: admin });
    assert.equal(o.status, 200, JSON.stringify(o.body).slice(0, 300));
    assert.equal(o.body.plan.id, opsPlanId);
    assert.equal(o.body.scope.by, "process");
    assert.equal(o.body.scope.plansOnProcess, 1);
    assert.equal(o.body.totals.pass, 10, "only passes count as pass");
    assert.equal(o.body.totals.ng, 2);
    assert.equal(o.body.totals.passRate, 83.3);
    const vi = o.body.stages.find((s) => s.name === "Visual Inspection");
    assert.deepEqual([vi.pass, vi.ng, vi.seats], [10, 2, 1]);
    assert.deepEqual(o.body.stages.map((s) => s.name), ["Visual Inspection", "Functional", "QC Check"], "every stage of the process is listed, in order");
    assert.equal(o.body.kits.lineAllocated, 30);
    assert.equal(o.body.kits.lineStatus, "CONFIRM");
    assert.deepEqual(o.body.kits.seats.map((s) => [s.seatKey, s.kits, s.stageName]), [["0-0", 30, "Visual Inspection"]]);
    assert.equal(o.body.kits.required, 800);
    assert.equal(o.body.process.quantity, 800);
    assert.equal(o.body.totals.lineIssueKits, 30);
  });

  await step("operations: a date range narrows pass and NG, and WIP stays the live position", async () => {
    const inRange = await call(controller.operations, { params: { id: opsPlanId }, query: { from: dayKeyLocal(dayAt(110)), to: dayKeyLocal(dayAt(111)) }, user: admin });
    assert.equal(inRange.status, 200);
    assert.deepEqual([inRange.body.totals.pass, inRange.body.totals.ng], [0, 0], "the records are on 2026-10-07, outside this range");
    assert.equal(inRange.body.scope.wipIsLive, true);
    assert.equal(inRange.body.scope.from, dayKeyLocal(dayAt(110)));
    const onDay = await call(controller.operations, { params: { id: opsPlanId }, query: { from: "2026-10-07", to: "2026-10-07" }, user: admin });
    assert.deepEqual([onDay.body.totals.pass, onDay.body.totals.ng], [10, 2]);
  });

  await step("operations: a plan that has not started, an unknown plan and bad input are handled", async () => {
    const p11 = await makeProcess(11);
    const fresh = await call(controller.create, { body: baseBody(p11, { startDate: formatPlanDate(dayAt(120)), assignedOperators: {}, assignedJigs: {}, assignedCustomStagesOp: [] }), user: admin });
    const r = await call(controller.operations, { params: { id: String(fresh.body.plan._id) }, query: {}, user: admin });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.totals.pass, r.body.totals.ng, r.body.totals.wip], [0, 0, 0]);
    assert.equal(r.body.kits.lineAllocated, 0);
    assert.equal(r.body.kits.lineStatus, null);
    assert.equal((await call(controller.operations, { params: { id: String(oid()) }, query: {}, user: admin })).status, 404);
    assert.equal((await call(controller.operations, { params: { id: "nope" }, query: {}, user: admin })).status, 400);
    assert.equal((await call(controller.operations, { params: { id: opsPlanId }, query: { from: "x" }, user: admin })).status, 400);
    assert.equal((await call(controller.operations, { params: { id: opsPlanId }, query: { from: "2026-10-09", to: "2026-10-01" }, user: admin })).status, 400);
  });

  // ---- stage drawer: summary, device buckets and attempt history (uses the plan with output created above) -----------
  await step("stage detail: summary, buckets and history for a stage with output", async () => {
    const params = (extra = {}) => ({ id: opsPlanId, stage: "Visual Inspection", ...extra });
    const sum = await call(controller.stageSummary, { params: params(), query: {}, user: admin });
    assert.equal(sum.status, 200, JSON.stringify(sum.body).slice(0, 300));
    assert.equal(sum.body.stage.name, "Visual Inspection");
    assert.deepEqual([sum.body.counts.pass, sum.body.counts.ng, sum.body.counts.resolved], [10, 2, 3]);
    assert.equal(sum.body.counts.devices, 12, "resolved records are not attempts");
    assert.equal(sum.body.firstPassYield, 83.3);
    assert.deepEqual(sum.body.bySeat, [{ seatKey: "0-0", pass: 10, ng: 2 }]);

    const pass = await call(controller.stageDevices, { params: params(), query: { bucket: "pass", pageSize: "4" }, user: admin });
    assert.equal(pass.status, 200);
    assert.deepEqual([pass.body.total, pass.body.rows.length, pass.body.page], [10, 4, 1]);
    const page3 = await call(controller.stageDevices, { params: params(), query: { bucket: "pass", pageSize: "4", page: "3" }, user: admin });
    assert.equal(page3.body.rows.length, 2);
    const ng = await call(controller.stageDevices, { params: params(), query: { bucket: "ng" }, user: admin });
    assert.equal(ng.body.total, 2);
    const wip = await call(controller.stageDevices, { params: params(), query: { bucket: "wip" }, user: admin });
    assert.equal(wip.status, 200, JSON.stringify(wip.body).slice(0, 300));
    assert.deepEqual(wip.body.rows.map((r) => r.source), ["resolved", "resolved", "resolved"], "the three resolved devices are back at the stage");
    assert.equal(wip.body.listed, 3);
    assert.ok(wip.body.engineWip >= 3);

    const h1 = await call(controller.stageHistory, { params: params(), query: { limit: "5" }, user: admin });
    assert.equal(h1.status, 200);
    assert.equal(h1.body.total, 15);
    assert.equal(h1.body.rows.length, 5);
    assert.ok(h1.body.nextCursor);
    const seen = new Set(h1.body.rows.map((r) => r.id));
    let cursor = h1.body.nextCursor;
    while (cursor) {
      const next = await call(controller.stageHistory, { params: params(), query: { limit: "5", cursor }, user: admin });
      next.body.rows.forEach((r) => seen.add(r.id));
      cursor = next.body.nextCursor;
    }
    assert.equal(seen.size, 15, "paging by cursor reaches every record once");
    const onlyNg = await call(controller.stageHistory, { params: params(), query: { status: "ng" }, user: admin });
    assert.equal(onlyNg.body.total, 2);
  });

  await step("stage detail: ranges, unknown stages and bad input are handled", async () => {
    const base = { id: opsPlanId, stage: "Visual Inspection" };
    const empty = await call(controller.stageSummary, { params: base, query: { from: "2026-10-08", to: "2026-10-08" }, user: admin });
    assert.equal(empty.body.counts.devices, 0);
    const onDay = await call(controller.stageSummary, { params: base, query: { from: "2026-10-07", to: "2026-10-07" }, user: admin });
    assert.equal(onDay.body.counts.pass, 10);
    const alias = await call(controller.stageSummary, { params: { id: opsPlanId, stage: "visual_inspection" }, query: {}, user: admin });
    assert.equal(alias.body.stage.name, "Visual Inspection", "a stage is found by its alias");
    assert.equal((await call(controller.stageSummary, { params: { id: opsPlanId, stage: "Nope" }, query: {}, user: admin })).status, 404);
    assert.equal((await call(controller.stageSummary, { params: { id: "x", stage: "Visual Inspection" }, query: {}, user: admin })).status, 400);
    assert.equal((await call(controller.stageSummary, { params: base, query: { from: "nope" }, user: admin })).status, 400);
    assert.equal((await call(controller.stageDevices, { params: base, query: { bucket: "all" }, user: admin })).status, 400);
    assert.equal((await call(controller.stageHistory, { params: base, query: { status: "x" }, user: admin })).status, 400);
    assert.equal((await call(controller.stageDevices, { params: { id: String(oid()), stage: "Visual Inspection" }, query: {}, user: admin })).status, 404);
    const idle = await call(controller.stageSummary, { params: { id: opsPlanId, stage: "Functional" }, query: {}, user: admin });
    assert.deepEqual([idle.body.counts.pass, idle.body.counts.ng, idle.body.firstPassYield], [0, 0, null], "a stage nothing has happened on is empty, not an error");
  });

  // ---- hourly: one day, hour by hour -----------------------------------------------------------------------------------
  await step("hourly: output by hour against target, for a day with output and a day without", async () => {
    const h = await call(controller.hourly, { params: { id: opsPlanId }, query: { date: "2026-10-07" }, user: admin });
    assert.equal(h.status, 200, JSON.stringify(h.body).slice(0, 300));
    assert.equal(h.body.mode, "shift");
    assert.equal(h.body.scheduled, false, "the plan starts months later, so 7 Oct is not one of its days");
    assert.equal(h.body.window.startTime, "09:00", "the shift's hours are still used");
    assert.deepEqual(h.body.totals, { pass: 10, ng: 2 });
    const vi = h.body.stages.find((s) => s.name === "Visual Inspection");
    const at = (label) => vi.cells[h.body.buckets.findIndex((b) => b.label === label)];
    assert.deepEqual([at("09:00-10:00").pass, at("09:00-10:00").ng], [10, 0], "the passes were recorded at 09:00");
    assert.deepEqual([at("10:00-11:00").pass, at("10:00-11:00").ng], [0, 2], "the NG at 10:00; the resolved records are not output");
    assert.equal(vi.targetPerHour, 50, "50 units an hour on one seat");
    assert.equal(at("09:00-10:00").target, null, "a day that is not on the plan has no targets");
    assert.equal(h.body.lastStage, "Functional");
    assert.equal(h.body.stages.map((s) => s.name).join(), "Visual Inspection,Functional,QC Check");

    const quiet = await call(controller.hourly, { params: { id: opsPlanId }, query: { date: dayKeyLocal(dayAt(112)) }, user: admin }); // the Monday after the Saturday start
    assert.equal(quiet.status, 200);
    assert.equal(quiet.body.scheduled, true, "a working day of the plan");
    assert.deepEqual(quiet.body.totals, { pass: 0, ng: 0 });
    const quietVi = quiet.body.stages.find((s) => s.name === "Visual Inspection");
    assert.equal(quietVi.cells[quiet.body.buckets.findIndex((b) => b.label === "09:00-10:00")].target, 50, "on a scheduled day the target is 50 units an hour on one seat");
    assert.equal(quietVi.totals.target, 400, "eight productive hours: the 09:00-18:00 shift less the one-hour break");
  });

  await step("hourly: bad input is refused", async () => {
    assert.equal((await call(controller.hourly, { params: { id: opsPlanId }, query: {}, user: admin })).status, 400);
    assert.equal((await call(controller.hourly, { params: { id: opsPlanId }, query: { date: "7-10-2026" }, user: admin })).status, 400);
    assert.equal((await call(controller.hourly, { params: { id: "x" }, query: { date: "2026-10-07" }, user: admin })).status, 400);
    assert.equal((await call(controller.hourly, { params: { id: String(oid()) }, query: { date: "2026-10-07" }, user: admin })).status, 404);
  });

  // ---- CSV exports of the stage lists ------------------------------------------------------------------------------------
  await step("stage exports: the whole filtered list as a CSV download", async () => {
    const download = (fn, req) =>
      new Promise((resolve) => {
        const res = {
          headers: {},
          setHeader(k, v) {
            this.headers[k] = v;
          },
          status(c) {
            this.code = c;
            return this;
          },
          send(text) {
            resolve({ status: this.code, headers: this.headers, text });
          },
          json(body) {
            resolve({ status: this.code, headers: this.headers, body });
          },
        };
        fn({ params: {}, query: {}, body: {}, user: admin, ...req }, res);
      });
    const params = { id: opsPlanId, stage: "Visual Inspection" };
    const pass = await download(controller.stageDevices, { params, query: { bucket: "pass", format: "csv", pageSize: "3" } });
    assert.equal(pass.status, 200, pass.body ? JSON.stringify(pass.body) : "");
    assert.match(pass.headers["Content-Type"], /text\/csv/);
    assert.match(pass.headers["Content-Disposition"], /^attachment; filename="[A-Za-z0-9._-]+\.csv"$/);
    assert.ok(pass.text.startsWith("﻿Serial,Seat,Operator"), "starts with the byte-order mark and the header");
    assert.equal(pass.text.split("\r\n").length, 11, "all 10 passed devices, whatever the page size, plus the header");
    const history = await download(controller.stageHistory, { params, query: { format: "csv", status: "ng" } });
    assert.equal(history.text.split("\r\n").length, 3, "2 NG attempts plus the header");
    const everything = await download(controller.stageHistory, { params, query: { format: "csv" } });
    assert.equal(everything.text.split("\r\n").length, 16, "all 15 attempts plus the header");
    const wip = await download(controller.stageDevices, { params, query: { bucket: "wip", format: "csv" } });
    assert.ok(wip.text.includes("Resolved, back at this stage"));
    const bad = await download(controller.stageDevices, { params, query: { bucket: "nope", format: "csv" } });
    assert.equal(bad.status, 400, "errors are still JSON, not a file");
  });

  // ---- kits movements and NG ---------------------------------------------------------------------------------------------
  await step("kits and NG: the timeline of kit movements and the NG picture", async () => {
    const Allocation = require("../models/kitAllocationTransaction");
    const Return = require("../models/returnKitToStore");
    await Allocation.create({ processId: p10._id, iapNo: "IAP-T1", quantity: 40, allocatedAt: new Date(2026, 9, 1, 10) });
    await Return.create({ processId: p10._id, returnedKits: 5, userId: admin._id || oid(), status: "RECIVED", createdAt: new Date(2026, 9, 2, 10) });
    const r = await call(controller.kitsAndNg, { params: { id: opsPlanId }, user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const kinds = r.body.kits.events.map((e) => e.kind);
    assert.ok(kinds.includes("store_allocation") && kinds.includes("return") && kinds.includes("line_allocation") && kinds.includes("line_confirmed"));
    const times = r.body.kits.events.map((e) => new Date(e.at).getTime());
    assert.deepEqual(times, times.slice().sort((a, b) => a - b));
    assert.equal(r.body.kits.totals.allocatedByStore, 40);
    assert.equal(r.body.kits.totals.returnedToStore, 5);
    assert.equal(r.body.kits.totals.onTheLine, 30, "the line allocation made earlier in this run");
    assert.equal(r.body.process.issuedKits, 0);
    assert.equal(r.body.ng.open, 2, "the two NG devices at Visual Inspection");
    assert.deepEqual(r.body.ng.byStage.map((s) => [s.stage, s.ng]), [["Visual Inspection", 2]]);
    assert.equal(r.body.ng.reasons[0].reason, "No reason recorded");
    assert.equal((await call(controller.kitsAndNg, { params: { id: "x" }, user: admin })).status, 400);
    assert.equal((await call(controller.kitsAndNg, { params: { id: String(oid()) }, user: admin })).status, 404);
  });

  // ---- operator day timeline ----------------------------------------------------------------------------------------------
  await step("operator timeline: testing, breaks, logged idle and milestones for one day", async () => {
    const Session = require("../models/operatorWorkSession");
    const IdleLog = require("../models/operatorIdleLog");
    const opA = oid();
    const opB = oid();
    const local = (h, m = 0) => new Date(2026, 9, 7, h, m, 0);
    const attempt = (operatorId, stageName, from, to) => ({ planId: opsPlanId, processId: p10._id, deviceId: oid(), serialNo: `T${Math.random()}`, operatorId, stageName, status: "Pass", seatNumber: "0-0", startTime: from, endTime: to, testDurationMs: to - from, createdAt: to });
    await DeviceTest.insertMany([
      attempt(opA, "Visual Inspection", local(9, 30), local(9, 40)),
      attempt(opA, "Visual Inspection", local(9, 35), local(9, 45)), // overlaps the first
      attempt(opA, "Visual Inspection", local(11, 0), local(11, 10)),
      attempt(opB, "Functional", local(10, 0), local(10, 5)),
    ]);
    await Session.create({ operatorId: opA, processId: p10._id, planId: opsPlanId, status: "completed", startedAt: local(9, 0), endedAt: local(12, 0), explicitlyStarted: true });
    // a session left "closed" days later must not stretch the day
    await Session.create({ operatorId: opB, processId: p10._id, planId: opsPlanId, status: "completed", startedAt: local(9, 30), endedAt: new Date(2026, 9, 12, 9, 30), explicitlyStarted: true });
    await IdleLog.create({ operatorId: opA, processId: p10._id, planId: opsPlanId, idleStartTime: local(10, 0), idleEndTime: local(10, 20), durationMs: 20 * 60000, reasonCode: "MATERIAL_WAITING", reasonLabel: "Material Waiting", category: "DOWNTIME", remarks: "kits late" });

    const r = await call(controller.operatorTimeline, { params: { id: opsPlanId }, query: { date: "2026-10-07" }, user: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.scheduled, false);
    assert.equal(r.body.window.startTime, "09:00");
    const a = r.body.operators.find((o) => o.id === String(opA));
    assert.ok(a, "operator A is on the timeline");
    assert.deepEqual(a.segments.filter((s) => s.type === "test").map((s) => [s.startMin, s.endMin]), [[570, 585], [660, 670]], "the overlapping attempts are merged");
    assert.equal(a.totals.testMs, 25 * 60000);
    assert.equal(a.totals.devices, 3);
    assert.deepEqual(a.segments.filter((s) => s.type === "logged_idle").map((s) => [s.startMin, s.endMin, s.reason, s.category]), [[600, 620, "Material Waiting", "DOWNTIME"]]);
    assert.equal(a.totals.loggedDowntimeMs, 20 * 60000);
    assert.equal(a.totals.presentMs, 180 * 60000, "09:00 to 12:00");
    assert.equal(new Date(a.milestones.login).getTime(), local(9).getTime());
    assert.equal(new Date(a.milestones.logout).getTime(), local(12).getTime());
    assert.equal(a.milestones.sessionEndedBySystem, false);
    assert.equal(a.reasons[0].reason, "Material Waiting");

    const b = r.body.operators.find((o) => o.id === String(opB));
    assert.equal(b.totals.presentMs, 10 * 60 * 60000, "a session closed days later counts for the ten-hour limit only");
    assert.equal(b.milestones.sessionEndedBySystem, true);
    assert.deepEqual(r.body.axis, { startMin: 480, endMin: 1200 }, "the 09:00-18:00 day with an hour either side, widened to 20:00 for operator B's capped session, which ends at 19:30");

    // filters and bad input
    const onlyB = await call(controller.operatorTimeline, { params: { id: opsPlanId }, query: { date: "2026-10-07", operator: String(opB) }, user: admin });
    assert.deepEqual(onlyB.body.operators.map((o) => o.id), [String(opB)]);
    const fn = await call(controller.operatorTimeline, { params: { id: opsPlanId }, query: { date: "2026-10-07", stage: "functional" }, user: admin });
    assert.deepEqual(fn.body.operators.map((o) => o.id), [String(opB)], "only operators who tested at that stage");
    const quiet = await call(controller.operatorTimeline, { params: { id: opsPlanId }, query: { date: "2026-10-08" }, user: admin });
    assert.deepEqual(quiet.body.operators, [], "a day with nothing recorded");
    assert.equal((await call(controller.operatorTimeline, { params: { id: opsPlanId }, query: {}, user: admin })).status, 400);
    assert.equal((await call(controller.operatorTimeline, { params: { id: opsPlanId }, query: { date: "2026-10-07", operator: "zz" }, user: admin })).status, 400);
    assert.equal((await call(controller.operatorTimeline, { params: { id: "x" }, query: { date: "2026-10-07" }, user: admin })).status, 400);
    assert.equal((await call(controller.operatorTimeline, { params: { id: String(oid()) }, query: { date: "2026-10-07" }, user: admin })).status, 404);
  });

  // ---- taking over an operator who is busy on another process --------------------------------------------------------------
  await step("a busy operator can be taken over: refused without asking, then moved off the other process when chosen on purpose", async () => {
    const { describeTakeover } = require("../services/planning/operatorTakeover");
    const ProcessLog = require("../models/ProcessLogs");
    const pa = await makeProcess(12);
    const pb = await makeProcess(13);
    const busy = await makeUser(12);
    const start = formatPlanDate(dayAt(140));
    const body = (proc, seats, extra = {}) =>
      baseBody(proc, { startDate: start, assignedJigs: {}, assignedCustomStagesOp: [], assignedStages: Object.fromEntries(Object.keys(seats).map((k) => [k, [entry("Visual Inspection", 50)]])), assignedOperators: seats, ...extra });
    const onA = await call(controller.create, { body: body(pa, { "0-0": [{ _id: String(busy._id) }] }), user: admin });
    assert.equal(onA.status, 200, JSON.stringify(onA.body));
    const planAId = String(onA.body.plan._id);
    assert.equal(await AssignOperator.countDocuments({ processId: pa._id, userId: busy._id }), 1);

    process.env.PLAN_VALIDATION_MODE = "enforce";
    process.env.PLAN_ENFORCED_CODES = "OPER-001";
    const seatsB = { "0-2": [{ _id: String(busy._id) }] };
    const refused = await call(controller.create, { body: body(pb, seatsB), user: admin });
    assert.equal(refused.status, 422, "without asking, an operator planned elsewhere on an overlapping shift is refused");
    assert.ok(refused.body.validation.issues.some((i) => i.code === "OPER-001" && i.severity === "error"));
    assert.equal(await Plan.countDocuments({ selectedProcess: pb._id }), 0);

    const preview = await describeTakeover({ processId: pb._id, operatorIds: [String(busy._id)] });
    assert.deepEqual(preview.map((p) => [p.operatorId, p.from.map((f) => f.processName)]), [[String(busy._id), [pa.name]]]);

    const moved = await call(controller.create, { body: body(pb, seatsB, { takeOverOperatorIds: [String(busy._id)] }), user: admin });
    assert.equal(moved.status, 200, JSON.stringify(moved.body).slice(0, 400));
    assert.ok(moved.body.validation.issues.some((i) => i.code === "OPER-001" && i.severity === "warning"), "the clash is only a warning when chosen on purpose");
    assert.deepEqual(moved.body.takeOver.map((m) => [m.operatorId, m.fromProcessName]), [[String(busy._id), pa.name]]);

    const planA = await Plan.collection.findOne({ _id: new mongoose.Types.ObjectId(planAId) });
    assert.deepEqual(JSON.parse(planA.assignedOperators)["0-0"], [], "removed from the other plan, the seat stays");
    assert.equal(JSON.parse(planA.assignedStages)["0-0"][0].name, "Visual Inspection", "its stage is untouched");
    assert.equal(await AssignOperator.countDocuments({ processId: pa._id, userId: busy._id }), 0, "the other process's assignment is gone");
    assert.equal(await AssignOperator.countDocuments({ processId: pb._id, userId: busy._id }), 1, "and they are assigned here");
    assert.ok(await ProcessLog.findOne({ processId: pa._id, action: "UNASSIGN" }), "the other process's log says they were moved");

    // asking about an operator who is not in the plan moves nobody
    const planBId = String(moved.body.plan._id);
    const other = await makeUser(13);
    const idle = await call(controller.update, { params: { id: planBId }, body: body(pb, seatsB, { takeOverOperatorIds: [String(other._id)] }), user: admin });
    assert.equal(idle.status, 200, JSON.stringify(idle.body).slice(0, 300));
    assert.equal(idle.body.takeOver, undefined);
    resetFlags();
  });

  // ---- the stage counters the device-test code keeps inside assignedCustomStagesOp ------------------------------------------
  await step("saving from the editor keeps the stage counters stored beside the common-stage operators, and does not grow the array", async () => {
    const id = new mongoose.Types.ObjectId(editPlanId);
    const stored = async () => JSON.parse((await Plan.collection.findOne({ _id: id })).assignedCustomStagesOp);
    const before = await stored();
    const counter = { name: "QC Check", totalUPHA: 5, passedDevice: 2, ngDevice: 1 };
    await Plan.collection.updateOne({ _id: id }, { $set: { assignedCustomStagesOp: JSON.stringify([...before, counter]) } });
    const sizes = [];
    for (let i = 0; i < 3; i += 1) {
      // what the editor sends back after loading: the counter comes back as an empty slot
      const loaded = await stored();
      const body = editBody({ assignedCustomStagesOp: loaded.map((slot) => (Array.isArray(slot) ? slot : [])) });
      const r = await call(controller.update, { params: { id: editPlanId }, body, user: admin });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      const now = await stored();
      sizes.push(now.length);
      assert.deepEqual(now.filter((s) => !Array.isArray(s)), [counter], `save ${i + 1}: the counter is intact`);
    }
    assert.equal(new Set(sizes).size, 1, `the array does not grow (${sizes.join(", ")})`);
    const slots = await stored();
    assert.equal(slots.slice(0, -1).every(Array.isArray), true, "the operator lists come first, one per common stage, then the counter");
  });

  await step("route guards: each /planing-v2 route admits exactly the roles it should (real middleware, real router)", async () => {
    const UserTypes = require("../models/userType");
    const router = require("../routes/api");
    const full = { read: true, create: true, update: true, delete: true };
    const make = async (roleName, permissions) => {
      await UserTypes.create({ name: roleName, permissions });
      return User.create({ name: roleName, employeeCode: `E2E-${roleName}`, gender: "Male", password: "x", userType: roleName, status: "Active" });
    };
    const planner = await make("E2E Planner", { process_management__view_planning_scheduling: full });
    const adder = await make("E2E Adder", { process_management__add_planning_scheduling: { create: true } });
    const reader = await make("E2E Reader", { process_management__view_planning_scheduling: { read: true } });
    const nobody = await make("E2E Nobody", { dashboard: full });
    const administrator = await User.create({ name: "E2E Root", employeeCode: "E2E-ROOT", gender: "Male", password: "x", userType: "Admin", status: "Active" });

    const gateOf = (method, routePath) => {
      const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
      assert.ok(layer, `route ${method.toUpperCase()} ${routePath} is registered`);
      return layer.route.stack[1].handle; // [authenticateToken, authorize(...), ...]
    };
    const allowed = async (method, routePath, user) => {
      const outcome = { ok: false, status: null };
      await gateOf(method, routePath)(
        { user: { id: String(user._id) }, requestId: "smoke" },
        { status(c) { outcome.status = c; return this; }, json() { return this; } },
        () => { outcome.ok = true; },
      );
      return outcome.ok;
    };

    const table = [
      // [method, path, planner, adder, reader, nobody, admin]
      ["get", "/planing-v2/lookups", true, true, true, false, true],
      ["get", "/planing-v2/plan/:id", true, false, true, false, true],
      ["post", "/planing-v2/availability", true, true, true, false, true],
      ["post", "/planing-v2/validate", true, true, false, false, true],
      ["post", "/planing-v2/schedule/preview", true, true, false, false, true],
      ["post", "/planing-v2/create", true, true, false, false, true],
      ["put", "/planing-v2/update/:id", true, false, false, false, true],
      ["post", "/planing-v2/plan/:id/review", true, false, false, false, true],
      ["get", "/planing-v2/plan/:id/overview", true, false, true, false, true],
      ["get", "/planing-v2/plan/:id/operations", true, false, true, false, true],
      ["get", "/planing-v2/plan/:id/hourly", true, false, true, false, true],
      ["get", "/planing-v2/plan/:id/timeline", true, false, true, false, true],
      ["get", "/planing-v2/plan/:id/kits", true, false, true, false, true],
      ["get", "/planing-v2/plan/:id/stage/:stage/summary", true, false, true, false, true],
      ["get", "/planing-v2/plan/:id/stage/:stage/devices", true, false, true, false, true],
      ["get", "/planing-v2/plan/:id/stage/:stage/history", true, false, true, false, true],
      ["get", "/planing-v2/schedule-board", true, false, true, false, true],
      ["delete", "/planing-v2/delete/:id", true, false, false, false, true],
    ];
    const people = [planner, adder, reader, nobody, administrator];
    const names = ["planner", "adder", "reader", "nobody", "admin"];
    for (const [method, routePath, ...expected] of table) {
      for (let i = 0; i < people.length; i += 1) {
        const got = await allowed(method, routePath, people[i]);
        assert.equal(got, expected[i], `${method.toUpperCase()} ${routePath}: ${names[i]} expected ${expected[i] ? "allowed" : "denied"}`);
      }
    }
  });

  await step("hard preconditions hold in any mode: missing refs and bad ids", async () => {
    const noProcess = await call(controller.create, { body: baseBody(p1, { selectedProcess: "nope" }), user: admin });
    assert.equal(noProcess.status, 400);
    const noDate = await call(controller.create, { body: baseBody(p1, { startDate: "garbage" }), user: admin });
    assert.equal(noDate.status, 400);
    const badId = await call(controller.update, { params: { id: "zzz" }, body: {}, user: admin });
    assert.equal(badId.status, 400);
    const missing = await call(controller.update, { params: { id: String(oid()) }, body: {}, user: admin });
    assert.equal(missing.status, 404);
  });

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
};

main()
  .catch((error) => {
    failures += 1;
    console.error("Smoke test crashed:", error);
  })
  .finally(async () => {
    try {
      if (mongoose.connection.readyState === 1 && mongoose.connection.name === scratchName && scratchName.startsWith(SCRATCH_PREFIX)) {
        await mongoose.connection.dropDatabase();
        console.log(`Dropped scratch database ${scratchName}`);
      }
    } catch (error) {
      console.error(`Could not drop ${scratchName}:`, error.message);
    }
    await mongoose.disconnect().catch(() => {});
    process.exit(failures ? 1 : 0);
  });
