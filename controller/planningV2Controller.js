// Planning & Scheduling v2 (/planing-v2/*).
//
// Writes the SAME PlaningAndScheduling documents as the legacy flow, in the same shapes, so the
// legacy pages (view / edit / dashboard), the operator task screens and the insights endpoints
// keep working on plans created here. Nothing in the legacy controller or routes is changed.
//
// What differs from the legacy create/update:
//   - only whitelisted fields are accepted (no status / downTime / overtime / createdBy spoofing),
//   - the server computes capacity, UPHA, estimated end date and shift mapping (client values are
//     never trusted),
//   - operator and jig objects are rebuilt from the database, not copied from the request,
//   - drafts can be saved, do not touch the process and do not create assignment rows,
//   - the process moves waiting_schedule -> Waiting_Kits_allocation atomically on publish,
//   - the validator runs (warn by default) and every save is recorded as a validation event,
//   - delete frees the plan's operators/jigs and returns the process to waiting_schedule when safe.

const mongoose = require("mongoose");
const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
const ProcessModel = require("../models/process");
const ProcessLogModel = require("../models/ProcessLogs");
const RoomPlanModel = require("../models/roomPlan");
const ShiftModel = require("../models/shiftManagement");
const HolidayModel = require("../models/holidayModel");
const JigModel = require("../models/jig");
const JigCategoryModel = require("../models/jigCategory");
const AssignOperatorModel = require("../models/assignOperatorToPlan");
const AssignJigModel = require("../models/assignJigToPlan");
const PlanValidationEvent = require("../models/planValidationEvent");

const { getValidationMode, getEnforcedCodes, getDeleteGuardMode, VALIDATOR_VERSION, getCustomScheduleEnabled, getMaxDayHours, getEditGuardMode } = require("../config/planningFlags");
const { runEditGuard, mergeGuardIntoResult, guardBlocking, seatLabelFor, resolveExistingShift } = require("../services/planning/editSupport");
const { planRevision } = require("../services/planning/planRevision");
const { storedView, scheduleOf } = require("../services/planning/planViews");
const { diffPlans } = require("../services/planning/planDiff");
const { loadFootprint, summarizeFootprint } = require("../services/planning/planFootprint");
const { formatPlanDate, dayKeyLocal, buildHolidayKeys, dayNumber } = require("../utils/planDates");
const UserModel = require("../models/User");
const { loadActuals } = require("../services/planning/planActuals");
const { buildOverview, buildBoardPlan, lastStageName } = require("../services/planning/planOverview");
const { loadOperations } = require("../services/planning/planOperations");
const { loadStageSummary, loadStageDevices, loadStageHistory } = require("../services/planning/planStageDetail");
const { loadHourly } = require("../services/planning/planHourly");
const { describeTakeover, takeOverOperators } = require("../services/planning/operatorTakeover");
const { mergeCommonSlots } = require("../services/planning/commonSlots");
const { loadKitsAndNg } = require("../services/planning/planKits");
const { loadOperatorTimeline } = require("../services/planning/planOperatorTimeline");
const { devicesCsv, historyCsv } = require("../services/planning/stageExport");
const { safeFileName } = require("../services/planning/csv");
const { buildDaySchedule, validateDaySchedule, templateFromShift } = require("../services/planning/daySchedule");
const { suggestExtension, dateOfKey } = require("../services/planning/customPlan");
const { pickPlanFields, normalizeDraft, safeParse, toList, idOf, seatKeyParts, isObjectId, stageEntriesOf, collectOperatorIds } = require("../services/planning/draft");
const { validatePlan } = require("../services/planning/planValidator");
const { normName } = require("../services/planning/capacity");
const loader = require("../services/planning/planLoader");
const { syncPlanAssignments, operatorIdsOfPlan, jigIdsOfPlan } = require("../services/planning/assignmentSync");
const { normalizeAssignedStagesPayload } = require("../services/planInsightsService");

// Process states after which deleting a plan would disrupt kit allocation or production.
const DELETE_BLOCKING_PROCESS_STATUS = new Set([
  "Waiting_Kits_approval",
  "waiting_for_line_feeding",
  "waiting_for_kits_confirmation",
  "active",
  "down_time_hold",
  "completed",
]);

// In a draft only these hard-structure errors may block a save, even when enforcing.
const DRAFT_BLOCKING_CODES = new Set(["STRUCT-002", "STRUCT-003"]);

const fail = (res, status, message, extra = {}) => res.status(status).json({ status, message, ...extra });

// a download: the byte-order mark makes Excel read the file as UTF-8
const sendCsv = (res, fileName, text) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send("\uFEFF" + text);
};

const isFullAccessUser = (user) => {
  const type = String(user?.userType || "").toLowerCase().replace(/[\s-]+/g, "_");
  return type === "admin" || type === "administrator";
};

const publicResult = (result) => {
  const { _computed, ...rest } = result;
  return rest;
};

const writeLog = async (action, processId, userId, description) => {
  try {
    if (!isObjectId(processId) || !isObjectId(userId)) return;
    await ProcessLogModel.create({ action, processId, userId, description: description || "" });
  } catch (error) {
    console.error(`[planning-v2] could not write ${action} log:`, error.message);
  }
};

// Move the operators the planner chose from other processes onto this plan: they are removed from the other plans and rows.
// Only operators actually in the saved plan are considered; a failure is reported, never thrown (the plan is already saved).
const moveChosenOperators = async ({ draft, plan, req }) => {
  try {
    const inPlan = new Set(operatorIdsOfPlan(plan).map(String));
    const ids = (draft.takeOverOperatorIds || []).filter((id) => inPlan.has(String(id)));
    if (!ids.length) return { moved: [] };
    return await takeOverOperators({ processId: plan.selectedProcess, operatorIds: ids, writeLog, userId: req.user?.id, userName: req.user?.name || "user", toProcessName: plan.processName });
  } catch (error) {
    console.error("[planning-v2] could not move operators from other processes:", error);
    return { moved: [], error: error.message };
  }
};

