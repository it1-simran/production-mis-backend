// Taking an operator over from another process.
//
// An operator who is on another process's plan is "busy". A planner may still choose them for this plan; saving then MOVES them: they are
// removed from the other process's plan(s) (the seat and common-stage lists stored in the plan) and their assignment row for that process
// is deleted, so they appear only here. The planner has to ask for it explicitly (draft.takeOverOperatorIds); the server re-checks that
// each one really is on another live process and only ever touches the operators it was asked about.
//
//   describeTakeover({ processId, operatorIds })               read only: who is where (for the review screen)
//   takeOverOperators({ processId, operatorIds, writeLog })    does it, returns what moved

const mongoose = require("mongoose");
const { safeParse, toList, idOf } = require("./draft");

const toObjectIds = (ids) => (ids || []).map(String).filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));

// strip `ids` from a stored operator blob: { seatKey: [op...] } for seats, [[op...]] (or an object of lists) for common stages
const stripSeats = (raw, ids) => {
  const map = safeParse(raw, {}) || {};
  let changed = false;
  const out = {};
  Object.entries(map).forEach(([key, slot]) => {
    const list = toList(slot);
    const kept = list.filter((op) => !ids.has(idOf(op)));
    if (kept.length !== list.length) changed = true;
    out[key] = kept;
  });
  return { value: out, changed };
};
const stripCommon = (raw, ids) => {
  const slots = safeParse(raw, []);
  const asArray = Array.isArray(slots) ? slots : Object.values(slots || {});
  let changed = false;
  const out = asArray.map((slot) => {
    if (!Array.isArray(slot) && !(slot && slot._id)) return slot; // not an operator list (an old stage-stat object): leave as it was
    const list = toList(slot);
    const kept = list.filter((op) => !ids.has(idOf(op)));
    if (kept.length !== list.length) changed = true;
    return kept;
  });
  return { value: out, changed };
};

// Where each of these operators is currently placed on OTHER processes: rows that say Occupied, and plans that list them.
const findPlacements = async ({ processId, operatorIds }) => {
  const AssignOperatorModel = require("../../models/assignOperatorToPlan");
  const ProcessModel = require("../../models/process");
  const PlanModel = require("../../models/planingAndSchedulingModel");
  const ids = toObjectIds(operatorIds);
  const placements = new Map(); // operatorId -> Map(processId -> { processName, planIds:Set })
  if (!ids.length) return placements;
  const mine = mongoose.Types.ObjectId.isValid(String(processId)) ? new mongoose.Types.ObjectId(String(processId)) : null;
  const idSet = new Set(ids.map(String));

  const [rows, plans] = await Promise.all([
    AssignOperatorModel.find({ userId: { $in: ids }, status: "Occupied", ...(mine ? { processId: { $ne: mine } } : {}) }).select("userId processId").limit(5000).lean(),
    PlanModel.find({ ...(mine ? { selectedProcess: { $ne: mine } } : {}), $or: [{ assignedOperators: { $regex: [...idSet].join("|") } }, { assignedCustomStagesOp: { $regex: [...idSet].join("|") } }] })
      .select("selectedProcess assignedOperators assignedCustomStagesOp")
      .limit(2000)
      .lean(),
  ]);

  const processIds = [...new Set([...rows.map((r) => String(r.processId)), ...plans.map((p) => String(p.selectedProcess))])];
  const processes = processIds.length ? await ProcessModel.find({ _id: { $in: processIds } }).select("name status").lean() : [];
  const live = new Map(processes.filter((p) => p.status !== "completed").map((p) => [String(p._id), p.name || ""]));

  const add = (opId, procId, planId) => {
    if (!live.has(procId)) return; // a finished or deleted process is not a live claim
    const byProc = placements.get(opId) || new Map();
    const entry = byProc.get(procId) || { processName: live.get(procId), planIds: new Set() };
    if (planId) entry.planIds.add(planId);
    byProc.set(procId, entry);
    placements.set(opId, byProc);
  };
  rows.forEach((r) => add(String(r.userId), String(r.processId), null));
  plans.forEach((plan) => {
    const found = new Set();
    Object.values(safeParse(plan.assignedOperators, {}) || {}).forEach((slot) => toList(slot).forEach((op) => idSet.has(idOf(op)) && found.add(idOf(op))));
    const common = safeParse(plan.assignedCustomStagesOp, []);
    (Array.isArray(common) ? common : Object.values(common || {})).forEach((slot) => toList(slot).forEach((op) => idSet.has(idOf(op)) && found.add(idOf(op))));
    found.forEach((opId) => add(opId, String(plan.selectedProcess), String(plan._id)));
  });
  return placements;
};

const describeTakeover = async ({ processId, operatorIds }) => {
  const UserModel = require("../../models/User");
  const placements = await findPlacements({ processId, operatorIds });
  if (placements.size === 0) return [];
  const users = await UserModel.find({ _id: { $in: toObjectIds([...placements.keys()]) } }).select("name employeeCode").lean();
  const nameOf = new Map(users.map((u) => [String(u._id), u.name || ""]));
  return Array.from(placements.entries()).map(([operatorId, byProc]) => ({
    operatorId,
    name: nameOf.get(operatorId) || "",
    from: Array.from(byProc.entries()).map(([procId, e]) => ({ processId: procId, processName: e.processName })),
  }));
};

const takeOverOperators = async ({ processId, operatorIds, writeLog = async () => {}, userId = null, userName = "user", toProcessName = "" }) => {
  const AssignOperatorModel = require("../../models/assignOperatorToPlan");
  const PlanModel = require("../../models/planingAndSchedulingModel");
  const placements = await findPlacements({ processId, operatorIds });
  const moved = [];
  if (placements.size === 0) return { moved };
  const UserModel = require("../../models/User");
  const users = await UserModel.find({ _id: { $in: toObjectIds([...placements.keys()]) } }).select("name").lean();
  const nameOf = new Map(users.map((u) => [String(u._id), u.name || ""]));

  for (const [operatorId, byProc] of placements) {
    for (const [fromProcessId, entry] of byProc) {
      const one = new Set([operatorId]);
      for (const planId of entry.planIds) {
        const plan = await PlanModel.findById(planId).select("assignedOperators assignedCustomStagesOp").lean();
        if (!plan) continue;
        const seats = stripSeats(plan.assignedOperators, one);
        const common = stripCommon(plan.assignedCustomStagesOp, one);
        const $set = {};
        if (seats.changed) $set.assignedOperators = JSON.stringify(seats.value);
        if (common.changed) $set.assignedCustomStagesOp = JSON.stringify(common.value);
        if (Object.keys($set).length) await PlanModel.updateOne({ _id: planId }, { $set });
      }
      await AssignOperatorModel.deleteMany({ userId: new mongoose.Types.ObjectId(operatorId), processId: new mongoose.Types.ObjectId(fromProcessId) });
      await writeLog("UNASSIGN", fromProcessId, userId, `${nameOf.get(operatorId) || "An operator"} was moved to ${toProcessName || "another process"} by ${userName}.`);
      moved.push({ operatorId, name: nameOf.get(operatorId) || "", fromProcessId, fromProcessName: entry.processName });
    }
  }
  return { moved };
};

module.exports = { describeTakeover, takeOverOperators, findPlacements, stripSeats, stripCommon };
