// Day-wise expansion of a plan (Phase 2, slice 1). PURE: no database, no clock, no globals.
//
// A plan is a template ("what a normal day looks like": seat -> stage / operators / jigs). This
// module turns the template into one entry per working day, each holding one row per seat
// (and one per common-stage slot that has people). The same function is used to persist rows and
// to expand a legacy or stale plan in memory, so a conflict check never depends on whether a plan
// has been converted.
//
//   expandPlanToDays({ draft, endDate, shift, holidayKeys, commonStages, maxDays })
//     -> { ok, days, problems, calendar }
//
// `draft` is draft.normalizeDraft() output (or anything with the same fields). `endDate` is the
// plan's effective finish (the planner's date if set, otherwise the capacity estimate); this
// module does not decide it, so there is no circularity with capacity.
//
// Conventions (same as utils/planDates.js):
//  - a day is a "YYYY-MM-DD" key; the production day of an overnight shift is the day it STARTS;
//  - absStart/absEnd are minutes since the epoch day, so overlap tests are plain range checks;
//  - days are every working day from the start day to the end day, both included.

const {
  dayKeyLocal,
  dayNumber,
  buildWindow,
  listWorkingDayKeys,
  weekdayOfKey,
} = require("../../utils/planDates");
const { getProductiveMinutes } = require("./capacity");
const { toList, idOf, seatKeyParts } = require("./draft");
const { windowOf, productiveMinutesOf, validateDaySchedule, templateFromShift, normalizeDaySchedule } = require("./daySchedule");

const DEFAULT_MAX_DAYS = 120;

const problem = (code, severity, message, extra = {}) => ({ code, severity, message, ...extra });

const compareSeatKeys = (a, b) => {
  const pa = seatKeyParts(a);
  const pb = seatKeyParts(b);
  return pa.row - pb.row || pa.seat - pb.seat;
};

// What is kept of a template stage entry. Production counters (passedDevice, ngDevice, totalUPHA)
// are deliberately NOT copied: they belong to execution, not to the plan.
const stageSnapshot = (entry) => {
  const upha = Number(entry?.upha);
  return {
    name: String(entry?.name || entry?.stageName || ""),
    stageInstanceId: String(entry?.stageInstanceId || ""),
    parallelGroupKey: String(entry?.parallelGroupKey || ""),
    requiredSkill: String(entry?.requiredSkill || ""),
    managedBy: String(entry?.managedBy || ""),
    upha: Number.isFinite(upha) ? upha : 0,
    hasJigStepType: !!entry?.hasJigStepType,
  };
};

const idsOf = (slot) => Array.from(new Set(toList(slot).map(idOf).filter(Boolean)));

// Rows for ONE day. Built fresh each time so no two days share an array or object.
const buildRows = ({ seatPlan, commonPlan }) => {
  const rows = [];
  seatPlan.forEach((seat) => {
    rows.push({
      kind: "seat",
      seatKey: seat.seatKey,
      rowIndex: seat.rowIndex,
      seatIndex: seat.seatIndex,
      commonSlot: null,
      stage: { ...seat.stage },
      operatorIds: [...seat.operatorIds],
      jigIds: [...seat.jigIds],
      source: "template",
      adjustedFields: [],
      state: "active",
    });
  });
  commonPlan.forEach((slot) => {
    rows.push({
      kind: "common",
      seatKey: null,
      rowIndex: null,
      seatIndex: null,
      commonSlot: slot.commonSlot,
      stage: { ...slot.stage },
      operatorIds: [...slot.operatorIds],
      jigIds: [],
      source: "template",
      adjustedFields: [],
      state: "active",
    });
  });
  return rows;
};

