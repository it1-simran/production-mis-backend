/* eslint-disable no-console */
// READ-ONLY audit: runs the v2 plan validator over every stored, non-draft plan whose process is
// not completed, and reports what it finds. Writes nothing. Safe to point at any environment.
//
// Its purpose: before any rule is switched to `enforce` (PLAN_ENFORCED_CODES), and before Phase 2
// adds unique indexes, you need to know how many real conflicts already exist in live data.
//
// Usage:
//   node scripts/validate-existing-plans.js                          (uses .env.development unless NODE_ENV is set)
//   NODE_ENV=production node scripts/validate-existing-plans.js      (uses .env.production)
//   node scripts/validate-existing-plans.js --out report.json        (full issue list as JSON)
//   node scripts/validate-existing-plans.js --code SEAT-001          (only show issues with this code)
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
  const connectDB = require("../config/db");
  await connectDB();
  console.log(`Database: ${mongoose.connection.name}\n`);

  const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
  const ProcessModel = require("../models/process");
  const { normalizeDraft } = require("../services/planning/draft");
  const { buildContext } = require("../services/planning/planLoader");
  const { validatePlan } = require("../services/planning/planValidator");
  const { summarizePlan } = require("../services/planning/planSummary");

  const plans = await PlaningAndSchedulingModel.find({ isDrafted: 0 }).lean();
  const processes = await ProcessModel.find({ _id: { $in: plans.map((p) => p.selectedProcess) } }).select("name status").lean();
  const processById = new Map(processes.map((p) => [String(p._id), p]));
  const live = plans.filter((p) => processById.get(String(p.selectedProcess)) && processById.get(String(p.selectedProcess)).status !== "completed");
  console.log(`${plans.length} published plans, ${live.length} on processes that are not completed.\n`);

  const only = argValue("--code");
  const byCode = new Map();
  const report = [];
  let planCountWithErrors = 0;

  for (const plan of live) {
    const proc = processById.get(String(plan.selectedProcess));
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
    try {
      // Judge the plan on the dates it was actually saved with (incl. active overtime), not on
      // dates recomputed from current capacity maths.
      const stored = summarizePlan(plan);
      const rangeOverride = stored.startKey ? { startKey: stored.startKey, endKey: stored.endKey } : null;
      const ctx = await buildContext(draft, { rangeOverride });
      const result = validatePlan(draft, ctx, { rangeOverride });
      if (result.summary.errors > 0) planCountWithErrors += 1;
      const issues = only ? result.issues.filter((i) => i.code === only) : result.issues;
      issues.forEach((i) => byCode.set(i.code, (byCode.get(i.code) || 0) + 1));
      if (issues.length) {
        report.push({ planId: String(plan._id), process: proc.name, processStatus: proc.status, summary: result.summary, issues });
      }
    } catch (error) {
      console.error(`Could not validate plan ${plan._id}: ${error.message}`);
    }
  }

  console.log("Issues by code:");
  [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([code, n]) => console.log(`  ${code.padEnd(11)} ${n}`));
  console.log(`\nPlans with at least one error: ${planCountWithErrors} of ${live.length}\n`);

  report
    .filter((r) => r.summary.errors > 0)
    .slice(0, 25)
    .forEach((r) => {
      console.log(`- ${r.process} [${r.processStatus}]  errors=${r.summary.errors} warnings=${r.summary.warnings}`);
      r.issues
        .filter((i) => i.severity === "error")
        .slice(0, 4)
        .forEach((i) => console.log(`    ${i.code}: ${i.message}`));
    });

  const out = argValue("--out");
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ database: mongoose.connection.name, generatedAt: new Date().toISOString(), plans: report }, null, 2));
    console.log(`\nFull report written to ${out}`);
  }
  await mongoose.disconnect();
};

main().catch((error) => {
  console.error("Audit failed:", error);
  process.exit(1);
});
