/* eslint-disable no-console */
// READ-ONLY. Proves the custom day-wise schedule reproduces today's shift maths.
//
// For every stored, published plan this converts the plan's shift into an equivalent custom
// schedule (same dates, same hours, the shift's breaks, the shift's weekly days off, the plant
// holidays), runs both through the day generator and the per-day capacity, and compares:
//   - the working days (must be identical);
//   - each day's productive minutes and output (must match when the planner changes nothing).
// Writes nothing, so it is safe against any environment.
//
// Where they differ it says why: a plan whose own hours differ from its shift's, or a shift whose
// intervals leave gaps (time inside the shift that is neither work nor a recorded break).
//
// Usage:
//   node scripts/preview-custom-schedule.js                    (uses .env.development unless NODE_ENV is set)
//   NODE_ENV=production node scripts/preview-custom-schedule.js
//   node scripts/preview-custom-schedule.js --plan <id>        (one plan, with its day table)
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const loadEnv = () => {
  const env = process.env.NODE_ENV || "development";
  const envPath = path.resolve(__dirname, "..", `.env.${env}`);
  const fallback = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
  else if (fs.existsSync(fallback)) dotenv.config({ path: fallback });
  console.log(`Environment: ${env}`);
};
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

const main = async () => {
  loadEnv();
  await require("../config/db")();
  console.log(`Database: ${mongoose.connection.name}\n`);

  const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
  const ProcessModel = require("../models/process");
  const ShiftModel = require("../models/shiftManagement");
  const HolidayModel = require("../models/holidayModel");
  const { normalizeDraft } = require("../services/planning/draft");
  const { toProcessView, PROCESS_SELECT } = require("../services/planning/planLoader");
  const { expandPlanToDays } = require("../services/planning/dayGenerator");
  const { computeDayPlan } = require("../services/planning/dayCapacity");
  const { templateFromShift, buildDaySchedule, normTime, validateDaySchedule } = require("../services/planning/daySchedule");
  const { getProductiveMinutes } = require("../services/planning/capacity");
  const { buildHolidayKeys, parsePlanDate, dayKeyLocal } = require("../utils/planDates");

  const onlyPlan = argValue("--plan");
  const plans = await PlaningAndSchedulingModel.find({ isDrafted: 0, ...(onlyPlan ? { _id: onlyPlan } : {}) }).lean();
  const [processDocs, shifts, holidays] = await Promise.all([
    ProcessModel.find({ _id: { $in: plans.map((p) => p.selectedProcess) } }).select(PROCESS_SELECT).lean(),
    ShiftModel.find({}).lean(),
    HolidayModel.find({}, { holidayDate: 1 }).limit(2000).lean(),
  ]);
  const processById = new Map(processDocs.map((p) => [String(p._id), toProcessView(p)]));
  const shiftById = new Map(shifts.map((s) => [String(s._id), s]));
  const holidayKeys = buildHolidayKeys(holidays);
  const live = plans.filter((p) => {
    const proc = processById.get(String(p.selectedProcess));
    return onlyPlan || (proc && proc.status !== "completed");
  });
  console.log(`${plans.length} published plans, ${live.length} considered.\n`);

  const tally = { same: 0, differ: 0, skipped: 0, daysDiffer: 0 };
  const schCounts = new Map();
  let compared = 0;

  for (const plan of live) {
    const proc = processById.get(String(plan.selectedProcess));
    const shift = shiftById.get(String(plan.selectedShift));
    const name = proc?.name || plan.processName;
    const endDate = parsePlanDate(plan.estimatedEndDate);
    const draft = normalizeDraft(
      {
        selectedProcess: String(plan.selectedProcess),
        selectedRoom: String(plan.selectedRoom || ""),
        selectedShift: String(plan.selectedShift || ""),
        startDate: plan.startDate,
        isDrafted: 0,
        assignedStages: plan.assignedStages,
        assignedOperators: plan.assignedOperators,
        assignedJigs: plan.assignedJigs,
        assignedCustomStagesOp: plan.assignedCustomStagesOp,
        ProcessShiftMappings: plan.ProcessShiftMappings,
      },
      { planId: String(plan._id) },
    );

    const shiftExpanded = expandPlanToDays({ draft, endDate, shift, holidayKeys, commonStages: proc?.commonStages || [] });
    if (!shiftExpanded.ok) {
      tally.skipped += 1;
      console.log(`- ${name}: skipped (shift-mode expansion failed: ${shiftExpanded.problems.map((p) => p.code).join(", ")})`);
      continue;
    }

    // the equivalent custom schedule: the plan's own hours (its override, else its shift's)
    const template = templateFromShift(shift);
    const override = draft.shiftOverride;
    const startTime = normTime(override?.startTime) || template.startTime;
    const endTime = normTime(override?.endTime) || template.endTime;
    const built = buildDaySchedule({
      startKey: dayKeyLocal(draft.startDate),
      endKey: dayKeyLocal(endDate),
      defaults: { ...template, startTime, endTime },
      holidayKeys,
    });
    const problems = validateDaySchedule({ days: built.days, startKey: dayKeyLocal(draft.startDate), endKey: dayKeyLocal(endDate), weekDays: shift.weekDays, holidayKeys, template });
    problems.forEach((p) => schCounts.set(p.code, (schCounts.get(p.code) || 0) + 1));

    const customExpanded = expandPlanToDays({ draft, endDate, shift, holidayKeys, commonStages: proc?.commonStages || [], daySchedule: built.days });
    if (!customExpanded.ok) {
      tally.skipped += 1;
      console.log(`- ${name}: skipped (custom expansion failed: ${customExpanded.problems.map((p) => p.code).join(", ")})`);
      continue;
    }

    compared += 1;
    const opts = { processStages: proc?.stages || [], shift, quantity: proc?.quantity };
    const a = computeDayPlan({ ...opts, days: shiftExpanded.days, startDayProduces: true });
    const b = computeDayPlan({ ...opts, days: customExpanded.days, startDayProduces: true });

    const sameDays = JSON.stringify(a.perDay.map((d) => d.dayKey)) === JSON.stringify(b.perDay.map((d) => d.dayKey));
    const sameMinutes = sameDays && a.perDay.every((d, i) => d.capacityMinutes === b.perDay[i].capacityMinutes);
    const sameUnits = sameDays && a.perDay.every((d, i) => d.capacityUnits === b.perDay[i].capacityUnits);
    if (!sameDays) tally.daysDiffer += 1;

    if (sameMinutes && sameUnits) {
      tally.same += 1;
    } else {
      tally.differ += 1;
      const why = [];
      if (override && (normTime(override.startTime) !== template.startTime || normTime(override.endTime) !== template.endTime)) why.push("the plan's own hours differ from its shift");
      if (getProductiveMinutes(shift) !== b.perDay[0]?.capacityMinutes) why.push(`shift productive time ${getProductiveMinutes(shift)} min vs custom ${b.perDay[0]?.capacityMinutes} min (shift intervals leave gaps or do not match its times)`);
      console.log(`- ${name}: DIFFERS${sameDays ? "" : " (different working days)"}  ${why.join("; ")}`);
    }

    if (onlyPlan) {
      console.log("Day | shift mode min | custom min | shift units | custom units");
      a.perDay.forEach((d, i) => console.log(`${d.dayKey} | ${String(d.capacityMinutes).padStart(8)} | ${String(b.perDay[i]?.capacityMinutes).padStart(8)} | ${String(d.capacityUnits).padStart(9)} | ${String(b.perDay[i]?.capacityUnits).padStart(9)}`));
    }
  }

  console.log(`\nCompared ${compared} plans: ${tally.same} identical, ${tally.differ} differ, ${tally.skipped} skipped.`);
  console.log(`Plans whose working days differ: ${tally.daysDiffer}.`);
  console.log("\nSchedule checks raised on the converted schedules:");
  if (schCounts.size === 0) console.log("  none");
  [...schCounts.entries()].sort((x, y) => y[1] - x[1]).forEach(([code, n]) => console.log(`  ${code.padEnd(8)} ${n}`));
  await mongoose.disconnect();
};

main().catch((error) => {
  console.error("Preview failed:", error);
  process.exit(1);
});