const recordEvent = async ({ req, action, mode, draft, result, gate }) => {
  if (mode === "off") return;
  try {
    await PlanValidationEvent.create({
      planId: isObjectId(draft.planId) ? draft.planId : null,
      processId: isObjectId(draft.selectedProcess) ? draft.selectedProcess : null,
      userId: isObjectId(req.user?.id) ? req.user.id : null,
      action,
      mode,
      validatorVersion: VALIDATOR_VERSION,
      summary: result.summary,
      issues: result.issues.slice(0, 100).map((i) => ({
        code: i.code,
        severity: i.severity,
        seatKey: i.seatKey || "",
        resourceType: i.resource?.type || "",
      })),
      wouldHaveBlocked: gate.wouldHaveBlocked,
      blocked: gate.blocked,
      overrideReason: gate.overrideUsed ? draft.overrideReason : "",
    });
  } catch (error) {
    console.error("[planning-v2] could not record validation event:", error.message);
  }
};

// Decides whether the validator result may block this save.
const gateSave = ({ result, draft, req }) => {
  const mode = getValidationMode();
  const enforced = getEnforcedCodes();
  const eligible = (issue) =>
    issue.severity === "error" && (draft.mode === "publish" || DRAFT_BLOCKING_CODES.has(issue.code));
  const wouldHaveBlocked = result.issues.some((i) => eligible(i) && (enforced.size === 0 || enforced.has(i.code)));
  const blocking = mode === "enforce" ? result.issues.filter((i) => eligible(i) && enforced.has(i.code)) : [];
  const overrideOk = blocking.length > 0 && draft.overrideReason.length >= 10 && isFullAccessUser(req.user);
  return {
    mode,
    blocking,
    blocked: blocking.length > 0 && !overrideOk,
    overrideUsed: blocking.length > 0 && overrideOk,
    wouldHaveBlocked,
  };
};

// Things that must hold regardless of validation mode: without them nothing can be computed.
const requireRefs = (draft, ctx) => {
  if (!isObjectId(draft.selectedProcess) || !ctx.process) return "The selected process was not found.";
  if (!isObjectId(draft.selectedRoom) || !ctx.room) return "The selected floor/room was not found.";
  if (draft.scheduleMode === "custom") {
    // the shift is only an optional template here; what is required is the day schedule itself
    if (!getCustomScheduleEnabled()) return "Custom day-wise schedules are not enabled.";
    if (!draft.startDate) return "A valid plan start date is required.";
    if (!draft.daySchedule || draft.daySchedule.length === 0) return "A custom schedule needs at least one day.";
    return null;
  }
  if (!isObjectId(draft.selectedShift) || !ctx.shift) return "The selected shift was not found.";
  if (!draft.startDate) return "A valid plan start date is required.";
  return null;
};

// Creating or checking a custom schedule is refused while the feature flag is off.
const customScheduleOff = (draft) => draft.scheduleMode === "custom" && !getCustomScheduleEnabled();

// ---- building the stored document -----------------------------------------------------------

const sortSeatKeys = (keys) =>
  [...keys].sort((a, b) => {
    const pa = seatKeyParts(a);
    const pb = seatKeyParts(b);
    return pa.row !== pb.row ? pa.row - pb.row : pa.seat - pb.seat;
  });

// Existing per-seat stage entries by "seatKey|stage", so production counters survive an edit.
const indexExistingStages = (existingPlan) => {
  const index = new Map();
  const stages = safeParse(existingPlan?.assignedStages, {}) || {};
  Object.entries(stages).forEach(([seatKey, entries]) => {
    toList(entries).forEach((entry) => {
      if (entry && !entry.reserved) index.set(`${seatKey}|${normName(entry.stageName || entry.name)}`, entry);
    });
  });
  return index;
};

const buildStages = (draft, ctx, unitsPerDay, existingPlan) => {
  const defs = new Map((ctx.process.stages || []).map((s) => [normName(s.stageName), s]));
  const previous = indexExistingStages(existingPlan);
  const out = {};
  let firstEntry = true;

  sortSeatKeys(Object.keys(draft.assignedStages || {})).forEach((seatKey) => {
    const entries = stageEntriesOf(draft.assignedStages, seatKey).map((entry) => {
      const rawName = String(entry.stageName || entry.name || entry.stage || "");
      const def = defs.get(normName(rawName));
      const name = def?.stageName || rawName;
      const prev = previous.get(`${seatKey}|${normName(name)}`) || {};
      const built = {
        ...prev,
        name,
        requiredSkill: def ? def.requiredSkill || "" : entry.requiredSkill || "",
        managedBy: def ? def.managedBy || "" : entry.managedBy || "",
        upha: def ? String(def.upha ?? "") : String(entry.upha ?? ""),
        totalUPHA: 0,
        passedDevice: Number(prev.passedDevice ?? entry.passedDevice) || 0,
        ngDevice: Number(prev.ngDevice ?? entry.ngDevice) || 0,
        hasJigStepType: def ? !!def.hasJigStepType : !!entry.hasJigStepType,
      };
      if (firstEntry) {
        built.totalUPHA = Math.floor(unitsPerDay) || 0; // legacy stores parseInt(totalUPHA) on the first entry only
        firstEntry = false;
      }
      return built;
    });
    if (entries.length) out[seatKey] = entries;
  });
  return normalizeAssignedStagesPayload(out, ctx.process.stages, []);
};

const operatorEntry = (id, ctx, fallback) => {
  const user = ctx.users.get(String(id));
  if (!user) return { _id: String(id), name: fallback?.name || "" };
  return {
    _id: user._id,
    name: user.name,
    employeeCode: user.employeeCode,
    email: user.email,
    userType: user.userType,
    skills: user.skills || [],
    profilePic: user.profilePic || "",
    status: user.status,
  };
};

const jigEntry = (id, ctx, fallback) => {
  const jig = ctx.jigs.get(String(id));
  return jig ? { _id: jig._id, name: jig.name, jigCategory: jig.jigCategory } : { _id: String(id), name: fallback?.name || "" };
};

