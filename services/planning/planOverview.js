// Read-only views of plans: one plan's overview (planned against actual, day by day) and the schedule board
// (many plans across a range of days). PURE: everything is passed in, nothing is read or written here.
//
// How a plan becomes its days: the stored plan is expanded by the same code the validator uses (dayGenerator),
// each day's output comes from dayCapacity, and each day's ACTUAL output comes from planActuals. A shift plan and
// a custom-schedule plan therefore look the same to the screens.

const { normalizeDraft, safeParse, toList } = require("./draft");
const { parsePlanDate, dayKeyLocal } = require("../../utils/planDates");
const { expandPlanToDays } = require("./dayGenerator");
const { computeDayPlan } = require("./dayCapacity");
const { normName } = require("./capacity");
const { emptyPlan } = require("./planActuals");

const lastStageName = (process) => {
  const stages = process?.stages || [];
  return stages.length ? String(stages[stages.length - 1].stageName || "") : "";
};

// A stored plan -> the draft the validator and the day generator work with (the same shape the audit scripts use).
const draftFromStored = (plan) =>
  normalizeDraft(
    {
      selectedProcess: String(plan?.selectedProcess || ""),
      selectedRoom: String(plan?.selectedRoom || ""),
      selectedShift: String(plan?.selectedShift || ""),
      processName: plan?.processName,
      startDate: plan?.startDate,
      plannedEndDate: plan?.plannedEndDate,
      repeatCount: plan?.repeatCount,
      isDrafted: plan?.isDrafted,
      scheduleMode: plan?.scheduleMode,
      daySchedule: plan?.daySchedule,
      scheduleDefaults: plan?.scheduleDefaults,
      assignedStages: plan?.assignedStages,
      assignedOperators: plan?.assignedOperators,
      assignedJigs: plan?.assignedJigs,
      assignedCustomStagesOp: plan?.assignedCustomStagesOp,
      ProcessShiftMappings: plan?.ProcessShiftMappings,
    },
    { planId: String(plan?._id || "") },
  );

// Planned days and per-day capacity of a stored plan.
const planDayGrid = ({ plan, process, shift, holidayKeys = new Set() }) => {
  const draft = draftFromStored(plan);
  const custom = plan?.scheduleMode === "custom";
  const endDate = parsePlanDate(plan?.estimatedEndDate) || parsePlanDate(plan?.plannedEndDate);
  const expanded = expandPlanToDays({
    draft,
    endDate,
    shift,
    holidayKeys,
    commonStages: process?.commonStages || [],
    daySchedule: custom ? draft.daySchedule : null,
  });
  if (!expanded.ok) return { ok: false, days: [], dayPlan: { perDay: [], forecast: {}, problems: [] }, problems: expanded.problems };
  const dayPlan = computeDayPlan({
    days: expanded.days,
    processStages: process?.stages || [],
    shift,
    quantity: process?.quantity,
    overtimeWindows: plan?.overtimeWindows,
    downTime: plan?.downTime,
  });
  return { ok: true, days: expanded.days, dayPlan, problems: [...expanded.problems, ...dayPlan.problems] };
};

const num = (n, places = 1) => {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
};

// Ahead / on track / behind, from output through yesterday against the plan through yesterday.
const progressOf = ({ days, todayKey, processStatus, quantity, finishedTotal }) => {
  if (processStatus === "completed") return { state: "completed", label: "Completed", detail: `${num(finishedTotal, 0)} finished.` };
  if (days.length === 0) return { state: "unknown", label: "No schedule", detail: "This plan has no scheduled days to compare with." };
  if (todayKey < days[0].dayKey) return { state: "not_started", label: "Not started", detail: `Starts ${days[0].dayKey}.` };
  const through = days.filter((d) => d.dayKey < todayKey);
  const plannedThrough = through.reduce((s, d) => s + d.plannedUnits, 0);
  const finishedThrough = through.reduce((s, d) => s + d.finished, 0);
  if (plannedThrough <= 0) return { state: "on_track", label: "On schedule", detail: "The first full day has not finished yet." };
  const ratio = finishedThrough / plannedThrough;
  const gap = Math.round(finishedThrough - plannedThrough);
  if (ratio >= 1.05) return { state: "ahead", label: "Ahead of plan", detail: `${Math.abs(gap)} units ahead of the plan through yesterday.` };
  if (ratio >= 0.8) return { state: "on_track", label: "On track", detail: gap >= 0 ? "At or above the plan through yesterday." : `${Math.abs(gap)} units under the plan through yesterday, within the usual build-up.` };
  return { state: "behind", label: "Behind plan", detail: `${Math.abs(gap)} units behind the plan through yesterday (${num(quantity, 0)} to make).` };
};

