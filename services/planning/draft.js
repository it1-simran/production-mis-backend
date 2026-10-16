// Normalisation of an incoming plan body into a "draft" the validator and controller share,
// plus the field whitelist that replaces the legacy `new Model(req.body)` mass assignment.

const mongoose = require("mongoose");
const { parsePlanDate } = require("../../utils/planDates");
const { normalizeDaySchedule, normTime, DAY_NAMES } = require("./daySchedule");

const safeParse = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toList = (value) => (Array.isArray(value) ? value.filter(Boolean) : value ? [value] : []);

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));

const idOf = (obj) => String(obj?._id || obj?.id || obj?.userId || obj?.jigId || "");

// "r-s" -> { row, seat, valid }
const seatKeyParts = (key) => {
  const m = /^(\d+)-(\d+)$/.exec(String(key || ""));
  return m ? { row: Number(m[1]), seat: Number(m[2]), valid: true } : { row: -1, seat: -1, valid: false };
};

// Fields a client may set. Everything else (status, downTime, overtimeWindows, createdBy ...)
// is ignored. `selectedProcess` is create-only: a plan cannot be moved to another process.
const CREATE_FIELDS = [
  "processName",
  "selectedProcess",
  "selectedRoom",
  "selectedShift",
  "repeatCount",
  "startDate",
  "plannedEndDate",
  "scheduleMode",
  "daySchedule",
  "scheduleDefaults",
  "assignedStages",
  "assignedOperators",
  "assignedJigs",
  "assignedCustomStagesOp",
  "takeOverOperatorIds",
  "isDrafted",
  "overrideReason",
  "ProcessShiftMappings",
];
const UPDATE_FIELDS = CREATE_FIELDS.filter((f) => f !== "selectedProcess");

const pickPlanFields = (body, mode = "create") => {
  const allowed = mode === "update" ? UPDATE_FIELDS : CREATE_FIELDS;
  const source = body && typeof body === "object" ? body : {};
  const out = {};
  allowed.forEach((field) => {
    if (source[field] !== undefined) out[field] = source[field];
  });
  return out;
};

// The defaults the planner used to generate the day table (kept so it can be regenerated or extended).
const normalizeScheduleDefaults = (raw) => {
  const value = safeParse(raw, null);
  if (!value || typeof value !== "object") return null;
  const weekDays = value.weekDays && typeof value.weekDays === "object" ? Object.fromEntries(DAY_NAMES.map((d) => [d, !!value.weekDays[d]])) : null;
  return {
    startTime: normTime(value.startTime),
    endTime: normTime(value.endTime),
    weekDays,
    includeHolidays: value.includeHolidays === true || value.includeHolidays === "true",
  };
};

// Turns a (whitelisted) body into the structure the validator expects.
const normalizeDraft = (body, { planId = null } = {}) => {
  const input = body && typeof body === "object" ? body : {};
  const isDrafted = Number(input.isDrafted) === 1 || input.isDrafted === true || input.isDrafted === "1";

  const stagesRaw = safeParse(input.assignedStages, {});
  const operatorsRaw = safeParse(input.assignedOperators, {});
  const jigsRaw = safeParse(input.assignedJigs, {});
  const customOpsRaw = safeParse(input.assignedCustomStagesOp, []);

  const asMap = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  const customOps = Array.isArray(customOpsRaw)
    ? customOpsRaw.map((slot) => toList(slot))
    : Object.keys(asMap(customOpsRaw))
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => toList(customOpsRaw[k]));

  const repeat = Number(input.repeatCount);
  const shiftMapping = safeParse(input.ProcessShiftMappings, {});

  return {
    planId: planId ? String(planId) : input.planId ? String(input.planId) : null,
    mode: isDrafted ? "draft" : "publish",
    isDrafted,
    processName: String(input.processName || ""),
    selectedProcess: String(input.selectedProcess || ""),
    selectedRoom: String(input.selectedRoom || ""),
    selectedShift: String(input.selectedShift || ""),
    startDate: parsePlanDate(input.startDate),
    startDateRaw: input.startDate,
    // Optional finish date chosen by the planner. When absent, the finish date is calculated.
    plannedEndDate: parsePlanDate(input.plannedEndDate),
    // "shift" (the default, and what every existing plan is) or "custom" (per-day hours, see daySchedule.js)
    scheduleMode: input.scheduleMode === "custom" ? "custom" : "shift",
    daySchedule: input.scheduleMode === "custom" ? normalizeDaySchedule(input.daySchedule) : null,
    scheduleDefaults: input.scheduleMode === "custom" ? normalizeScheduleDefaults(input.scheduleDefaults) : null,
    repeatCount: Number.isFinite(repeat) && repeat >= 1 ? Math.floor(repeat) : 1,
    shiftOverride:
      shiftMapping && (shiftMapping.startTime || shiftMapping.endTime)
        ? { startTime: shiftMapping.startTime || "", endTime: shiftMapping.endTime || "" }
        : null,
    assignedStages: asMap(stagesRaw),
    assignedOperators: asMap(operatorsRaw),
    assignedJigs: asMap(jigsRaw),
    assignedCustomStagesOp: customOps,
    // Operators the planner chose from another process on purpose: saving moves them here (see operatorTakeover.js)
    takeOverOperatorIds: Array.from(new Set((Array.isArray(input.takeOverOperatorIds) ? input.takeOverOperatorIds : []).map((id) => String(id || "")).filter(isObjectId))),
    overrideReason: String(input.overrideReason || "").trim(),
  };
};

const collectOperatorIds = (draft) => {
  const ids = new Set();
  Object.values(draft.assignedOperators || {}).forEach((slot) => toList(slot).forEach((op) => idOf(op) && ids.add(idOf(op))));
  (draft.assignedCustomStagesOp || []).forEach((slot) => toList(slot).forEach((op) => idOf(op) && ids.add(idOf(op))));
  return [...ids].filter(isObjectId);
};

const collectJigIds = (draft) => {
  const ids = new Set();
  Object.values(draft.assignedJigs || {}).forEach((slot) => toList(slot).forEach((j) => idOf(j) && ids.add(idOf(j))));
  return [...ids].filter(isObjectId);
};

// Non-reserved stage entries of one seat.
const stageEntriesOf = (assignedStages, seatKey) =>
  toList(assignedStages?.[seatKey]).filter((s) => s && !s.reserved);

module.exports = {
  safeParse,
  toList,
  isObjectId,
  idOf,
  seatKeyParts,
  pickPlanFields,
  normalizeDraft,
  normalizeScheduleDefaults,
  collectOperatorIds,
  collectJigIds,
  stageEntriesOf,
  CREATE_FIELDS,
  UPDATE_FIELDS,
};
