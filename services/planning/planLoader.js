// Database access for the v2 planner. Everything the pure validator needs is loaded here with
// bounded, lean, field-selected queries. Nothing in this file writes.

const mongoose = require("mongoose");
const PlaningAndSchedulingModel = require("../../models/planingAndSchedulingModel");
const ProcessModel = require("../../models/process");
const ProductModel = require("../../models/Products");
const RoomPlanModel = require("../../models/roomPlan");
const ShiftModel = require("../../models/shiftManagement");
const HolidayModel = require("../../models/holidayModel");
const UserModel = require("../../models/User");
const JigModel = require("../../models/jig");
const AssignOperatorModel = require("../../models/assignOperatorToPlan");
const AssignJigModel = require("../../models/assignJigToPlan");

const { buildHolidayKeys, parsePlanDate, dayKeyLocal, dayNumber } = require("../../utils/planDates");
const { computePlan, collectSeatReservations } = require("./planValidator");
const { summarizePlan } = require("./planSummary");
const { normalizeDraft, collectOperatorIds, collectJigIds, isObjectId } = require("./draft");

const PLAN_LIMIT = Number(process.env.PLAN_VALIDATION_PLAN_LIMIT) || 1500;
const OVERRUN_LIMIT = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

// Process statuses whose plans do not hold seats (matches the legacy availability check).
const NON_BLOCKING_PROCESS_STATUS = new Set(["completed", "waiting_schedule"]);
const LIVE_PROCESS_STATUS = new Set(["active", "down_time_hold"]);

const PLAN_FIELDS =
  "selectedProcess selectedRoom selectedShift processName isDrafted startDate estimatedEndDate totalTimeEstimation " +
  "ProcessShiftMappings assignedStages assignedOperators assignedJigs assignedCustomStagesOp overtimeWindows scheduleMode daySchedule";

// Minimal, jig-aware view of a process (the full document carries SOPs, printer fields etc.).
const toProcessView = (doc) => {
  if (!doc) return null;
  return {
    _id: String(doc._id),
    name: doc.name || "",
    processID: doc.processID || "",
    status: doc.status || "",
    quantity: doc.quantity,
    selectedProduct: doc.selectedProduct ? String(doc.selectedProduct) : "",
    stages: (doc.stages || []).map((s) => ({
      stageName: s.stageName,
      upha: s.upha,
      requiredSkill: s.requiredSkill,
      managedBy: s.managedBy,
      hasJigStepType: Array.isArray(s.subSteps) && s.subSteps.some((step) => step?.stepType === "jig"),
    })),
    commonStages: doc.commonStages || [],
  };
};

const PROCESS_SELECT =
  "name processID status quantity selectedProduct stages.stageName stages.upha stages.requiredSkill stages.managedBy " +
  "stages.subSteps.stepType commonStages";

const loadProcessView = async (id) => (isObjectId(id) ? toProcessView(await ProcessModel.findById(id).select(PROCESS_SELECT).lean()) : null);

// Everything that does not depend on the computed date range.
const loadCore = async (draft) => {
  const [processView, room, shift, holidays, existingPlan, samePlanDoc] = await Promise.all([
    loadProcessView(draft.selectedProcess),
    isObjectId(draft.selectedRoom) ? RoomPlanModel.findById(draft.selectedRoom).lean() : null,
    isObjectId(draft.selectedShift) ? ShiftModel.findById(draft.selectedShift).lean() : null,
    HolidayModel.find({}, { holidayDate: 1 }).limit(2000).lean(),
    isObjectId(draft.planId) ? PlaningAndSchedulingModel.findById(draft.planId).select("isDrafted selectedProcess scheduleMode overtimeWindows downTime").lean() : null,
    isObjectId(draft.selectedProcess)
      ? PlaningAndSchedulingModel.findOne({
          selectedProcess: draft.selectedProcess,
          isDrafted: 0,
          ...(isObjectId(draft.planId) ? { _id: { $ne: draft.planId } } : {}),
        })
          .select(PLAN_FIELDS)
          .lean()
      : null,
  ]);

  return {
    process: processView,
    room,
    shift,
    holidayKeys: buildHolidayKeys(holidays),
    existingPlan,
    samePlanForProcess: samePlanDoc ? summarizePlan(samePlanDoc, { processName: processView?.name }) : null,
  };
};

