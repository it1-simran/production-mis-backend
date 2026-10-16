// The "computed" values of a plan that runs on a custom day-wise schedule. PURE.
//
// planValidator.computePlan() hands off here when draft.scheduleMode === "custom". The result has
// the SAME shape computePlan returns for a shift plan, so the validator's rule groups, the save path
// and the builder read it unchanged, plus a few custom-only fields (custom, dayWindows, days,
// dayPlan, scheduleProblems).
//
// How the schedule becomes numbers:
//   - dayGenerator expands the plan into its working days (each with its own window and productive
//     minutes); dayCapacity turns each day's seats into output and finds the forecast end.
//   - "unitsPerDay" and "productiveMinutesPerDay" are the AVERAGE over the scheduled days (older
//     screens and the stored totalUPHA expect one figure); "daysNeeded" is the fractional number of
//     scheduled days the quantity takes (or, if the schedule is too short, the days at average output).

const { getMaxDayHours } = require("../../config/planningFlags");
const { dayKeyLocal, dayNumber, dayKeyFromNumber, formatPlanDate, buildWindow } = require("../../utils/planDates");
const { buildDaySchedule } = require("./daySchedule");
const { computeCapacity } = require("./capacity");
const { expandPlanToDays } = require("./dayGenerator");
const { computeDayPlan } = require("./dayCapacity");

const dateOfKey = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

const computeCustomPlan = (draft, ctx, rangeOverride = null) => {
  const entries = draft.daySchedule || [];
  const workingKeys = entries
    .filter((e) => e.working && /^\d{4}-\d{2}-\d{2}$/.test(e.dayKey))
    .map((e) => e.dayKey)
    .sort();
  const lastWorkingKey = workingKeys.length ? workingKeys[workingKeys.length - 1] : "";

  // The range end is the date the planner chose, or the last scheduled day.
  const rangeEnd = draft.plannedEndDate || dateOfKey(lastWorkingKey);
  // With no scheduled day and no chosen end date there is nothing to expand; say so plainly.
  const noDays = !rangeEnd
    ? { ok: false, days: [], calendar: null, problems: [{ code: "CAL-004", severity: "error", message: "The schedule has no working day.", field: "daySchedule" }] }
    : null;
  const expanded = noDays || expandPlanToDays({
    draft,
    endDate: rangeEnd,
    shift: ctx.shift || null,
    holidayKeys: ctx.holidayKeys || new Set(),
    commonStages: ctx.process?.commonStages || [],
    daySchedule: entries,
    maxDayHours: getMaxDayHours(),
  });
  const days = expanded.ok ? expanded.days : [];

  const processStages = ctx.process?.stages || [];
  const quantity = ctx.process?.quantity;
  const dayPlan = computeDayPlan({
    days,
    processStages,
    quantity,
    overtimeWindows: ctx.existingPlan?.overtimeWindows || [],
    downTime: ctx.existingPlan?.downTime || null,
  });

  // Seat counts and the slowest stage come from the template (the same maths as a shift plan).
  const base = computeCapacity({ processStages, assignedStages: draft.assignedStages, shift: null, quantity });
  const dayCount = dayPlan.perDay.length;
  const totalCapacity = dayPlan.perDay.reduce((sum, d) => sum + d.capacityUnits, 0);
  const averageUnits = dayCount > 0 ? totalCapacity / dayCount : 0;
  const averageMinutes = dayCount > 0 ? dayPlan.perDay.reduce((sum, d) => sum + d.capacityMinutes, 0) / dayCount : 0;
  const qty = base.quantity;

  let daysNeeded = 0;
  if (qty > 0 && averageUnits > 0) {
    const usedDays = dayPlan.perDay.reduce((sum, d) => sum + (d.capacityUnits > 0 ? d.plannedUnits / d.capacityUnits : 0), 0);
    daysNeeded = usedDays + (dayPlan.forecast.shortfallUnits > 0 ? dayPlan.forecast.shortfallUnits / averageUnits : 0);
  }
  const capacity = { ...base, productiveMinutesPerDay: averageMinutes, productiveHoursPerDay: averageMinutes / 60, unitsPerDay: averageUnits, daysNeeded };

  const forecastEndKey = dayPlan.forecast.forecastEndKey || "";
  const forecastEnd = dateOfKey(forecastEndKey);
  const endDate = dateOfKey(lastWorkingKey);
  const startKey = rangeOverride?.startKey || dayKeyLocal(draft.startDate);
  const endKey = rangeOverride?.endKey || lastWorkingKey || startKey;
  const firstDay = days[0] || null;

  const scheduleProblems = [...expanded.problems, ...dayPlan.problems].filter(
    // "nothing placed" is already reported by the structure rules
    (p) => p.code !== "STRUCT-001",
  );

  return {
    custom: true,
    capacity,
    // the effective finish is the last scheduled day
    endDate,
    estimatedEndDate: endDate ? formatPlanDate(endDate) : "",
    // what capacity alone says: the day-by-day forecast end
    capacityEndDate: forecastEnd,
    capacityEndDateText: forecastEnd ? formatPlanDate(forecastEnd) : "",
    capacityEndKey: forecastEndKey,
    // in custom mode the planned end is the range end, and the schedule is judged against it by DAY-002
    plannedEnd: draft.plannedEndDate || null,
    plannedEndKey: draft.plannedEndDate ? dayKeyLocal(draft.plannedEndDate) : "",
    plannedWorkingDays: dayCount,
    plannedCapacityUnits: totalCapacity,
    shortfallUnits: dayPlan.forecast.shortfallUnits,
    startKey,
    endKey,
    startDay: dayNumber(startKey),
    endDay: dayNumber(endKey),
    window: firstDay ? buildWindow(firstDay.window.startTime, firstDay.window.endTime) : null,
    overrideWindow: null,
    unitsPerDay: averageUnits,
    totalUPHA: averageUnits > 0 ? averageUnits.toFixed(2) : "0.00",
    totalTimeEstimation: daysNeeded > 0 ? daysNeeded.toFixed(2) : "0.00",
    // custom-only
    dayWindows: days.map((d) => ({ absStart: d.absStart, absEnd: d.absEnd, start: d.absStart - d.dayNumber * 1440, end: d.absEnd - d.dayNumber * 1440 })),
    days,
    dayPlan,
    scheduleProblems,
    scheduleOk: expanded.ok,
  };
};

