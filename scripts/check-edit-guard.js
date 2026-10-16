/* eslint-disable no-console */
// READ-ONLY. Runs the edit guard over every stored, published plan as if it were saved again with NO changes.
// The guard's principle is that an unchanged plan is never flagged; this proves it on real data and also shows
// what has already happened on each plan (output, kits, open sessions), which is what the guard protects.
// Writes nothing.
//
// Usage:
//   node scripts/check-edit-guard.js                         (uses .env.development unless NODE_ENV is set)
//   NODE_ENV=production node scripts/check-edit-guard.js
//   node scripts/check-edit-guard.js --plan <id>
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
  const { normalizeDraft } = require("../services/planning/draft");
  const { buildContext } = require("../services/planning/planLoader");
  const { validatePlan } = require("../services/planning/planValidator");
  const { runEditGuard } = require("../services/planning/editSupport");
  const { summarizeFootprint } = require("../services/planning/planFootprint");

  const onlyPlan = argValue("--plan");
  const plans = await PlaningAndSchedulingModel.find({ isDrafted: 0, ...(onlyPlan ? { _id: onlyPlan } : {}) }).lean();
  const processes = await ProcessModel.find({ _id: { $in: plans.map((p) => p.selectedProcess) } }).select("name status").lean();
  const processById = new Map(processes.map((p) => [String(p._id), p]));

  let checked = 0;
  let flagged = 0;
  const byCode = new Map();
  const footprints = { started: 0, kits: 0, sessions: 0 };

  for (const plan of plans) {
    const proc = processById.get(String(plan.selectedProcess));
    if (!proc || (proc.status === "completed" && !onlyPlan)) continue;
    const draft = normalizeDraft(
      {
        selectedProcess: String(plan.selectedProcess),
        selectedRoom: String(plan.selectedRoom || ""),
        selectedShift: String(plan.selectedShift || ""),
        processName: plan.processName,
        startDate: plan.startDate,
        // the edit page keeps the stored end date unless the planner changes it, so a plan saved with no changes keeps its dates
        plannedEndDate: plan.plannedEndDate || plan.estimatedEndDate,
        repeatCount: plan.repeatCount,
        isDrafted: 0,
        scheduleMode: plan.scheduleMode,
        daySchedule: plan.daySchedule,
        scheduleDefaults: plan.scheduleDefaults,
        assignedStages: plan.assignedStages,
        assignedOperators: plan.assignedOperators,
        assignedJigs: plan.assignedJigs,
        assignedCustomStagesOp: plan.assignedCustomStagesOp,
        ProcessShiftMappings: plan.ProcessShiftMappings,
      },
      { planId: String(plan._id) },
    );
    try {
      const ctx = await buildContext(draft);
      const result = validatePlan(draft, ctx);
      const guard = await runEditGuard({ existing: plan, draft, ctx, result });
      checked += 1;
      const fp = summarizeFootprint(guard.footprint);
      if (fp.started) footprints.started += 1;
      if (fp.kitsAssigned) footprints.kits += 1;
      if (fp.openSessions > 0) footprints.sessions += 1;
      if (guard.issues.length) {
        flagged += 1;
        guard.issues.forEach((i) => byCode.set(i.code, (byCode.get(i.code) || 0) + 1));
        console.log(`- ${proc.name} [${proc.status}]`);
        guard.issues.forEach((i) => console.log(`    ${i.code} ${i.severity}: ${i.message}`));
      }
      if (onlyPlan) console.log("Footprint:", JSON.stringify(fp, null, 2));
    } catch (error) {
      console.error(`Could not check plan ${plan._id}: ${error.message}`);
    }
  }

  console.log(`\nChecked ${checked} plans (not completed). Started: ${footprints.started}, with kits: ${footprints.kits}, with open work sessions: ${footprints.sessions}.`);
  console.log(`Plans the guard flags when saved again with NO changes: ${flagged}`);
  [...byCode.entries()].sort((a, b) => b[1] - a[1]).forEach(([code, n]) => console.log(`  ${code}  ${n}`));
  await mongoose.disconnect();
};

main().catch((error) => {
  console.error("Check failed:", error);
  process.exit(1);
});
