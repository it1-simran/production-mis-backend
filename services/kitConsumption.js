// Kit consumption: a device's kit counts as CONSUMED the first time the device is moved to PDI.
//
// Each device carries kitConsumedAt, set the first time it is counted, so a device is counted ONCE however many times it passes the
// trigger: a carton sent back after a PDI NG and shifted again, the old Keep in Store step, or the FG to Store test all call this, and
// only devices not yet counted add to the totals. The totals are bumped with $inc (atomic), never by saving a copy read earlier.
//
//   process.consumedKits   what the overview, the store pages and the WIP capacity rule use
//   plan.consumedKit       the plan's own figure (monitoring page)

const mongoose = require("mongoose");

const validIds = (ids) =>
  Array.from(new Set((ids || []).map((id) => String(id?._id || id || "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))).map((id) => new mongoose.Types.ObjectId(id));

/**
 * Count the devices that have not been counted yet.
 * @param {Array} o.deviceIds   devices that just reached the trigger
 * @param {*}     o.processId   the process whose consumedKits to raise (nothing is raised without one)
 * @param {*}     [o.planId]    the plan whose consumedKit to raise too; omit when the caller keeps its own copy of the plan
 * @param {boolean} [o.latestPlan] use the process's latest published plan (looked up while the devices are claimed, not after)
 * @returns {{ counted: number, devices: number }}  counted = devices counted just now
 */
const claimKitConsumption = async ({ deviceIds, processId, planId = null, latestPlan = false }) => {
  const ids = validIds(deviceIds);
  if (ids.length === 0) return { counted: 0, devices: 0 };
  const Device = require("../models/device");
  const ProcessModel = require("../models/process");
  const PlanModel = require("../models/planingAndSchedulingModel");

  // Claim: only devices without the marker match, so each device is claimed by exactly one caller. The stamp lets a failure below undo
  // exactly this claim.
  const stamp = new Date();
  const planLookup = latestPlan && !planId ? planForProcess(processId) : null; // runs while the devices are claimed
  const claimed = await Device.updateMany({ _id: { $in: ids }, kitConsumedAt: null }, { $set: { kitConsumedAt: stamp } });
  const counted = claimed.modifiedCount || 0;
  const resolvedPlanId = planId || (planLookup ? await planLookup.catch(() => null) : null);
  if (counted === 0) return { counted: 0, devices: ids.length };

  // the two totals are independent: raise them together. If either fails, put back whichever one did go up and release the claim, so
  // nothing is left half counted and the same devices count on the next try.
  const bumps = [
    processId && mongoose.Types.ObjectId.isValid(String(processId)) ? { model: ProcessModel, id: processId, field: "consumedKits" } : null,
    resolvedPlanId && mongoose.Types.ObjectId.isValid(String(resolvedPlanId)) ? { model: PlanModel, id: resolvedPlanId, field: "consumedKit" } : null,
  ].filter(Boolean);
  const settled = await Promise.allSettled(bumps.map((b) => b.model.updateOne({ _id: b.id }, { $inc: { [b.field]: counted } })));
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) {
    await Promise.allSettled(bumps.filter((_, i) => settled[i].status === "fulfilled").map((b) => b.model.updateOne({ _id: b.id }, { $inc: { [b.field]: -counted } })));
    await Device.updateMany({ _id: { $in: ids }, kitConsumedAt: stamp }, { $set: { kitConsumedAt: null } }).catch(() => {});
    throw failed.reason;
  }
  return { counted, devices: ids.length };
};

/** The plan a process's devices are counted against at PDI: its latest published plan (null if it has none). */
const planForProcess = async (processId) => {
  if (!processId || !mongoose.Types.ObjectId.isValid(String(processId))) return null;
  const PlanModel = require("../models/planingAndSchedulingModel");
  const plan = await PlanModel.findOne({ selectedProcess: processId, isDrafted: 0 }).sort({ createdAt: -1 }).select("_id").lean();
  return plan ? plan._id : null;
};

module.exports = { claimKitConsumption, planForProcess };
