/* eslint-disable no-console */
// One-off reconciliation for the rule "a kit is consumed when a device first reaches PDI" (services/kitConsumption.js).
//
// Before the rule, kits were counted when a carton was kept in store. Per process this script looks at where each device is now:
//   already counted under the old rule   at KEEP_IN_STORE, or reserved/dispatched   -> only MARKED (kitConsumedAt), the total is unchanged
//   should be counted under the new rule at PDI or FG to Store, not kept yet         -> marked AND added to process.consumedKits
//                                                                                       (and to its latest published plan's consumedKit)
// Devices at earlier stages are left alone: they are counted when they first reach PDI. Devices already marked are skipped, so it is
// safe to run twice. Nothing is written without --execute.
//
// Usage:
//   node scripts/backfill-kit-consumption.js                       (dry run, .env.development unless NODE_ENV is set)
//   node scripts/backfill-kit-consumption.js --process <id>        (one process)
//   node scripts/backfill-kit-consumption.js --execute
//   NODE_ENV=production node scripts/backfill-kit-consumption.js
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

const COUNTED_ALREADY = { $or: [{ currentStage: "KEEP_IN_STORE" }, { dispatchStatus: { $in: ["RESERVED", "DISPATCHED"] } }] };
const COUNT_NOW = { currentStage: { $in: ["PDI", "FG to Store", "FG_TO_STORE"] }, dispatchStatus: { $exists: false } };

const main = async () => {
  loadEnv();
  const execute = process.argv.includes("--execute");
  const only = argValue("--process");
  await require("../config/db")();
  console.log(`Database: ${mongoose.connection.name}   ${execute ? "EXECUTE: writing changes" : "(dry run: nothing is written)"}\n`);

  const Device = require("../models/device");
  const ProcessModel = require("../models/process");
  const PlanModel = require("../models/planingAndSchedulingModel");
  const { planForProcess } = require("../services/kitConsumption");

  const match = { kitConsumedAt: null, ...(only ? { processID: new mongoose.Types.ObjectId(only) } : {}) };
  const processIds = await Device.distinct("processID", { ...match, $or: [COUNTED_ALREADY, COUNT_NOW] });
  console.log(`${processIds.length} process(es) have devices to reconcile.\n`);

  const totals = { marked: 0, counted: 0 };
  for (const processId of processIds) {
    const proc = await ProcessModel.findById(processId).select("name processID consumedKits status").lean();
    const already = await Device.countDocuments({ ...match, processID: processId, ...COUNTED_ALREADY });
    const now = await Device.countDocuments({ ...match, processID: processId, ...COUNT_NOW });
    console.log(`${String(proc?.processID || proc?.name || processId).padEnd(24)} [${proc?.status || "-"}]  consumedKits ${proc?.consumedKits ?? 0}  ->  ${(proc?.consumedKits || 0) + now}   (${already} already counted just marked, ${now} added now)`);
    totals.marked += already + now;
    totals.counted += now;
    if (!execute) continue;

    const stamp = new Date();
    await Device.updateMany({ ...match, processID: processId, ...COUNTED_ALREADY }, { $set: { kitConsumedAt: stamp } });
    const claimed = await Device.updateMany({ ...match, processID: processId, ...COUNT_NOW }, { $set: { kitConsumedAt: stamp } });
    const added = claimed.modifiedCount || 0;
    if (added > 0) {
      await ProcessModel.updateOne({ _id: processId }, { $inc: { consumedKits: added } });
      const planId = await planForProcess(processId);
      if (planId) await PlanModel.updateOne({ _id: planId }, { $inc: { consumedKit: added } });
    }
  }

  console.log(`\n${totals.marked} device(s) ${execute ? "marked" : "to mark"}; ${totals.counted} ${execute ? "added to" : "to add to"} consumedKits.`);
  if (!execute) console.log("Dry run: re-run with --execute to apply.");
  await mongoose.disconnect();
  process.exit(0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