const buildAssignments = (draft, ctx, seatKeys, existing = null) => {
  const keep = new Set(seatKeys);
  const operators = {};
  Object.entries(draft.assignedOperators || {}).forEach(([seatKey, slot]) => {
    if (!keep.has(seatKey)) return;
    const list = toList(slot).filter((op) => idOf(op)).map((op) => operatorEntry(idOf(op), ctx, op));
    if (list.length) operators[seatKey] = list;
  });
  const jigs = {};
  Object.entries(draft.assignedJigs || {}).forEach(([seatKey, slot]) => {
    if (!keep.has(seatKey)) return;
    const list = toList(slot).filter((j) => idOf(j)).map((j) => jigEntry(idOf(j), ctx, j));
    if (list.length) jigs[seatKey] = list;
  });
  const commonCount = (ctx.process.commonStages || []).length;
  const slots = Math.max(commonCount, (draft.assignedCustomStagesOp || []).length);
  const lists = Array.from({ length: slots }, (_, i) =>
    toList(draft.assignedCustomStagesOp?.[i]).filter((op) => idOf(op)).map((op) => operatorEntry(idOf(op), ctx, op)),
  );
  // The same array also holds the stage counters the device-test code keeps by name: carry them over, do not wipe them (commonSlots.js)
  const custom = mergeCommonSlots({ lists, commonCount, existingRaw: existing?.assignedCustomStagesOp });
  return { operators, jigs, custom };
};

const buildPlanFields = async ({ draft, ctx, result, existing, req }) => {
  const computed = result._computed;
  const stages = buildStages(draft, ctx, computed.unitsPerDay, existing);
  const { operators, jigs, custom } = buildAssignments(draft, ctx, Object.keys(stages), existing);
  const isCustom = draft.scheduleMode === "custom";
  const shift = ctx.shift;
  // Shift plan: the shift's (or the override's) hours. Custom plan: the first working day's hours, as a
  // summary for the older screens that can only show one window.
  const firstDay = isCustom ? computed.days[0] : null;
  const startTime = isCustom ? firstDay?.window.startTime || "" : draft.shiftOverride?.startTime || shift.startTime || "";
  const endTime = isCustom ? firstDay?.window.endTime || "" : draft.shiftOverride?.endTime || shift.endTime || "";
  const summaryDate = isCustom && firstDay ? dateOfKey(firstDay.dayKey) : draft.startDate; // local midnight, like every plan date

  const fields = {
    processName: draft.processName || ctx.process.name,
    selectedProcess: draft.selectedProcess,
    selectedRoom: draft.selectedRoom,
    // custom plans: the shift is only an optional template, so it may be empty (null clears a previous one)
    selectedShift: isCustom ? (isObjectId(draft.selectedShift) ? draft.selectedShift : null) : draft.selectedShift,
    ProcessShiftMappings: { formattedShiftDate: formatPlanDate(summaryDate), startTime, endTime },
    repeatCount: draft.repeatCount,
    startDate: draft.startDate,
    estimatedEndDate: computed.endDate || undefined,
    plannedEndDate: draft.plannedEndDate || null,
    totalUPHA: computed.totalUPHA,
    totalTimeEstimation: computed.totalTimeEstimation,
    assignedStages: JSON.stringify(stages),
    assignedOperators: JSON.stringify(operators),
    assignedJigs: JSON.stringify(jigs),
    assignedCustomStages: JSON.stringify(ctx.process.commonStages || []),
    assignedCustomStagesOp: JSON.stringify(custom),
    isDrafted: draft.isDrafted ? 1 : 0,
  };

  // Shift plans are stored exactly as before (no new fields). A custom plan stores its schedule; a plan that
  // is switched back from custom to shift clears it.
  if (isCustom) {
    fields.scheduleMode = "custom";
    fields.daySchedule = draft.daySchedule;
    fields.scheduleDefaults = draft.scheduleDefaults;
  } else if (existing?.scheduleMode === "custom") {
    fields.scheduleMode = "shift";
    fields.daySchedule = [];
    fields.scheduleDefaults = null;
  }

  // Kit/carton figures are captured when the plan is first created (or a draft is first saved).
  if (!existing || !existing.issuedKits) {
    const quantity = Number(ctx.process.quantity);
    fields.issuedKits = Number.isFinite(quantity) ? String(quantity) : "";
    const maxCapacity = await loader.loadMaxCartonCapacity(ctx.process);
    fields.issuedCarton = maxCapacity > 0 && Number.isFinite(quantity) ? String(quantity / maxCapacity) : "";
  }
  if (!existing) {
    fields.consumedKit = 0;
    fields.createdBy = req.user?.id;
    fields.department = req.user?.department || "";
  }
  Object.keys(fields).forEach((key) => fields[key] === undefined && delete fields[key]);
  return { fields, stages, operators, jigs, custom };
};

const logAssignments = async ({ plan, process, stages, operators, jigs, req, verb }) => {
  const actor = req.user?.name || "user";
  const action = verb === "created" ? "PLANING_CREATED" : "PLANING_UPDATED";
  for (const [seatKey, list] of Object.entries(operators)) {
    const stage = stages[seatKey]?.[0]?.name || "";
    await writeLog(action, process._id, req.user?.id, `${list[0]?.name} Operator ${verb === "created" ? "assigned" : "kept"} on ${plan.processName} at Stage ${stage}, Seat ${seatKey} by ${actor}.`);
  }
  for (const [seatKey, list] of Object.entries(jigs)) {
    const stage = stages[seatKey]?.[0]?.name || "";
    await writeLog("ASSIGN_JIG", process._id, req.user?.id, `${list[0]?.name} jig assigned to ${plan.processName} at Stage ${stage}, Seat ${seatKey} by ${actor}.`);
  }
};

// ---- handlers -------------------------------------------------------------------------------

