// Per-day capacity and forecast (Phase 2, slice 1). PURE.
//
//   computeDayPlan({ days, processStages, shift, quantity, ...options })
//     -> { perDay, forecast, problems }
//
// `days` is dayGenerator.expandPlanToDays().days. For each day the seats actually allocated THAT
// day decide the output, using the same maths as Phase 1 (capacity.computeCapacity): a stage's
// hourly output is UPHA x seats, the slowest stage limits the line, and units = line output x
// productive hours. The day's productive time can be extended by overtime and reduced by downtime.
// Units are then handed out day by day until the quantity is covered, which gives an exact
// forecast end date and an exact shortfall instead of a single multiplier.

const { computeCapacity } = require("./capacity");
const { parsePlanDate, dayKeyLocal } = require("../../utils/planDates");

const EPSILON = 1e-6;
const round = (n, places = 3) => {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
};

const problem = (code, severity, message, extra = {}) => ({ code, severity, message, ...extra });

// Local midnight of a day key plus `minutes` (may exceed 1440 for an overnight shift).
const atMinutes = (dayKey, minutes) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, minutes, 0, 0);
};

// Minutes of the plan's active overtime windows that start on this production day.
const overtimeMinutesFor = (dayKey, overtimeWindows) =>
  (Array.isArray(overtimeWindows) ? overtimeWindows : []).reduce((sum, w) => {
    if (!w || w.active === false) return sum;
    const from = parsePlanDate(w.from);
    const to = parsePlanDate(w.to);
    if (!from || !to || to <= from || dayKeyLocal(from) !== dayKey) return sum;
    return sum + (to.getTime() - from.getTime()) / 60000;
  }, 0);

// Minutes of downtime that fall inside this day's shift window.
const downtimeMinutesFor = (day, downTime) => {
  const from = parsePlanDate(downTime?.from);
  const to = parsePlanDate(downTime?.to);
  if (!from || !to || to <= from) return 0;
  const base = day.dayNumber * 1440;
  const winStart = atMinutes(day.dayKey, day.absStart - base);
  const winEnd = atMinutes(day.dayKey, day.absEnd - base);
  const overlap = Math.min(to.getTime(), winEnd.getTime()) - Math.max(from.getTime(), winStart.getTime());
  return overlap > 0 ? overlap / 60000 : 0;
};

const computeDayPlan = ({
  days = [],
  processStages = [],
  shift,
  quantity,
  startDayProduces = "auto",
  countUnstaffed = true,
  stallWhenStageUnseated = true,
  overtimeWindows = [],
  downTime = null,
} = {}) => {
  const problems = [];
  // Start-day policy (decision D1). The legacy end-date formula does not count the start day, and the
  // stored multi-day plans follow it, so by default the start day is a set-up day. But stored
  // single-day plans (end = start) can only mean the start day produces, so "auto" lets a plan that
  // has just one working day produce on it. true / false force one behaviour.
  // In a custom schedule the planner lists exactly the days that run, so every one of them produces.
  const allCustom = days.length > 0 && days.every((d) => d.custom);
  const startProduces = startDayProduces === true || (startDayProduces === "auto" && (days.length <= 1 || allCustom));
  const totalQuantity = Number(quantity) > 0 ? Number(quantity) : 0;
  let remaining = totalQuantity;
  let cumulative = 0;
  let lastProducingKey = null;

  const perDay = days.map((day) => {
    const activeSeats = (day.rows || []).filter(
      (r) => r.kind === "seat" && r.state !== "released" && r.state !== "conflict" && (countUnstaffed || (r.operatorIds || []).length > 0),
    );
    const assignedStages = {};
    activeSeats.forEach((r) => {
      assignedStages[r.seatKey] = [{ name: r.stage?.name }];
    });
    const capacity = computeCapacity({ processStages, assignedStages, shift, quantity: totalQuantity });

    const stalled = stallWhenStageUnseated && processStages.length > 0 && capacity.stagesWithoutSeats.length > 0;
    // A custom day carries its own productive minutes (its hours minus its breaks); a shift day uses the shift's.
    const baseMinutes = Number.isFinite(day.productiveMinutes) ? day.productiveMinutes : capacity.productiveMinutesPerDay;
    const capacityMinutes = Math.max(0, baseMinutes + overtimeMinutesFor(day.dayKey, overtimeWindows) - Math.min(baseMinutes, downtimeMinutesFor(day, downTime)));
    const uph = !stalled && capacity.bottleneck ? capacity.bottleneck.uph : 0;
    const capacityUnits = uph * (capacityMinutes / 60);

    const setupDay = day.isStartDay && !startProduces;
    const remainingBefore = remaining;
    const planned = setupDay || remaining <= EPSILON ? 0 : Math.min(capacityUnits, remaining);
    remaining = Math.max(0, remaining - planned);
    if (remaining < EPSILON) remaining = 0;
    cumulative += planned;
    if (planned > EPSILON) lastProducingKey = day.dayKey;

    const adjusted = (day.rows || []).some((r) => r.source === "adjusted");
    if (stalled && !setupDay && remainingBefore > EPSILON) {
      problems.push(
        problem(
          "DAY-003",
          adjusted ? "error" : "warning",
          `On ${day.dayKey} no seat runs ${capacity.stagesWithoutSeats.join(", ")}, so the line makes nothing that day.`,
          { dayKey: day.dayKey, stages: capacity.stagesWithoutSeats },
        ),
      );
    }
    if (setupDay) {
      problems.push(problem("DAY-007", "info", `${day.dayKey} is the start day: seats are held but no units are planned on it.`, { dayKey: day.dayKey }));
    }

    return {
      dayKey: day.dayKey,
      isStartDay: !!day.isStartDay,
      setupDay,
      seatCount: activeSeats.length,
      adjusted,
      stalled,
      capacityMinutes: round(capacityMinutes, 2),
      unitsPerHour: round(uph),
      capacityUnits: round(capacityUnits),
      plannedUnits: round(planned),
      cumulativeUnits: round(cumulative),
      remainingAfter: round(remaining),
      bottleneck: capacity.bottleneck,
      perStage: capacity.perStage,
    };
  });

  const shortfallUnits = round(remaining);
  if (totalQuantity > 0 && shortfallUnits > 0 && perDay.length > 0) {
    const last = perDay[perDay.length - 1].dayKey;
    problems.push(
      problem("DAY-002", "warning", `By ${last} the day-by-day plan makes ${round(cumulative, 0)} of ${round(totalQuantity, 0)} units, ${round(shortfallUnits, 0)} short.`, {
        dayKey: last,
        shortfallUnits,
      }),
    );
  }

  return {
    perDay,
    forecast: {
      quantity: totalQuantity,
      totalPlanned: round(cumulative),
      shortfallUnits,
      forecastEndKey: lastProducingKey,
      lastDayKey: perDay.length ? perDay[perDay.length - 1].dayKey : null,
      producingDays: perDay.filter((d) => d.plannedUnits > 0).length,
    },
    problems,
  };
};

module.exports = { computeDayPlan, overtimeMinutesFor, downtimeMinutesFor };