// Rows that claim an operator/jig is busy on another process but that no plan accounts for.
const findStaleRows = async ({ Model, idField, ids, excludeProcessId, memberKey }) => {
  const result = new Map();
  if (!ids.length) return result;
  const rows = await Model.find({
    [idField]: { $in: ids },
    status: "Occupied",
    ...(isObjectId(excludeProcessId) ? { processId: { $ne: excludeProcessId } } : {}),
  })
    .select(`${idField} processId`)
    .limit(2000)
    .lean();
  if (!rows.length) return result;

  const processIds = [...new Set(rows.map((r) => String(r.processId)))];
  const [processes, plans] = await Promise.all([
    ProcessModel.find({ _id: { $in: processIds } }).select("name status").lean(),
    PlaningAndSchedulingModel.find({ selectedProcess: { $in: processIds }, isDrafted: 0 }).select(PLAN_FIELDS).lean(),
  ]);
  const processById = new Map(processes.map((p) => [String(p._id), p]));
  const memberByProcess = new Map();
  plans.forEach((plan) => {
    const summary = summarizePlan(plan);
    const set = memberByProcess.get(String(plan.selectedProcess)) || new Set();
    summary[memberKey].forEach((id) => set.add(id));
    memberByProcess.set(String(plan.selectedProcess), set);
  });

  rows.forEach((row) => {
    const proc = processById.get(String(row.processId));
    if (!proc || proc.status === "completed") return; // finished or deleted process: not a live claim
    const accounted = memberByProcess.get(String(row.processId));
    if (accounted && accounted.has(String(row[idField]))) return; // a real plan includes it
    const key = String(row[idField]);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push({ processId: String(row.processId), processName: proc.name || "" });
  });
  return result;
};

// Everything that depends on the draft's computed date range and seats.
const loadConflicts = async (draft, core, computed) => {
  const startBoundary = new Date((computed.startDay || 0) * DAY_MS - DAY_MS * 2);
  const endBoundary = new Date((computed.endDay || 0) * DAY_MS + DAY_MS * 3);
  const excludeId = isObjectId(draft.planId) ? { _id: { $ne: draft.planId } } : {};
  const haveRange = Number.isFinite(computed.startDay) && Number.isFinite(computed.endDay);

  const [overlapDocs, overrunDocs] = await Promise.all([
    haveRange
      ? PlaningAndSchedulingModel.find({
          isDrafted: 0,
          ...excludeId,
          startDate: { $lte: endBoundary },
          $or: [{ estimatedEndDate: { $gte: startBoundary } }, { estimatedEndDate: null }, { estimatedEndDate: { $exists: false } }],
        })
          .select(PLAN_FIELDS)
          .limit(PLAN_LIMIT + 1)
          .lean()
      : [],
    haveRange && isObjectId(draft.selectedRoom)
      ? PlaningAndSchedulingModel.find({
          isDrafted: 0,
          ...excludeId,
          selectedRoom: draft.selectedRoom,
          estimatedEndDate: { $lt: startBoundary },
        })
          .select(PLAN_FIELDS)
          .sort({ estimatedEndDate: -1 })
          .limit(OVERRUN_LIMIT)
          .lean()
      : [],
  ]);

  const truncated = overlapDocs.length > PLAN_LIMIT;
  const overlapSlice = overlapDocs.slice(0, PLAN_LIMIT);

  const processIds = [...new Set([...overlapSlice, ...overrunDocs].map((p) => String(p.selectedProcess)).filter(isObjectId))];
  const processes = processIds.length ? await ProcessModel.find({ _id: { $in: processIds } }).select("name status").lean() : [];
  const processById = new Map(processes.map((p) => [String(p._id), p]));

  const toSummary = (doc) => {
    const proc = processById.get(String(doc.selectedProcess));
    return summarizePlan(doc, { processStatus: proc?.status || "", processName: doc.processName || proc?.name || "" });
  };

  const otherPlans = overlapSlice.map(toSummary).filter((p) => !NON_BLOCKING_PROCESS_STATUS.has(p.processStatus));
  const overrunPlans = overrunDocs.map(toSummary).filter((p) => LIVE_PROCESS_STATUS.has(p.processStatus));

  const operatorIds = collectOperatorIds(draft);
  const jigIds = collectJigIds(draft);
  const [users, jigs, operatorRows, jigRows] = await Promise.all([
    operatorIds.length ? UserModel.find({ _id: { $in: operatorIds } }).select("name userType skills status employeeCode email profilePic").lean() : [],
    jigIds.length ? JigModel.find({ _id: { $in: jigIds } }).select("name jigCategory").lean() : [],
    findStaleRows({ Model: AssignOperatorModel, idField: "userId", ids: operatorIds, excludeProcessId: draft.selectedProcess, memberKey: "operatorIds" }),
    findStaleRows({ Model: AssignJigModel, idField: "jigId", ids: jigIds, excludeProcessId: draft.selectedProcess, memberKey: "jigIds" }),
  ]);

  return {
    otherPlans,
    overrunPlans,
    truncated,
    users: new Map(users.map((u) => [String(u._id), { ...u, _id: String(u._id) }])),
    jigs: new Map(jigs.map((j) => [String(j._id), { ...j, _id: String(j._id) }])),
    operatorRows,
    jigRows,
  };
};