// The part of the template that is the same on every day.
const readTemplate = (draft, commonStages, problems) => {
  const stages = draft.assignedStages || {};
  const operators = draft.assignedOperators || {};
  const jigs = draft.assignedJigs || {};

  const seatPlan = [];
  Object.keys(stages)
    .sort(compareSeatKeys)
    .forEach((seatKey) => {
      const parts = seatKeyParts(seatKey);
      if (!parts.valid) return;
      const entries = toList(stages[seatKey]).filter((e) => e && !e.reserved);
      if (entries.length === 0) return;
      if (entries.length > 1) {
        problems.push(
          problem("DAY-009", "info", `Seat ${seatKey} lists ${entries.length} stages; only the first (${stageSnapshot(entries[0]).name}) is planned day by day.`, { seatKey }),
        );
      }
      seatPlan.push({
        seatKey,
        rowIndex: parts.row,
        seatIndex: parts.seat,
        stage: stageSnapshot(entries[0]),
        operatorIds: idsOf(operators[seatKey]),
        jigIds: idsOf(jigs[seatKey]),
      });
    });

  // Common-service stages: one row per slot that has people (the slot index is the process's
  // common-stage index, the same indexing the plan's assignedCustomStagesOp uses).
  const commonPlan = [];
  (draft.assignedCustomStagesOp || []).forEach((slot, index) => {
    const operatorIds = idsOf(slot);
    if (operatorIds.length === 0) return;
    const def = (commonStages || [])[index] || {};
    commonPlan.push({
      commonSlot: index,
      stage: stageSnapshot({ name: def.stageName || def.name || `Common stage ${index + 1}`, managedBy: def.managedBy, requiredSkill: def.requiredSkill }),
      operatorIds,
    });
  });

  return { seatPlan, commonPlan };
};

// Custom schedule: the days and their hours come from the plan's own day list (daySchedule.js)
// instead of a shift. Every entry marked working becomes a day, with its own window and productive
// minutes. Errors in the list (bad times, overlapping days, days outside the range) refuse the plan.
const expandFromSchedule = ({ draft, startKey, endKey, daySchedule, shift, holidayKeys, commonStages, maxDays, maxDayHours, problems, fail }) => {
  const entries = normalizeDaySchedule(daySchedule);
  const found = validateDaySchedule({
    days: entries,
    startKey,
    endKey,
    weekDays: shift?.weekDays || null,
    holidayKeys,
    template: templateFromShift(shift),
    maxDayHours,
  });
  found.forEach((p) => problems.push(p));
  if (found.some((p) => p.severity === "error")) return fail();

  const working = entries.filter((e) => e.working).sort((a, b) => (a.dayKey < b.dayKey ? -1 : 1));
  if (working.length === 0) {
    problems.push(problem("CAL-004", "error", "The schedule has no working day.", { field: "daySchedule" }));
    return fail();
  }
  if (working.length > maxDays) {
    problems.push(problem("DAY-006", "info", `The schedule has more than ${maxDays} working days, which is too long for day-wise planning. It stays range-based.`));
    return fail({ calendar: { startKey, endKey, workingDays: working.length, window: null, truncated: true } });
  }

  const template = readTemplate(draft, commonStages, problems);
  if (template.seatPlan.length === 0 && template.commonPlan.length === 0) {
    problems.push(problem("STRUCT-001", "info", "No stages have been placed on any seat yet, so no day rows were created."));
  }

  const days = working.map((entry) => {
    const window = windowOf(entry);
    const base = dayNumber(entry.dayKey) * 1440;
    return {
      dayKey: entry.dayKey,
      dayNumber: dayNumber(entry.dayKey),
      weekday: weekdayOfKey(entry.dayKey),
      isStartDay: entry.dayKey === startKey,
      custom: true,
      window: { startTime: entry.startTime, endTime: entry.endTime },
      absStart: base + window.start,
      absEnd: base + window.end,
      productiveMinutes: productiveMinutesOf(entry),
      breaks: entry.breaks.map((b) => ({ ...b })),
      note: entry.note,
      rows: buildRows(template),
    };
  });

  return {
    ok: true,
    days,
    problems,
    calendar: { startKey, endKey, workingDays: days.length, window: days[0].window, truncated: false, scheduleMode: "custom" },
  };
};