const seatCounts = (stages) => {
  const out = {};
  Object.entries(stages || {}).forEach(([key, entries]) => {
    const first = toList(entries).find((e) => e && !e.reserved);
    if (first) out[key] = { passed: Number(first.passedDevice) || 0, failed: Number(first.ngDevice) || 0 };
  });
  return out;
};

// ---- one plan ------------------------------------------------------------------------------

const buildOverview = ({ plan, process, room, shift, existingShiftName = "", holidayKeys, actuals, todayKey, footprint = null, history = [] }) => {
  const grid = planDayGrid({ plan, process, shift, holidayKeys });
  const act = actuals || emptyPlan();
  const quantity = Number(process?.quantity) || 0;

  let cumulativePlanned = 0;
  let cumulativeFinished = 0;
  const scheduled = new Set(grid.days.map((d) => d.dayKey));
  const days = grid.days.map((d, i) => {
    const p = grid.dayPlan.perDay[i] || {};
    const a = act.byDay.get(d.dayKey) || { finished: 0, passedAny: 0, failed: 0 };
    cumulativePlanned += p.plannedUnits || 0;
    cumulativeFinished += a.finished;
    return {
      dayKey: d.dayKey,
      startTime: d.window.startTime,
      endTime: d.window.endTime,
      productiveMinutes: d.productiveMinutes ?? p.capacityMinutes ?? 0,
      setupDay: !!p.setupDay,
      capacityUnits: num(p.capacityUnits, 0),
      plannedUnits: num(p.plannedUnits, 0),
      cumulativePlanned: num(cumulativePlanned, 0),
      finished: a.finished,
      passedAny: a.passedAny,
      failed: a.failed,
      cumulativeFinished,
      state: d.dayKey < todayKey ? "past" : d.dayKey === todayKey ? "today" : "upcoming",
      note: d.note || "",
    };
  });

  // work done on days that were not scheduled (a plan that ran over, or worked a day off)
  const outside = Array.from(act.byDay.entries())
    .filter(([key]) => !scheduled.has(key))
    .map(([key, a]) => ({ dayKey: key, finished: a.finished, passedAny: a.passedAny, failed: a.failed }))
    .sort((x, y) => (x.dayKey < y.dayKey ? -1 : 1));

  const plannedTotal = days.reduce((s, d) => s + d.plannedUnits, 0);
  const finishedTotal = act.totals.finished;
  const stageCounts = {};
  Object.values(safeParse(plan?.assignedStages, {}) || {}).forEach((entries) => {
    const first = toList(entries).find((e) => e && !e.reserved);
    if (first) stageCounts[normName(first.name || first.stageName)] = (stageCounts[normName(first.name || first.stageName)] || 0) + 1;
  });
  const stages = (process?.stages || []).map((s) => {
    const stat = act.byStage.get(normName(s.stageName)) || { passed: 0, failed: 0 };
    return { name: s.stageName, upha: Number(s.upha) || 0, seats: stageCounts[normName(s.stageName)] || 0, passed: stat.passed, failed: stat.failed };
  });

  const stagesMap = safeParse(plan?.assignedStages, {}) || {};
  return {
    plan: {
      id: String(plan?._id || ""),
      name: plan?.processName || process?.name || "",
      isDrafted: Number(plan?.isDrafted) === 1,
      mode: plan?.scheduleMode === "custom" ? "custom" : "shift",
      startKey: plan?.startDate ? dayKeyLocal(parsePlanDate(plan.startDate)) : "",
      endKey: plan?.estimatedEndDate ? dayKeyLocal(parsePlanDate(plan.estimatedEndDate)) : "",
      roomId: String(plan?.selectedRoom || ""),
      roomName: room?.floorName || "",
      shiftName: plan?.scheduleMode === "custom" ? (shift?.name ? `Custom schedule (template: ${shift.name})` : "Custom schedule") : existingShiftName || shift?.name || "",
      hours: { startTime: plan?.ProcessShiftMappings?.startTime || "", endTime: plan?.ProcessShiftMappings?.endTime || "" },
    },
    process: { id: String(process?._id || ""), name: process?.name || "", status: process?.status || "", quantity, lastStage: lastStageName(process) },
    room: room ? { id: String(room._id), floorName: room.floorName, lines: (room.lines || []).map((l) => ({ rowName: l.rowName || "", seats: (l.seats || []).map((s) => ({ seatNumber: s.seatNumber })) })) } : null,
    seats: { stages: stagesMap, operators: safeParse(plan?.assignedOperators, {}) || {}, jigs: safeParse(plan?.assignedJigs, {}) || {}, counters: seatCounts(stagesMap) },
    days,
    outside,
    stages,
    totals: {
      quantity,
      planned: num(plannedTotal, 0),
      finished: finishedTotal,
      passedAny: act.totals.passedAny,
      failed: act.totals.failed,
      remaining: Math.max(0, num(quantity - finishedTotal, 0)),
      firstActivityKey: act.firstKey || null,
      lastActivityKey: act.lastKey || null,
    },
    progress: progressOf({ days, todayKey, processStatus: process?.status, quantity, finishedTotal }),
    problems: grid.problems.filter((p) => ["DAY-002", "DAY-003", "DAY-008", "SCH-001", "SCH-003", "CAL-004", "SHIFT-002"].includes(p.code)),
    footprint,
    history,
    todayKey,
  };
};