module.exports = {
  // GET /planing-v2/lookups?processId=  -> everything the builder needs in one call
  lookups: async (req, res) => {
    try {
      const currentProcessId = String(req.query?.processId || "");
      const [rooms, shifts, holidays, jigCategories, jigs, processDocs] = await Promise.all([
        RoomPlanModel.find().sort({ floorName: 1 }).limit(500).lean(),
        ShiftModel.find().select("name startTime endTime totalBreakTime intervals weekDays").limit(500).lean(),
        HolidayModel.find({}, { holidayDate: 1, holidayName: 1 }).limit(2000).lean(),
        JigCategoryModel.find().select("name status").limit(500).lean(),
        JigModel.find().select("name jigCategory").limit(5000).lean(),
        ProcessModel.find({
          $or: [{ status: "waiting_schedule" }, ...(isObjectId(currentProcessId) ? [{ _id: currentProcessId }] : [])],
        })
          .select(loader.PROCESS_SELECT)
          .sort({ updatedAt: -1 })
          .limit(1000)
          .lean(),
      ]);
      return res.status(200).json({
        status: 200,
        rooms,
        shifts,
        holidays,
        jigCategories,
        jigs,
        processes: processDocs.map(loader.toProcessView),
        features: { customSchedule: getCustomScheduleEnabled() },
      });
    } catch (error) {
      console.error("[planning-v2] lookups failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // GET /planing-v2/plan/:id -> stored plan with its JSON blobs parsed, for the builder's edit mode
  getPlan: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isObjectId(id)) return fail(res, 400, "Invalid plan id");
      const plan = await PlaningAndSchedulingModel.findById(id).lean();
      if (!plan) return fail(res, 404, "Plan not found");
      const process = await loader.loadProcessView(plan.selectedProcess);
      // What the edit page needs to protect work already done: a fingerprint of the plan as opened, and what has happened on it
      const published = Number(plan.isDrafted) !== 1;
      const footprint = published && getEditGuardMode() !== "off" ? summarizeFootprint(await loadFootprint(plan)) : null;
      return res.status(200).json({
        status: 200,
        revision: planRevision(plan),
        footprint,
        editGuardMode: getEditGuardMode(),
        plan: {
          ...plan,
          assignedStages: safeParse(plan.assignedStages, {}),
          assignedOperators: safeParse(plan.assignedOperators, {}),
          assignedJigs: safeParse(plan.assignedJigs, {}),
          assignedCustomStagesOp: safeParse(plan.assignedCustomStagesOp, []),
        },
        process,
      });
    } catch (error) {
      console.error("[planning-v2] getPlan failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // POST /planing-v2/availability -> seats other plans hold for this room/shift/date range
  availability: async (req, res) => {
    try {
      const { selectedRoom, selectedShift, startDate, estimatedEndDate, planId, scheduleMode, daySchedule } = req.body || {};
      const custom = scheduleMode === "custom";
      if (custom && !getCustomScheduleEnabled()) return fail(res, 400, "Custom day-wise schedules are not enabled.");
      if (!isObjectId(selectedRoom) || (!custom && !isObjectId(selectedShift))) return fail(res, 400, custom ? "selectedRoom is required" : "selectedRoom and selectedShift are required");
      const out = await loader.loadSeatReservations({ selectedRoom, selectedShift, startDate, estimatedEndDate, planId, scheduleMode, daySchedule });
      return res.status(200).json({ status: 200, ...out });
    } catch (error) {
      console.error("[planning-v2] availability failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // GET /planing-v2/plan/:id/overview -> one plan, read only: the schedule day by day, planned against actual output
  overview: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isObjectId(id)) return fail(res, 400, "Invalid plan id");
      const plan = await PlaningAndSchedulingModel.findById(id).lean();
      if (!plan) return fail(res, 404, "Plan not found");

      const [process, room, shift, holidays] = await Promise.all([
        loader.loadProcessView(plan.selectedProcess),
        isObjectId(plan.selectedRoom) ? RoomPlanModel.findById(plan.selectedRoom).lean() : null,
        isObjectId(plan.selectedShift) ? ShiftModel.findById(plan.selectedShift).lean() : null,
        HolidayModel.find({}, { holidayDate: 1 }).limit(2000).lean(),
      ]);
      const published = Number(plan.isDrafted) !== 1;
      const [actualsByPlan, footprint, logs] = await Promise.all([
        published ? loadActuals({ planIds: [id], lastStageByPlan: new Map([[id, lastStageName(process)]]) }) : new Map(),
        published ? loadFootprint(plan) : null,
        ProcessLogModel.find({ processId: plan.selectedProcess, action: { $in: ["CREATE", "PLANING_UPDATED", "SHIFT_CHANGE", "HOLD", "OVERTIME_ADDED", "OVERTIME_UPDATED", "OVERTIME_REMOVED", "PROCESS_EXTENDED", "PROCESS_COMPLETED"] } })
          .sort({ timestamp: -1 })
          .limit(15)
          .lean(),
      ]);
      const userIds = [...new Set(logs.map((l) => String(l.userId)).filter(isObjectId))];
      const users = userIds.length ? await UserModel.find({ _id: { $in: userIds } }).select("name").lean() : [];
      const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
      const history = logs.map((l) => ({ action: l.action, description: l.description || "", at: l.timestamp, by: nameOf.get(String(l.userId)) || "" }));

      const overview = buildOverview({
        plan,
        process,
        room,
        shift,
        holidayKeys: buildHolidayKeys(holidays),
        actuals: actualsByPlan.get(id),
        todayKey: dayKeyLocal(new Date()),
        footprint: footprint ? summarizeFootprint(footprint) : null,
        history,
      });
      return res.status(200).json({ status: 200, ...overview });
    } catch (error) {
      console.error("[planning-v2] overview failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // GET /planing-v2/plan/:id/operations?from&to -> WIP, pass, NG, kits and stage figures (the same numbers as the monitoring page)
  operations: async (req, res) => {
    try {
      const result = await loadOperations({ planId: req.params.id, from: String(req.query?.from || ""), to: String(req.query?.to || "") });
      if (!result.ok) return fail(res, result.status, result.message);
      return res.status(200).json(result.body);
    } catch (error) {
      console.error("[planning-v2] operations failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // GET /planing-v2/plan/:id/stage/:stage/summary|devices|history -> one stage, read only (see services/planning/stageDetail.js)
  stageSummary: async (req, res) => {
    try {
      const r = await loadStageSummary({ planId: req.params.id, stage: req.params.stage, from: String(req.query?.from || ""), to: String(req.query?.to || "") });
      return r.ok ? res.status(200).json(r.body) : fail(res, r.status, r.message);
    } catch (error) {
      console.error("[planning-v2] stage summary failed:", error);
      return fail(res, 500, error.message);
    }
  },
  stageDevices: async (req, res) => {
    try {
      const csv = String(req.query?.format || "") === "csv";
      const bucket = String(req.query?.bucket || "") || "pass";
      const r = await loadStageDevices({ planId: req.params.id, stage: req.params.stage, bucket, page: req.query?.page, pageSize: req.query?.pageSize, q: String(req.query?.q || ""), seat: String(req.query?.seat || ""), from: String(req.query?.from || ""), to: String(req.query?.to || ""), all: csv });
      if (!r.ok) return fail(res, r.status, r.message);
      if (!csv) return res.status(200).json(r.body);
      return sendCsv(res, safeFileName([r.body.plan?.name, r.body.stage.name, bucket, String(req.query?.from || ""), String(req.query?.to || "")]), devicesCsv(bucket, r.body.rows));
    } catch (error) {
      console.error("[planning-v2] stage devices failed:", error);
      return fail(res, 500, error.message);
    }
  },
  stageHistory: async (req, res) => {
    try {
      const csv = String(req.query?.format || "") === "csv";
      const r = await loadStageHistory({ planId: req.params.id, stage: req.params.stage, from: String(req.query?.from || ""), to: String(req.query?.to || ""), operator: String(req.query?.operator || ""), status: String(req.query?.status || ""), serial: String(req.query?.serial || ""), seat: String(req.query?.seat || ""), cursor: String(req.query?.cursor || ""), limit: req.query?.limit, all: csv });
      if (!r.ok) return fail(res, r.status, r.message);
      if (!csv) return res.status(200).json(r.body);
      return sendCsv(res, safeFileName([r.body.plan?.name, r.body.stage.name, "history", String(req.query?.from || ""), String(req.query?.to || "")]), historyCsv(r.body.rows));
    } catch (error) {
      console.error("[planning-v2] stage history failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // GET /planing-v2/plan/:id/kits -> the movements of kits (store, line, returns, transfers) and the NG picture
  kitsAndNg: async (req, res) => {
    try {
      const r = await loadKitsAndNg({ planId: req.params.id });
      return r.ok ? res.status(200).json(r.body) : fail(res, r.status, r.message);
    } catch (error) {
      console.error("[planning-v2] kits failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // GET /planing-v2/plan/:id/timeline?date=YYYY-MM-DD&operator=&stage= -> what each operator did that day: testing, breaks, idle
  operatorTimeline: async (req, res) => {
    try {
      const r = await loadOperatorTimeline({ planId: req.params.id, date: String(req.query?.date || ""), operator: String(req.query?.operator || ""), stage: String(req.query?.stage || "") });
      return r.ok ? res.status(200).json(r.body) : fail(res, r.status, r.message);
    } catch (error) {
      console.error("[planning-v2] operator timeline failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // GET /planing-v2/plan/:id/hourly?date=YYYY-MM-DD -> one day, hour by hour, pass/NG against target per stage
  hourly: async (req, res) => {
    try {
      const r = await loadHourly({ planId: req.params.id, date: String(req.query?.date || "") });
      return r.ok ? res.status(200).json(r.body) : fail(res, r.status, r.message);
    } catch (error) {
      console.error("[planning-v2] hourly failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // GET /planing-v2/schedule-board?from=YYYY-MM-DD&to=YYYY-MM-DD&room=<id>&drafts=1 -> plans across a range of days, read only
  scheduleBoard: async (req, res) => {
    try {
      const key = /^\d{4}-\d{2}-\d{2}$/;
      const from = String(req.query?.from || "");
      const to = String(req.query?.to || "");
      if (!key.test(from) || !key.test(to)) return fail(res, 400, "from and to must be dates (YYYY-MM-DD).");
      const span = dayNumber(to) - dayNumber(from) + 1;
      if (!(span >= 1)) return fail(res, 400, "The end of the range is before its start.");
      if (span > 62) return fail(res, 400, "Choose a range of at most 62 days.");
      const room = String(req.query?.room || "");
      if (room && !isObjectId(room)) return fail(res, 400, "Invalid floor.");
      const includeDrafts = String(req.query?.drafts || "") === "1";

      const start = (k, end) => new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)), end ? 23 : 0, end ? 59 : 0, end ? 59 : 0);
      const PLAN_LIMIT = 300;
      const plans = await PlaningAndSchedulingModel.find({
        ...(room ? { selectedRoom: room } : {}),
        ...(includeDrafts ? {} : { isDrafted: 0 }),
        startDate: { $lte: start(to, true) },
        $or: [{ estimatedEndDate: { $gte: start(from, false) } }, { estimatedEndDate: null }, { estimatedEndDate: { $exists: false } }],
      })
        .select("processName selectedProcess selectedRoom selectedShift isDrafted startDate estimatedEndDate plannedEndDate scheduleMode daySchedule scheduleDefaults ProcessShiftMappings assignedStages assignedOperators assignedJigs assignedCustomStagesOp overtimeWindows downTime")
        .sort({ startDate: 1 })
        .limit(PLAN_LIMIT)
        .lean();

      const processIds = [...new Set(plans.map((p) => String(p.selectedProcess)).filter(isObjectId))];
      const shiftIds = [...new Set(plans.map((p) => String(p.selectedShift)).filter(isObjectId))];
      const [processDocs, shiftDocs, holidays, roomDocs] = await Promise.all([
        processIds.length ? ProcessModel.find({ _id: { $in: processIds } }).select(loader.PROCESS_SELECT).lean() : [],
        shiftIds.length ? ShiftModel.find({ _id: { $in: shiftIds } }).lean() : [],
        HolidayModel.find({}, { holidayDate: 1 }).limit(2000).lean(),
        RoomPlanModel.find().select("floorName lines.rowName lines.seats.seatNumber").sort({ floorName: 1 }).limit(500).lean(),
      ]);
      const processById = new Map(processDocs.map((p) => [String(p._id), loader.toProcessView(p)]));
      const shiftById = new Map(shiftDocs.map((s) => [String(s._id), s]));
      const holidayKeys = buildHolidayKeys(holidays);
      const lastStageByPlan = new Map(plans.map((p) => [String(p._id), lastStageName(processById.get(String(p.selectedProcess)))]));
      const actuals = await loadActuals({ planIds: plans.filter((p) => Number(p.isDrafted) !== 1).map((p) => String(p._id)), lastStageByPlan, fromKey: from, toKey: to });
      const todayKey = dayKeyLocal(new Date());

      const rows = plans.map((plan) =>
        buildBoardPlan({
          plan,
          process: processById.get(String(plan.selectedProcess)),
          shift: shiftById.get(String(plan.selectedShift)) || null,
          holidayKeys,
          actuals: actuals.get(String(plan._id)),
          fromKey: from,
          toKey: to,
          todayKey,
        }),
      );
      const rooms = roomDocs.map((r) => ({ _id: String(r._id), floorName: r.floorName, lines: (r.lines || []).map((l) => ({ rowName: l.rowName || "", seats: (l.seats || []).map((st) => ({ seatNumber: st.seatNumber })) })) }));
      return res.status(200).json({ status: 200, from, to, today: todayKey, room: room || null, rooms, plans: rows, truncated: plans.length === PLAN_LIMIT });
    } catch (error) {
      console.error("[planning-v2] schedule board failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // POST /planing-v2/schedule/preview -> the day table for a date range and default hours (never writes).
  // Takes the same payload as /validate. Days the planner already edited (daySchedule[].edited) are kept as they
  // are; the rest are generated from the defaults, the template shift and the plant calendar.
  schedulePreview: async (req, res) => {
    try {
      if (!getCustomScheduleEnabled()) return fail(res, 400, "Custom day-wise schedules are not enabled.");
      const planId = isObjectId(req.body?.planId) ? req.body.planId : null;
      const draft = normalizeDraft(pickPlanFields({ ...req.body, scheduleMode: "custom" }, planId ? "update" : "create"), { planId });
      if (!draft.startDate) return fail(res, 400, "A valid start date is required.");
      if (!draft.plannedEndDate) return fail(res, 400, "A valid end date is required.");
      const startKey = dayKeyLocal(draft.startDate);
      const endKey = dayKeyLocal(draft.plannedEndDate);

      const ctx = await loader.loadCore(draft);
      const template = templateFromShift(ctx.shift);
      const wanted = draft.scheduleDefaults || {};
      const defaults = {
        startTime: wanted.startTime || template?.startTime || "",
        endTime: wanted.endTime || template?.endTime || "",
        weekDays: wanted.weekDays || template?.weekDays || { sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false },
        breaks: template?.breaks || [],
        unplacedBreakMinutes: template?.unplacedBreakMinutes || 0,
      };
      if (!defaults.startTime || !defaults.endTime) return fail(res, 400, "Choose a default start and end time (or a template shift).");

      const built = buildDaySchedule({ startKey, endKey, defaults, holidayKeys: ctx.holidayKeys, existing: draft.daySchedule || [], includeHolidays: !!wanted.includeHolidays });
      if (!built.ok) return fail(res, 400, built.problems[0]?.message || "The schedule could not be built.", { problems: built.problems });

      const problems = validateDaySchedule({
        days: built.days,
        startKey,
        endKey,
        weekDays: defaults.weekDays,
        holidayKeys: ctx.holidayKeys,
        template,
        maxDayHours: getMaxDayHours(),
      });

      let suggestion = null;
      if (req.body?.extendToFit === true && ctx.process) {
        suggestion = suggestExtension({ draft, ctx, startKey, endKey, defaults, holidayKeys: ctx.holidayKeys, existing: draft.daySchedule || [], includeHolidays: !!wanted.includeHolidays });
      }

      return res.status(200).json({
        status: 200,
        days: built.days,
        dropped: built.dropped,
        problems,
        defaults: { startTime: defaults.startTime, endTime: defaults.endTime, weekDays: defaults.weekDays, includeHolidays: !!wanted.includeHolidays },
        template: template ? { startTime: template.startTime, endTime: template.endTime, productiveMinutes: template.productiveMinutes, breaks: template.breaks } : null,
        suggestion,
      });
    } catch (error) {
      console.error("[planning-v2] schedulePreview failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // POST /planing-v2/validate -> judge a draft; never writes
  validate: async (req, res) => {
    const started = Date.now();
    try {
      const planId = isObjectId(req.body?.planId) ? req.body.planId : null;
      const draft = normalizeDraft(pickPlanFields({ ...req.body }, planId ? "update" : "create"), { planId });
      if (customScheduleOff(draft)) return fail(res, 400, "Custom day-wise schedules are not enabled.");
      if (planId && !draft.selectedProcess) {
        const existing = await PlaningAndSchedulingModel.findById(planId).select("selectedProcess").lean();
        draft.selectedProcess = String(existing?.selectedProcess || "");
      }
      const ctx = await loader.buildContext(draft);
      const result = validatePlan(draft, ctx);
      return res.status(200).json({ status: 200, mode: draft.mode, ...publicResult(result), durationMs: Date.now() - started });
    } catch (error) {
      console.error("[planning-v2] validate failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // POST /planing-v2/create
  create: async (req, res) => {
    let claimedProcessId = null;
    try {
      const draft = normalizeDraft(pickPlanFields(req.body, "create"));
      const ctx = await loader.buildContext(draft);
      const refError = requireRefs(draft, ctx);
      if (refError) return fail(res, 400, refError);
      if (ctx.process.status === "completed") return fail(res, 409, "This process is completed and cannot be planned.");
      if (!draft.isDrafted && ctx.process.status !== "waiting_schedule") {
        return fail(res, 409, `This process is not waiting for a schedule (status: ${ctx.process.status}).`);
      }

      const result = validatePlan(draft, ctx);
      const gate = gateSave({ result, draft, req });
      await recordEvent({ req, action: "create", mode: gate.mode, draft, result, gate });
      if (gate.blocked) {
        return fail(res, 422, "The plan has conflicts that must be resolved before it can be saved.", { validation: publicResult(result) });
      }

      // Publishing claims the process atomically so two planners cannot both plan it.
      if (!draft.isDrafted) {
        const claimed = await ProcessModel.findOneAndUpdate(
          { _id: draft.selectedProcess, status: "waiting_schedule" },
          { $set: { status: "Waiting_Kits_allocation" } },
        );
        if (!claimed) return fail(res, 409, "This process was just planned by someone else. Reload and try again.");
        claimedProcessId = draft.selectedProcess;
      }

      const built = await buildPlanFields({ draft, ctx, result, existing: null, req });
      const plan = await new PlaningAndSchedulingModel(built.fields).save();
      claimedProcessId = null; // success: keep the new status

      let syncWarning;
      let takeOver;
      if (!draft.isDrafted) {
        takeOver = await moveChosenOperators({ draft, plan, req });
        const sync = await syncPlanAssignments(plan);
        if (!sync.ok) syncWarning = `Plan saved, but operator/jig assignments could not be synchronised: ${sync.error}`;
        await writeLog("CREATE", ctx.process._id, req.user?.id, `${plan.processName} planned by ${req.user?.name || "user"}.`);
        await logAssignments({ plan, process: ctx.process, stages: built.stages, operators: built.operators, jigs: built.jigs, req, verb: "created" });
      }

      return res.status(200).json({
        status: 200,
        message: draft.isDrafted ? "Draft saved." : "Plan created.",
        plan,
        validation: gate.mode === "off" ? undefined : { summary: result.summary, issues: result.issues },
        overrideUsed: gate.overrideUsed || undefined,
        syncWarning,
        takeOver: takeOver && takeOver.moved.length ? takeOver.moved : undefined,
      });
    } catch (error) {
      console.error("[planning-v2] create failed:", error);
      if (claimedProcessId) {
        // The plan was not saved: hand the process back.
        await ProcessModel.updateOne({ _id: claimedProcessId, status: "Waiting_Kits_allocation" }, { $set: { status: "waiting_schedule" } }).catch(() => {});
      }
      return fail(res, 500, error.message);
    }
  },

  // PUT /planing-v2/update/:id
  update: async (req, res) => {
    let claimedProcessId = null;
    try {
      const { id } = req.params;
      if (!isObjectId(id)) return fail(res, 400, "Invalid plan id");
      const existing = await PlaningAndSchedulingModel.findById(id).lean();
      if (!existing) return fail(res, 404, "Plan not found");

      const requestedProcess = req.body?.selectedProcess;
      if (requestedProcess && String(requestedProcess) !== String(existing.selectedProcess)) {
        return fail(res, 409, "A plan cannot be moved to a different process. Delete it and create a new one.");
      }

      // Two people editing at once: refuse when the plan changed since this editor opened it
      const baseRevision = String(req.body?.baseRevision || "");
      if (baseRevision && baseRevision !== planRevision(existing)) {
        return fail(res, 409, "This plan was changed by someone else since you opened it. Reload it and make your changes again.", { code: "REVISION_CONFLICT" });
      }

      const picked = pickPlanFields(req.body, "update");
      picked.selectedProcess = String(existing.selectedProcess);
      const draft = normalizeDraft(picked, { planId: id });
      const wasDraft = Number(existing.isDrafted) === 1;
      if (!wasDraft && draft.isDrafted) return fail(res, 409, "A published plan cannot be turned back into a draft.");

      const ctx = await loader.buildContext(draft);
      const refError = requireRefs(draft, ctx);
      if (refError) return fail(res, 400, refError);
      if (ctx.process.status === "completed") return fail(res, 409, "This process is completed and its plan can no longer be changed.");
      const publishing = wasDraft && !draft.isDrafted;
      if (publishing && ctx.process.status !== "waiting_schedule") {
        return fail(res, 409, `This process is not waiting for a schedule (status: ${ctx.process.status}).`);
      }

      const result = validatePlan(draft, ctx);
      // Protect work already done on a published plan (EDIT-* findings)
      const guard = await runEditGuard({ existing, draft, ctx, result });
      mergeGuardIntoResult(result, guard.issues);
      const guardBlock = guardBlocking(guard.mode, guard.issues);
      const guardOverride = guardBlock.length > 0 && draft.overrideReason.length >= 10 && isFullAccessUser(req.user);
      const gate = gateSave({ result, draft, req });
      await recordEvent({ req, action: "update", mode: gate.mode, draft, result, gate });
      if (gate.blocked) {
        return fail(res, 422, "The plan has conflicts that must be resolved before it can be saved.", { validation: publicResult(result) });
      }
      if (guardBlock.length > 0 && !guardOverride) {
        return fail(res, 422, "This change would affect work that has already been done.", { validation: publicResult(result), guard: { mode: guard.mode, blocking: guardBlock } });
      }

      if (publishing) {
        const claimed = await ProcessModel.findOneAndUpdate(
          { _id: draft.selectedProcess, status: "waiting_schedule" },
          { $set: { status: "Waiting_Kits_allocation" } },
        );
        if (!claimed) return fail(res, 409, "This process was just planned by someone else. Reload and try again.");
        claimedProcessId = draft.selectedProcess;
      }

      const built = await buildPlanFields({ draft, ctx, result, existing, req });
      const { selectedProcess, ...updatable } = built.fields; // process is immutable
      const plan = await PlaningAndSchedulingModel.findByIdAndUpdate(id, { $set: updatable }, { new: true, runValidators: true });
      claimedProcessId = null;

      let syncWarning;
      let takeOver;
      if (!draft.isDrafted) {
        takeOver = await moveChosenOperators({ draft, plan, req });
        const sync = await syncPlanAssignments(plan, {
          previousOperatorIds: wasDraft ? [] : operatorIdsOfPlan(existing),
          previousJigIds: wasDraft ? [] : jigIdsOfPlan(existing),
        });
        if (!sync.ok) syncWarning = `Plan saved, but operator/jig assignments could not be synchronised: ${sync.error}`;
        // The change log says what changed, not just that something did
        let changeSummary = "";
        if (!publishing) {
          const beforeView = storedView(existing);
          const afterView = storedView(plan.toObject());
          const existingShift = guard.existingShift ?? (await resolveExistingShift(existing, ctx));
          changeSummary = " " + diffPlans(beforeView, afterView, {
            beforeSchedule: scheduleOf(beforeView, { shift: existingShift, holidayKeys: ctx.holidayKeys }),
            afterSchedule: scheduleOf(afterView, { shift: ctx.shift, holidayKeys: ctx.holidayKeys }),
          }).summary;
        }
        await writeLog(
          publishing ? "CREATE" : "PLANING_UPDATED",
          ctx.process._id,
          req.user?.id,
          `${plan.processName} ${publishing ? "planned" : "updated"} by ${req.user?.name || "user"}.${changeSummary}`,
        );
        if (publishing) {
          await logAssignments({ plan, process: ctx.process, stages: built.stages, operators: built.operators, jigs: built.jigs, req, verb: "created" });
        }
      }

      return res.status(200).json({
        status: 200,
        message: draft.isDrafted ? "Draft saved." : publishing ? "Plan published." : "Plan updated.",
        plan,
        validation: gate.mode === "off" ? undefined : { summary: result.summary, issues: result.issues },
        overrideUsed: gate.overrideUsed || guardOverride || undefined,
        revision: planRevision(plan.toObject()),
        syncWarning,
      });
    } catch (error) {
      console.error("[planning-v2] update failed:", error);
      if (claimedProcessId) {
        await ProcessModel.updateOne({ _id: claimedProcessId, status: "Waiting_Kits_allocation" }, { $set: { status: "waiting_schedule" } }).catch(() => {});
      }
      return fail(res, 500, error.message);
    }
  },

  // POST /planing-v2/plan/:id/review -> what saving these edits WOULD change, and whether it is allowed. Never writes.
  review: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isObjectId(id)) return fail(res, 400, "Invalid plan id");
      const existing = await PlaningAndSchedulingModel.findById(id).lean();
      if (!existing) return fail(res, 404, "Plan not found");
      const requestedProcess = req.body?.selectedProcess;
      if (requestedProcess && String(requestedProcess) !== String(existing.selectedProcess)) {
        return fail(res, 409, "A plan cannot be moved to a different process. Delete it and create a new one.");
      }

      const picked = pickPlanFields(req.body, "update");
      picked.selectedProcess = String(existing.selectedProcess);
      const draft = normalizeDraft(picked, { planId: id });
      if (customScheduleOff(draft)) return fail(res, 400, "Custom day-wise schedules are not enabled.");
      const ctx = await loader.buildContext(draft);
      const refError = requireRefs(draft, ctx);
      if (refError) return fail(res, 400, refError);

      const result = validatePlan(draft, ctx);
      const guard = await runEditGuard({ existing, draft, ctx, result });
      mergeGuardIntoResult(result, guard.issues);
      const guardBlock = guardBlocking(guard.mode, guard.issues);
      const built = await buildPlanFields({ draft, ctx, result, existing, req });

      const holidayKeys = ctx.holidayKeys;
      const existingShift = guard.existingShift ?? (await resolveExistingShift(existing, ctx));
      const beforeView = storedView(existing);
      const afterView = storedView(built.fields);
      const names = { rooms: {}, shifts: {} };
      if (ctx.room) names.rooms[String(ctx.room._id)] = ctx.room.floorName;
      if (ctx.shift) names.shifts[String(ctx.shift._id)] = ctx.shift.name;
      if (existingShift) names.shifts[String(existingShift._id)] = existingShift.name;
      if (beforeView.roomId && !names.rooms[beforeView.roomId] && isObjectId(beforeView.roomId)) {
        const oldRoom = await RoomPlanModel.findById(beforeView.roomId).select("floorName").lean();
        if (oldRoom) names.rooms[beforeView.roomId] = oldRoom.floorName;
      }
      const diff = diffPlans(beforeView, afterView, {
        beforeSchedule: scheduleOf(beforeView, { shift: existingShift, holidayKeys }),
        afterSchedule: scheduleOf(afterView, { shift: ctx.shift, holidayKeys }),
        labelOf: seatLabelFor(ctx.room),
        names,
      });

      const baseRevision = String(req.body?.baseRevision || "");
      const revision = planRevision(existing);
      const revisionOk = !baseRevision || baseRevision === revision;
      const computed = result.computed;
      return res.status(200).json({
        status: 200,
        summary: diff.summary,
        changes: diff.changes,
        counts: diff.counts,
        impact: diff.impact,
        before: { startKey: beforeView.startKey, endKey: beforeView.endKey, unitsPerDay: Number(existing.totalUPHA) || 0, daysNeeded: Number(existing.totalTimeEstimation) || 0 },
        after: { startKey: computed.startKey, endKey: computed.endKey, unitsPerDay: computed.unitsPerDay, daysNeeded: computed.daysNeeded, shortfallUnits: computed.shortfallUnits ?? 0 },
        issues: result.issues,
        validation: result.summary,
        guard: { mode: guard.mode, blocking: guardBlock },
        revision,
        revisionOk,
        footprint: guard.footprint ? summarizeFootprint(guard.footprint) : null,
        takeOver: await describeTakeover({ processId: existing.selectedProcess, operatorIds: draft.takeOverOperatorIds.filter((opId) => collectOperatorIds(draft).includes(opId)) }),
        overrideAllowed: isFullAccessUser(req.user),
        canSave: revisionOk && guardBlock.length === 0,
      });
    } catch (error) {
      console.error("[planning-v2] review failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // DELETE /planing-v2/delete/:id
  remove: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isObjectId(id)) return fail(res, 400, "Invalid plan id");
      const plan = await PlaningAndSchedulingModel.findById(id).lean();
      if (!plan) return fail(res, 404, "Plan not found");

      const process = await ProcessModel.findById(plan.selectedProcess).select("name status").lean();
      const isDraft = Number(plan.isDrafted) === 1;
      const guardMode = getDeleteGuardMode();
      const risky = !isDraft && !!process && DELETE_BLOCKING_PROCESS_STATUS.has(process.status);
      if (risky && guardMode === "enforce") {
        return fail(res, 409, `This plan cannot be deleted while its process is "${process.status}". Kits or production already depend on it.`);
      }
      if (risky && guardMode === "warn") {
        console.warn(`[planning-v2] deleting plan ${id} whose process is "${process.status}" (PLAN_DELETE_GUARD=warn)`);
      }

      await PlaningAndSchedulingModel.deleteOne({ _id: id });

      // Release resources only when the process had not progressed past kit allocation, so a
      // risky delete in warn mode never frees operators who are mid-production.
      if (!isDraft && process && process.status === "Waiting_Kits_allocation") {
        await AssignOperatorModel.deleteMany({ processId: plan.selectedProcess });
        await AssignJigModel.deleteMany({ processId: plan.selectedProcess });
        await ProcessModel.updateOne({ _id: plan.selectedProcess, status: "Waiting_Kits_allocation" }, { $set: { status: "waiting_schedule" } });
      }

      await writeLog("PLAN_DELETED", plan.selectedProcess, req.user?.id, `Plan "${plan.processName}" ${isDraft ? "(draft) " : ""}deleted by ${req.user?.name || "user"}.`);
      return res.status(200).json({ status: 200, message: "Plan deleted.", processReset: !isDraft && process?.status === "Waiting_Kits_allocation" });
    } catch (error) {
      console.error("[planning-v2] remove failed:", error);
      return fail(res, 500, error.message);
    }
  },

  // exported for tests
  _internal: { gateSave, requireRefs, buildStages, buildAssignments, sortSeatKeys, publicResult, isFullAccessUser, mongoose },
};