// What the builder shows for each day: its hours and what it makes.
const publicDays = (computed) =>
  (computed.days || []).map((d, i) => {
    const p = computed.dayPlan?.perDay?.[i] || {};
    return {
      dayKey: d.dayKey,
      startTime: d.window.startTime,
      endTime: d.window.endTime,
      productiveMinutes: d.productiveMinutes,
      capacityUnits: p.capacityUnits ?? 0,
      plannedUnits: p.plannedUnits ?? 0,
      cumulativeUnits: p.cumulativeUnits ?? 0,
      stalled: !!p.stalled,
    };
  });

// "Extend to fit": how many more days, at the default hours, would cover the quantity? Walks the end date
// forward one day at a time (days off and holidays add nothing) and stops at the first end date whose
// schedule covers the quantity. Returns null when nothing would help (no output at all) or the limit is hit.
const suggestExtension = ({ draft, ctx, startKey, endKey, defaults, holidayKeys, existing, includeHolidays, maxExtraDays = 120 }) => {
  const base = dayNumber(endKey);
  for (let extra = 0; extra <= maxExtraDays; extra += 1) {
    const newEndKey = dayKeyFromNumber(base + extra);
    const built = buildDaySchedule({ startKey, endKey: newEndKey, defaults, holidayKeys, existing, includeHolidays });
    if (!built.ok) return null;
    const computed = computeCustomPlan({ ...draft, daySchedule: built.days, plannedEndDate: dateOfKey(newEndKey) }, ctx);
    if (!computed.scheduleOk || computed.unitsPerDay <= 0) return null;
    if (computed.shortfallUnits === 0 && computed.capacityEndKey) return { endKey: newEndKey, extraDays: extra, forecastEndKey: computed.capacityEndKey };
  }
  return null;
};

module.exports = { computeCustomPlan, publicDays, dateOfKey, suggestExtension };
