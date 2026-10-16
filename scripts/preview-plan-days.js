/* eslint-disable no-console */
// READ-ONLY. Expands every stored, published plan into day-wise rows IN MEMORY (Phase 2, slice 1)
// and reports what the day generator and the per-day capacity maths make of real data. Writes
// nothing, creates nothing, so it is safe against any environment.
//
// What it answers before any day-wise code is switched on:
//   - which stored plans can be expanded, and which cannot (no end date, defective shift ...);
//   - how many day rows the live plans would produce;
//   - whether the day-by-day forecast agrees with the end date each plan was saved with.
//
// Usage:
//   node scripts/preview-plan-days.js                         (uses .env.development unless NODE_ENV is set)
//   NODE_ENV=production node scripts/preview-plan-days.js     (uses .env.production)
//   node scripts/preview-plan-days.js --plan <id>             (one plan, with its day table)
//   node scripts/preview-plan-days.js --start-day-produces    (decision D1: the start day always produces)
//   node scripts/preview-plan-days.js --start-day-setup       (decision D1: the start day is always a set-up day)
//   node scripts/preview-plan-days.js --out report.json
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
const hasFlag = (name) => process.argv.includes(name);

const main = async () => {
  loadEnv();
  const connectDB = require("../config/db");
  await connectDB();
  console.log(`Database: ${mongoose.connection.name}\n`);

  const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
  const ProcessModel = require("../models/process");
  const ShiftModel = require("../models/shiftManagement");
  const HolidayModel = require("../models/holidayModel");
  const { normalizeDraft } = require("../services/planning/draft");
  const { toProcessView, PROCESS_SELECT } = require("../services/planning/planLoader");
  const { expandPlanToDays } = require("../services/planning/dayGenerator");
  const { computeDayPlan } = require("../services/planning/dayCapacity");
  const { computeAllocationHash } = require("../services/planning/allocationHash");
  const { buildHolidayKeys, parsePlanDate, dayKeyLocal } = require("../utils/planDates");

  const onlyPlan = argValue("--plan");
  const startDayProduces = hasFlag("--start-day-produces") ? true : hasFlag("--start-day-setup") ? false : "auto";
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
  console.log(`${plans.length} published plans, ${live.length} considered (process not completed).`);
  const policyText =
    startDayProduces === true
      ? "always produces"
      : startDayProduces === false
        ? "always a set-up day"
        : "a set-up day, except in a one-day plan (default, decision D1)";
  console.log(`Start day: ${policyText}.\n`);

  const problemCounts = new Map();
  const rowsReport = [];
  let expandable = 0;
  let totalDays = 0;
  let totalRows = 0;
  let agree = 0;
  let differ = 0;
  let noForecast = 0;

  for (const plan of live) {
    const proc = processById.get(String(plan.selectedProcess));
    const shift = shiftById.get(String(plan.selectedShift));
    const draft = normalizeDraft(
      {
        selectedProcess: String(plan.selectedProcess),
        selectedRoom: String(plan.selectedRoom || ""),
        selectedShift: String(plan.selectedShift || ""),
        processName: plan.processName,
        startDate: plan.startDate,
        repeatCount: plan.repeatCount,
        isDrafted: 0,
        assignedStages: plan.assignedStages,
        assignedOperators: plan.assignedOperators,
        assignedJigs: plan.assignedJigs,
        assignedCustomStagesOp: plan.assignedCustomStagesOp,
        ProcessShiftMappings: plan.ProcessShiftMappings,
      },
      { planId: String(plan._id) },
    );
    const endDate = parsePlanDate(plan.estimatedEndDate);
    const expanded = expandPlanToDays({ draft, endDate, shift, holidayKeys, commonStages: proc?.commonStages || [] });
    const entry = { planId: String(plan._id), process: proc?.name || plan.processName, ok: expanded.ok, problems: expanded.problems.map((p) => p.code) };

    if (expanded.ok) {
      expandable += 1;
      const rows = expanded.days.reduce((n, d) => n + d.rows.length, 0);
      totalDays += expanded.days.length;
      totalRows += rows;
      const capacity = computeDayPlan({
        days: expanded.days,
        processStages: proc?.stages || [],
        shift,
        quantity: proc?.quantity,
        startDayProduces,
        overtimeWindows: plan.overtimeWindows,
        downTime: plan.downTime,
      });
      const storedEndKey = dayKeyLocal(endDate);
      const forecastKey = capacity.forecast.forecastEndKey;
      if (!forecastKey) noForecast += 1;
      else if (forecastKey === storedEndKey) agree += 1;
      else differ += 1;
      const hash = computeAllocationHash({
        draft,
        calendar: { startKey: expanded.calendar.startKey, endKey: expanded.calendar.endKey, window: expanded.calendar.window, weekDays: shift?.weekDays, holidayKeys },
      });
      Object.assign(entry, {
        days: expanded.days.length,
        rows,
        storedEnd: storedEndKey,
        forecastEnd: forecastKey,
        shortfallUnits: capacity.forecast.shortfallUnits,
        hash: hash.combined,
      });
      capacity.problems.forEach((p) => entry.problems.push(p.code));
      if (onlyPlan) {
        console.log("Day | seats | capacity units | planned | cumulative | note");
        capacity.perDay.forEach((d) =>
          console.log(`${d.dayKey} | ${String(d.seatCount).padStart(2)} | ${String(d.capacityUnits).padStart(8)} | ${String(d.plannedUnits).padStart(7)} | ${String(d.cumulativeUnits).padStart(10)} | ${d.setupDay ? "set-up day" : d.stalled ? "STALLED" : ""}`),
        );
        console.log("");
      }
    }
    entry.problems.forEach((code) => problemCounts.set(code, (problemCounts.get(code) || 0) + 1));
    rowsReport.push(entry);
    if (!expanded.ok || entry.problems.some((c) => c !== "DAY-007")) {
      console.log(`- ${entry.process}: ${expanded.ok ? `${entry.days} days, ${entry.rows} rows` : "NOT expandable"}  [${[...new Set(entry.problems)].join(", ")}]`);
    }
  }

  console.log(`\nExpandable: ${expandable} of ${live.length} plans, ${totalDays} days, ${totalRows} rows in total.`);
  console.log(`Forecast end vs saved end date: ${agree} agree, ${differ} differ, ${noForecast} have no forecast (nothing placed, or a stage unseated).`);
  console.log("\nNotes and problems by code:");
  [...problemCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([code, n]) => console.log(`  ${code.padEnd(10)} ${n}`));

  const out = argValue("--out");
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ database: mongoose.connection.name, generatedAt: new Date().toISOString(), startDayProduces, plans: rowsReport }, null, 2));
    console.log(`\nFull report written to ${out}`);
  }
  await mongoose.disconnect();
};

main().catch((error) => {
  console.error("Preview failed:", error);
  process.exit(1);
});