// Full context for a draft: core lookups, then the conflict search over its computed range.
const buildContext = async (draft, { rangeOverride = null } = {}) => {
  const core = await loadCore(draft);
  const provisional = computePlan(draft, core, rangeOverride);
  const conflicts = await loadConflicts(draft, core, provisional);
  return { ...core, ...conflicts };
};

// Seats held by other plans for a room/shift/date range. Used by the builder to grey out seats.
const loadSeatReservations = async ({ selectedRoom, selectedShift, startDate, estimatedEndDate, planId, scheduleMode, daySchedule }) => {
  const draft = normalizeDraft({ selectedRoom, selectedShift, startDate, isDrafted: 1, scheduleMode, daySchedule }, { planId });
  const core = await loadCore(draft);
  const computed = computePlan(draft, core);
  // The caller supplies the end date it last computed; fall back to the start day.
  // (a custom schedule already knows its own days, so its range is left alone)
  if (!computed.custom) {
    const end = parsePlanDate(estimatedEndDate) || draft.startDate;
    computed.endKey = dayKeyLocal(end);
    computed.endDay = dayNumber(computed.endKey);
  }
  const conflicts = await loadConflicts(draft, core, computed);
  const reservations = collectSeatReservations(draft.selectedRoom, computed, { ...core, ...conflicts });
  const seats = {};
  reservations.forEach(({ seatKey, plan, kind, stageName }) => {
    if (seats[seatKey]) return;
    seats[seatKey] = { kind, stageName, planId: plan.id, processName: plan.processName, startDate: plan.startKey, endDate: plan.endKey };
  });
  return { seats, truncated: conflicts.truncated };
};

// Packaging carton capacity of a process's product, for the stored `issuedCarton` figure.
const loadMaxCartonCapacity = async (processView) => {
  if (!processView?.selectedProduct || !isObjectId(processView.selectedProduct)) return 0;
  const product = await ProductModel.findById(processView.selectedProduct).select("stages.subSteps.isPackagingStatus stages.subSteps.packagingData").lean();
  for (const stage of product?.stages || []) {
    for (const step of stage?.subSteps || []) {
      if (step?.isPackagingStatus && Number(step?.packagingData?.maxCapacity) > 0) return Number(step.packagingData.maxCapacity);
    }
  }
  return 0;
};

module.exports = {
  loadCore,
  loadConflicts,
  buildContext,
  loadSeatReservations,
  loadProcessView,
  loadMaxCartonCapacity,
  toProcessView,
  PROCESS_SELECT,
  PLAN_FIELDS,
  mongoose,
};