// ---- many plans across days (the board) --------------------------------------------------------

// One row of the board: the plan's working days inside [fromKey, toKey], with planned and actual output.
const buildBoardPlan = ({ plan, process, shift, holidayKeys, actuals, fromKey, toKey, todayKey }) => {
  const grid = planDayGrid({ plan, process, shift, holidayKeys });
  const act = actuals || emptyPlan();
  const days = [];
  grid.days.forEach((d, i) => {
    if (d.dayKey < fromKey || d.dayKey > toKey) return;
    const p = grid.dayPlan.perDay[i] || {};
    const a = act.byDay.get(d.dayKey) || { finished: 0, passedAny: 0, failed: 0 };
    days.push({
      dayKey: d.dayKey,
      startTime: d.window.startTime,
      endTime: d.window.endTime,
      plannedUnits: num(p.plannedUnits, 0),
      finished: a.finished,
      passedAny: a.passedAny,
      failed: a.failed,
      setupDay: !!p.setupDay,
    });
  });
  const seatKeys = Object.entries(safeParse(plan?.assignedStages, {}) || {})
    .filter(([, entries]) => toList(entries).some((e) => e && !e.reserved))
    .map(([key]) => key);
  return {
    planId: String(plan?._id || ""),
    name: plan?.processName || process?.name || "",
    processStatus: process?.status || "",
    isDrafted: Number(plan?.isDrafted) === 1,
    mode: plan?.scheduleMode === "custom" ? "custom" : "shift",
    roomId: String(plan?.selectedRoom || ""),
    startKey: plan?.startDate ? dayKeyLocal(parsePlanDate(plan.startDate)) : "",
    endKey: plan?.estimatedEndDate ? dayKeyLocal(parsePlanDate(plan.estimatedEndDate)) : "",
    seatKeys,
    days,
    scheduled: grid.ok,
    // activity on days in the window that the plan did not schedule
    extraDays: Array.from(act.byDay.entries())
      .filter(([key]) => key >= fromKey && key <= toKey && !days.some((d) => d.dayKey === key))
      .map(([key, a]) => ({ dayKey: key, finished: a.finished, passedAny: a.passedAny, failed: a.failed })),
    today: todayKey,
  };
};

module.exports = { buildOverview, buildBoardPlan, planDayGrid, draftFromStored, progressOf, lastStageName };
