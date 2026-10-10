// Capacity maths for the v2 planner. One implementation, used by the validator, the preview
// endpoint and create/update, so the numbers a planner sees are the numbers that get stored.
//
// Model: each stage's hourly output is (stage UPHA x seats running that stage). The slowest stage
// limits the line. Units per day = bottleneck output per hour x productive hours per day, where
// productive hours exclude break intervals. (`repeatCount` is already reflected in the seat
// counts, so it is not multiplied in again.)
//
// Note for reviewers: the legacy Add page rounds the break time to whole hours and the legacy Edit
// page ignores breaks, so v2 numbers can differ slightly from what those pages show.

const { toMinutes } = require("../../utils/planDates");

const normName = (value) => String(value || "").trim().toLowerCase();

// Sum of non-break interval minutes (overnight-aware). Falls back to start/end minus the shift's
// total break when the shift has no intervals.
const getProductiveMinutes = (shift) => {
  if (!shift) return 0;
  const span = (startText, endText) => {
    const start = toMinutes(startText);
    let end = toMinutes(endText);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
    if (end <= start) end += 1440;
    return end - start;
  };

  if (Array.isArray(shift.intervals) && shift.intervals.length > 0) {
    return shift.intervals.reduce((sum, interval) => {
      if (!interval || interval.breakTime) return sum;
      return sum + span(interval.startTime, interval.endTime);
    }, 0);
  }
  const totalBreak = Number(shift.totalBreakTime || 0) || 0;
  return Math.max(0, span(shift.startTime, shift.endTime) - totalBreak);
};

// Count seats per stage name from an assignedStages map (reserved entries ignored).
const countSeatsPerStage = (assignedStages) => {
  const counts = new Map();
  Object.values(assignedStages || {}).forEach((entries) => {
    const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
    list.forEach((entry) => {
      if (!entry || entry.reserved) return;
      const key = normName(entry.stageName || entry.name || entry.stage);
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  return counts;
};

const computeCapacity = ({ processStages, assignedStages, shift, quantity }) => {
  const productiveMinutesPerDay = getProductiveMinutes(shift);
  const productiveHoursPerDay = productiveMinutesPerDay / 60;
  const seatCounts = countSeatsPerStage(assignedStages);

  const perStage = (Array.isArray(processStages) ? processStages : []).map((stage) => {
    const name = String(stage?.stageName || stage?.name || "");
    const upha = Number(stage?.upha);
    const seats = seatCounts.get(normName(name)) || 0;
    return {
      name,
      upha: Number.isFinite(upha) ? upha : 0,
      seats,
      stageUph: Number.isFinite(upha) && upha > 0 ? upha * seats : 0,
    };
  });

  const stagesWithoutSeats = perStage.filter((s) => s.seats === 0).map((s) => s.name);
  const running = perStage.filter((s) => s.seats > 0 && s.upha > 0);

  let bottleneck = null;
  running.forEach((s) => {
    if (!bottleneck || s.stageUph < bottleneck.uph) bottleneck = { stage: s.name, uph: s.stageUph, upha: s.upha, seats: s.seats };
  });

  const unitsPerDay = bottleneck ? bottleneck.uph * productiveHoursPerDay : 0;
  const qty = Number(quantity);
  const daysNeeded = unitsPerDay > 0 && Number.isFinite(qty) && qty > 0 ? qty / unitsPerDay : 0;

  return {
    productiveMinutesPerDay,
    productiveHoursPerDay,
    perStage,
    stagesWithoutSeats,
    bottleneck,
    unitsPerDay,
    daysNeeded,
    quantity: Number.isFinite(qty) ? qty : 0,
  };
};

module.exports = { getProductiveMinutes, countSeatsPerStage, computeCapacity, normName };
