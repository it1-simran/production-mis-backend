/* eslint-disable no-console */
// READ-ONLY. For every stage of every plan (stages with activity only), compares the stage drawer's figures with the live engine's
// stage row (the figures on the monitoring page and the Production tab):
//   pass, NG   must be EQUAL (both are "latest result per device at the stage")
//   WIP        the device list can show real devices only; what the engine adds on top (units counted from allocated kits that have
//              no device record yet) is reported as "unlisted". A list LONGER than the engine's WIP is a mismatch.
//
// Usage:
//   node scripts/check-stage-detail.js                         (uses .env.development unless NODE_ENV is set)
//   NODE_ENV=production node scripts/check-stage-detail.js
//   node scripts/check-stage-detail.js --plan <id>
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
  const { loadOperations } = require("../services/planning/planOperations");
  const { loadStageSummary, loadStageDevices } = require("../services/planning/planStageDetail");

  const onlyPlan = argValue("--plan");
  const plans = await PlaningAndSchedulingModel.find(onlyPlan ? { _id: onlyPlan } : {}).select("processName selectedProcess").lean();
  const seenProcess = new Set();
  const stats = { stages: 0, same: 0, differ: 0, wipListed: 0, wipUnlisted: 0, wipOver: 0 };

  for (const plan of plans) {
    // the figures are per process: one plan per process is enough
    const key = String(plan.selectedProcess);
    if (!onlyPlan && seenProcess.has(key)) continue;
    seenProcess.add(key);
    const id = String(plan._id);
    const ops = await loadOperations({ planId: id });
    if (!ops.ok) {
      console.log(`--  ${plan.processName}: not compared (${ops.status})`);
      continue;
    }
    console.log(`\n${String(plan.processName).slice(0, 60)}  [${ops.body.process.status}]`);
    for (const row of ops.body.stages) {
      if (!(row.tested + row.wip + row.pass + row.ng > 0)) continue;
      stats.stages += 1;
      const summary = await loadStageSummary({ planId: id, stage: row.name });
      if (!summary.ok) {
        stats.differ += 1;
        console.log(`!!  ${row.name}: summary ${summary.status} ${summary.message}`);
        continue;
      }
      const notes = [];
      if (summary.body.counts.pass !== row.pass) notes.push(`pass engine ${row.pass} / drawer ${summary.body.counts.pass}`);
      if (summary.body.counts.ng !== row.ng) notes.push(`NG engine ${row.ng} / drawer ${summary.body.counts.ng}`);
      let wipText = "";
      if (row.wip > 0) {
        const wip = await loadStageDevices({ planId: id, stage: row.name, bucket: "wip", pageSize: 1 });
        if (wip.ok) {
          stats.wipListed += wip.body.listed;
          stats.wipUnlisted += wip.body.unlisted || 0;
          wipText = `  WIP engine ${row.wip} = ${wip.body.listed} listed + ${wip.body.unlisted} unlisted`;
          if (wip.body.listed > row.wip) {
            stats.wipOver += 1;
            notes.push(`WIP list ${wip.body.listed} is longer than engine ${row.wip}`);
          }
        } else notes.push(`wip list ${wip.status} ${wip.message}`);
      }
      if (notes.length) stats.differ += 1;
      else stats.same += 1;
      console.log(`${notes.length ? "!!" : "ok"}  ${row.name.padEnd(28)} pass ${String(row.pass).padStart(5)}  ng ${String(row.ng).padStart(4)}${wipText}${notes.length ? `\n      ${notes.join("\n      ")}` : ""}`);
    }
  }
  console.log(`\nstages checked ${stats.stages}: pass/NG equal and WIP list within the engine's figure on ${stats.same}, different on ${stats.differ}`);
  console.log(`WIP devices listed ${stats.wipListed}, WIP the engine adds without a device ${stats.wipUnlisted}`);
  await mongoose.disconnect();
  process.exit(stats.differ ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