const expandPlanToDays = ({
  draft,
  endDate,
  shift,
  holidayKeys = new Set(),
  commonStages = [],
  maxDays = DEFAULT_MAX_DAYS,
  daySchedule = null,
  maxDayHours = 16,
} = {}) => {
  const problems = [];
  const fail = (extra = {}) => ({ ok: false, days: [], problems, calendar: null, ...extra });

  const start = draft?.startDate;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    problems.push(problem("CAL-004", "error", "Start date is missing or not a valid date.", { field: "startDate" }));
    return fail();
  }
  if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
    problems.push(problem("DAY-008", "error", "The plan has no usable end date, so it cannot be expanded into days.", { field: "estimatedEndDate" }));
    return fail();
  }
  const startKey = dayKeyLocal(start);
  const endKey = dayKeyLocal(endDate);
  if (endKey < startKey) {
    problems.push(problem("CAL-005", "error", "The end date is before the start date.", { field: "plannedEndDate" }));
    return fail();
  }

  if (Array.isArray(daySchedule)) {
    return expandFromSchedule({ draft, startKey, endKey, daySchedule, shift, holidayKeys, commonStages, maxDays, maxDayHours, problems, fail });
  }

  // Shift window: the plan's override wins, otherwise the shift itself.
  const override = draft.shiftOverride || null;
  const overrideWindow = override ? buildWindow(override.startTime, override.endTime) : null;
  if (override && !overrideWindow) {
    problems.push(problem("SHIFT-001", "error", "The shift override times are not valid HH:mm values.", { field: "ProcessShiftMappings" }));
    return fail();
  }
  const shiftWindow = overrideWindow || buildWindow(shift?.startTime, shift?.endTime);
  if (!shiftWindow || getProductiveMinutes(shift) <= 0) {
    problems.push(problem("SHIFT-002", "error", "The shift has no usable working time, so days cannot be planned.", { field: "selectedShift" }));
    return fail();
  }
  const windowText = override
    ? { startTime: String(override.startTime), endTime: String(override.endTime) }
    : { startTime: String(shift.startTime), endTime: String(shift.endTime) };

  const weekDays = shift?.weekDays;
  const { keys, truncated } = listWorkingDayKeys(startKey, endKey, { weekDays, holidayKeys, limit: maxDays });
  if (truncated) {
    problems.push(
      problem("DAY-006", "info", `The plan runs for more than ${maxDays} working days, which is too long for day-wise planning. It stays range-based.`),
    );
    return fail({ calendar: { startKey, endKey, workingDays: keys.length, window: windowText, truncated: true } });
  }
  if (keys.length === 0) {
    problems.push(problem("CAL-004", "error", "There is no working day between the start and end dates.", { field: "startDate" }));
    return fail();
  }

  const template = readTemplate(draft, commonStages, problems);
  if (template.seatPlan.length === 0 && template.commonPlan.length === 0) {
    problems.push(problem("STRUCT-001", "info", "No stages have been placed on any seat yet, so no day rows were created."));
  }

  const days = keys.map((dayKey) => {
    const base = dayNumber(dayKey) * 1440;
    return {
      dayKey,
      dayNumber: dayNumber(dayKey),
      weekday: weekdayOfKey(dayKey),
      isStartDay: dayKey === startKey,
      window: windowText,
      absStart: base + shiftWindow.start,
      absEnd: base + shiftWindow.end, // already past midnight for an overnight shift
      rows: buildRows(template),
    };
  });

  return {
    ok: true,
    days,
    problems,
    calendar: { startKey, endKey, workingDays: days.length, window: windowText, truncated: false },
  };
};

module.exports = { expandPlanToDays, stageSnapshot, DEFAULT_MAX_DAYS };
