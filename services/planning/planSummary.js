// Reduces a stored plan document to the small, pre-parsed shape the validator compares against.
// Pure: no database access, so tests can feed it plain objects.

const { parsePlanDate, dayKeyLocal, dayNumber, buildWindow } = require("../../utils/planDates");
const { normalizeDaySchedule, windowOf } = require("./daySchedule");
const { safeParse, toList, idOf } = require("./draft");

const summarizePlan = (plan, extras = {}) => {
  const stages = safeParse(plan?.assignedStages, {}) || {};
  const operators = safeParse(plan?.assignedOperators, {}) || {};
  const jigs = safeParse(plan?.assignedJigs, {}) || {};
  const customOpsRaw = safeParse(plan?.assignedCustomStagesOp, []);
  const customOps = Array.isArray(customOpsRaw) ? customOpsRaw : Object.values(customOpsRaw || {});

  const start = parsePlanDate(plan?.startDate);
  let end = parsePlanDate(plan?.estimatedEndDate);
  const estimationDays = Number(plan?.totalTimeEstimation);
  if (!end && start && Number.isFinite(estimationDays) && estimationDays > 0) {
    end = new Date(start.getTime());
    end.setDate(end.getDate() + Math.ceil(estimationDays));
  }
  // Active overtime windows extend the occupied range.
  (Array.isArray(plan?.overtimeWindows) ? plan.overtimeWindows : []).forEach((w) => {
    if (w?.active === false) return;
    const to = parsePlanDate(w?.to);
    if (to && (!end || to > end)) end = to;
  });

  const mapping = plan?.ProcessShiftMappings || {};
  const operatorIds = new Set();
  Object.values(operators).forEach((slot) => toList(slot).forEach((op) => idOf(op) && operatorIds.add(idOf(op))));
  customOps.forEach((slot) => toList(slot).forEach((op) => idOf(op) && operatorIds.add(idOf(op))));
  const jigIds = new Set();
  Object.values(jigs).forEach((slot) => toList(slot).forEach((j) => idOf(j) && jigIds.add(idOf(j))));

  const seatStage = new Map();
  Object.entries(stages).forEach(([key, entries]) => {
    const first = toList(entries).find((e) => e && !e.reserved);
    if (first) seatStage.set(key, String(first.name || first.stageName || ""));
  });

  // A custom day-wise schedule: the real windows of every working day (absolute minutes, sorted).
  const dayWindows =
    plan?.scheduleMode === "custom"
      ? normalizeDaySchedule(plan.daySchedule)
          .filter((e) => e.working && windowOf(e))
          .map((e) => {
            const w = windowOf(e);
            const base = dayNumber(e.dayKey) * 1440;
            return { absStart: base + w.start, absEnd: base + w.end, start: w.start, end: w.end };
          })
          .sort((a, b) => a.absStart - b.absStart)
      : [];

  return {
    id: String(plan?._id || ""),
    processId: String(plan?.selectedProcess || ""),
    processName: plan?.processName || extras.processName || "",
    processStatus: extras.processStatus || "",
    roomId: String(plan?.selectedRoom || ""),
    shiftId: String(plan?.selectedShift || ""),
    isDrafted: Number(plan?.isDrafted) === 1,
    startKey: dayKeyLocal(start),
    endKey: dayKeyLocal(end || start),
    startDay: dayNumber(dayKeyLocal(start)),
    endDay: dayNumber(dayKeyLocal(end || start)),
    window: buildWindow(mapping.startTime, mapping.endTime),
    custom: dayWindows.length > 0,
    dayWindows,
    seatStage, // Map<seatKey, stageName>
    operators,
    operatorIds,
    jigIds,
  };
};

module.exports = { summarizePlan };
