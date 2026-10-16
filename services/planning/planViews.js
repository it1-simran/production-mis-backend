// Comparable "views" of a plan, used by the edit guard, the change diff and the revision fingerprint. PURE.
//
// A stored plan (JSON-string blobs, Mongo dates) and an edited draft (normalised request) are turned
// into the SAME plain shape so they can be compared field by field:
//   { mode, startKey, endKey, plannedEndKey, roomId, shiftId, hours:{startTime,endTime},
//     stages, operators, jigs, common, daySchedule }
// plus a day-by-day "schedule" (one entry per working or non-working day) so a shift plan and a custom plan
// can be compared on the same footing: what hours does each day have?

const { dayKeyLocal, parsePlanDate } = require("../../utils/planDates");
const { safeParse, toList, idOf } = require("./draft");
const { buildDaySchedule, templateFromShift, normalizeDaySchedule, normTime } = require("./daySchedule");

const asMap = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

const keyOfDate = (value) => {
  const date = parsePlanDate(value);
  return date ? dayKeyLocal(date) : "";
};

const stageNameOf = (entries) => {
  const first = toList(entries).find((e) => e && !e.reserved);
  return first ? String(first.name || first.stageName || "") : "";
};

// A stored plan document -> view.
const storedView = (plan) => {
  const custom = plan?.scheduleMode === "custom";
  const customOpsRaw = safeParse(plan?.assignedCustomStagesOp, []);
  const mapping = plan?.ProcessShiftMappings || {};
  return {
    mode: custom ? "custom" : "shift",
    startKey: keyOfDate(plan?.startDate),
    endKey: keyOfDate(plan?.estimatedEndDate),
    plannedEndKey: keyOfDate(plan?.plannedEndDate),
    roomId: String(plan?.selectedRoom || ""),
    shiftId: String(plan?.selectedShift || ""),
    hours: { startTime: normTime(mapping.startTime), endTime: normTime(mapping.endTime) },
    stages: asMap(safeParse(plan?.assignedStages, {})),
    operators: asMap(safeParse(plan?.assignedOperators, {})),
    jigs: asMap(safeParse(plan?.assignedJigs, {})),
    common: Array.isArray(customOpsRaw) ? customOpsRaw : Object.values(asMap(customOpsRaw)),
    daySchedule: custom ? normalizeDaySchedule(plan?.daySchedule) : [],
  };
};

// A normalised draft (draft.normalizeDraft) plus its computed range -> view.
const draftView = (draft, computed) => {
  const custom = draft?.scheduleMode === "custom";
  return {
    mode: custom ? "custom" : "shift",
    startKey: draft?.startDate ? dayKeyLocal(draft.startDate) : "",
    endKey: computed?.endKey || "",
    plannedEndKey: draft?.plannedEndDate ? dayKeyLocal(draft.plannedEndDate) : "",
    roomId: String(draft?.selectedRoom || ""),
    shiftId: String(draft?.selectedShift || ""),
    hours: { startTime: normTime(draft?.shiftOverride?.startTime), endTime: normTime(draft?.shiftOverride?.endTime) },
    stages: asMap(draft?.assignedStages),
    operators: asMap(draft?.assignedOperators),
    jigs: asMap(draft?.assignedJigs),
    common: Array.isArray(draft?.assignedCustomStagesOp) ? draft.assignedCustomStagesOp : [],
    daySchedule: custom ? normalizeDaySchedule(draft?.daySchedule) : [],
  };
};

// The hours of every day of a plan, whatever its mode. A custom plan's own list; a shift plan's list is the
// one a custom schedule built from that shift would have (same weekly days off, holidays and breaks).
// Returns [{ dayKey, working, startTime, endTime, breaks }].
const scheduleOf = (view, { shift = null, holidayKeys = new Set() } = {}) => {
  if (view.mode === "custom") return view.daySchedule;
  const template = templateFromShift(shift);
  const startTime = view.hours.startTime || template?.startTime || "";
  const endTime = view.hours.endTime || template?.endTime || "";
  if (!template || !startTime || !endTime || !view.startKey || !view.endKey || view.endKey < view.startKey) return [];
  const built = buildDaySchedule({ startKey: view.startKey, endKey: view.endKey, defaults: { ...template, startTime, endTime }, holidayKeys });
  return built.ok ? built.days : [];
};

// Compact comparison text for one day ("" for a day that is off or missing).
const dayHours = (entry) => {
  if (!entry || !entry.working) return "";
  const breaks = (entry.breaks || []).map((b) => `${b.startTime}-${b.endTime}`).join(",");
  return `${entry.startTime}-${entry.endTime}${breaks ? `|${breaks}` : ""}`;
};

const operatorIdsOnSeat = (view, seatKey) => toList(view.operators?.[seatKey]).map(idOf).filter(Boolean);

module.exports = { storedView, draftView, scheduleOf, dayHours, stageNameOf, operatorIdsOnSeat, keyOfDate };
