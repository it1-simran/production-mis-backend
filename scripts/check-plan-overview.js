/* eslint-disable no-console */
// READ-ONLY. Builds the plan overview and a schedule-board row for every stored plan, the way the screens do,
// and reports anything that throws or looks wrong (negative totals, finished above the quantity, no schedule).
// Writes nothing.
//
// Usage:
//   node scripts/check-plan-overview.js                         (uses .env.development unless NODE_ENV is set)
//   NODE_ENV=production node scripts/check-plan-overview.js
//   node scripts/check-plan-overview.js --plan <id>
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
  const ShiftModel = require("../models/shiftManagement");
  const HolidayModel = require("../models/holidayModel");
  const loader = require("../services/planning/planLoader");
  const { loadActuals } = require("../services/planning/planActuals");
  const { buildOverview, buildBoardPlan, lastStageName } = require("../services/planning/planOverview");
  const { buildHolidayKeys, dayKeyLocal } = require("../utils/planDates");

  const onlyPlan = argValue("--plan");
  const plans = await PlaningAndSchedulingModel.find({ isDrafted: 0, ...(onlyPlan ? { _id: onlyPlan } : {}) }).lean();
  const holidayKeys = buildHolidayKeys(await HolidayModel.find({}, { holidayDate: 1 }).limit(2000).lean());
  const todayKey = dayKeyLocal(new Date());
  console.log(`${plans.length} published plan(s), today is ${todayKey}\n`);

  const stats = { ok: 0, threw: 0, noSchedule: 0, odd: 0, outside: 0 };
  const byProgress = {};
  for (const plan of plans) {
    const id = String(plan._id);
    try {
      const process = await loader.loadProcessView(plan.selectedProcess);
      const shift = mongoose.Types.ObjectId.isValid(String(plan.selectedShift)) ? await ShiftModel.findById(plan.selectedShift).lean() : null;
      const actuals = await loadActuals({ planIds: [id], lastStageByPlan: new Map([[id, lastStageName(process)]]) });
      const o = buildOverview({ plan, process, room: null, shift, holidayKeys, actuals: actuals.get(id), todayKey });
      const row = buildBoardPlan({ plan, process, shift, holidayKeys, actuals: actuals.get(id), fromKey: "0000-01-01", toKey: "9999-12-31", todayKey });
      const notes = [];
      if (o.days.length === 0) {
        stats.noSchedule += 1;
        notes.push("no scheduled days");
      }
      if (o.totals.remaining < 0 || o.totals.finished < 0 || o.days.some((d) => d.plannedUnits < 0)) notes.push("negative figure");
      if (o.totals.quantity > 0 && o.totals.finished > o.totals.quantity) notes.push(`finished ${o.totals.finished} is above the quantity ${o.totals.quantity}`);
      if (Math.abs(o.totals.planned - o.totals.quantity) > 1 && o.days.length) notes.push(`planned ${o.totals.planned} differs from quantity ${o.totals.quantity}`);
      if (row.days.length !== o.days.length) notes.push("board row and overview disagree on the days");
      if (o.outside.length) stats.outside += 1;
      byProgress[o.progress.state] = (byProgress[o.progress.state] || 0) + 1;
      stats.ok += 1;
      if (notes.length) stats.odd += 1;
      console.log(
        `${notes.length ? "??" : "ok"}  ${String(o.plan.name).slice(0, 34).padEnd(34)} ${o.plan.startKey}..${o.plan.endKey || "-"}  days ${String(o.days.length).padStart(2)}  planned ${String(o.totals.planned).padStart(6)}  finished ${String(o.totals.finished).padStart(6)}  ${o.progress.state.padEnd(11)}${o.outside.length ? `  (+${o.outside.length} day(s) outside the schedule)` : ""}${notes.length ? `  <- ${notes.join("; ")}` : ""}`
      );
    } catch (error) {
      stats.threw += 1;
      console.log(`!!  ${id} ${plan.processName}: ${error.message}`);
    }
  }
  console.log(`\nbuilt ${stats.ok}, threw ${stats.threw}, no schedule ${stats.noSchedule}, worth a look ${stats.odd}, with work outside the schedule ${stats.outside}`);
  console.log("progress:", byProgress);
  await mongoose.disconnect();
  process.exit(stats.threw ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
