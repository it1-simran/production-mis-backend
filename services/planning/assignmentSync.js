// Keeps assignOperatorToPlan / assignJigPlan rows in step with a v2 plan.
//
// Same row keys and shapes as the legacy syncAssignments in planningAndSchedulingController.js
// ({processId,userId} and {processId,jigId}), so the operator task pages, Operator Assignment page
// and legacy planner all keep reading them. Differences from the legacy function:
//   - it reports failure instead of swallowing it,
//   - it also frees jigs that were removed from the plan (the legacy one left them Occupied),
//   - it is never called for drafts (the controller guards that).

const mongoose = require("mongoose");
const AssignOperatorModel = require("../../models/assignOperatorToPlan");
const AssignJigModel = require("../../models/assignJigToPlan");
const { safeParse, toList, idOf, seatKeyParts } = require("./draft");

const toObjectId = (id) => (id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null);

// Ids of every operator / jig referenced by a stored plan (blobs are JSON strings or objects).
const operatorIdsOfPlan = (plan) => {
  const ids = new Set();
  const seats = safeParse(plan?.assignedOperators, {}) || {};
  Object.values(seats).forEach((slot) => toList(slot).forEach((op) => idOf(op) && ids.add(idOf(op))));
  const custom = safeParse(plan?.assignedCustomStagesOp, []);
  (Array.isArray(custom) ? custom : Object.values(custom || {})).forEach((slot) => toList(slot).forEach((op) => idOf(op) && ids.add(idOf(op))));
  return [...ids].filter((id) => toObjectId(id));
};

const jigIdsOfPlan = (plan) => {
  const ids = new Set();
  Object.values(safeParse(plan?.assignedJigs, {}) || {}).forEach((slot) => toList(slot).forEach((j) => idOf(j) && ids.add(idOf(j))));
  return [...ids].filter((id) => toObjectId(id));
};

const syncPlanAssignments = async (plan, { previousOperatorIds = [], previousJigIds = [] } = {}) => {
  try {
    const processId = toObjectId(plan.selectedProcess);
    if (!processId) return { ok: false, error: "invalid process id" };
    const now = new Date();
    const common = {
      roomName: plan.selectedRoom,
      ProcessShiftMappings: plan.ProcessShiftMappings,
      startDate: plan.startDate,
      estimatedEndDate: plan.estimatedEndDate,
      status: "Occupied",
      updatedAt: now,
    };

    const activeOperators = new Set();
    const seatOperators = safeParse(plan.assignedOperators, {}) || {};
    for (const seatKey of Object.keys(seatOperators)) {
      const { row, seat } = seatKeyParts(seatKey);
      for (const op of toList(seatOperators[seatKey])) {
        const userId = toObjectId(idOf(op));
        if (!userId) continue;
        activeOperators.add(String(userId));
        await AssignOperatorModel.findOneAndUpdate(
          { processId, userId },
          { $set: { ...common, processId, userId, seatDetails: { rowNumber: String(row < 0 ? 0 : row), seatNumber: String(seat < 0 ? 0 : seat) } } },
          { upsert: true },
        );
      }
    }

    const customSlots = safeParse(plan.assignedCustomStagesOp, []);
    for (const slot of Array.isArray(customSlots) ? customSlots : Object.values(customSlots || {})) {
      for (const op of toList(slot)) {
        const userId = toObjectId(idOf(op));
        if (!userId) continue;
        activeOperators.add(String(userId));
        await AssignOperatorModel.findOneAndUpdate(
          { processId, userId },
          { $set: { ...common, processId, userId, seatDetails: {}, stageType: "common" } },
          { upsert: true },
        );
      }
    }

    const activeJigs = new Set();
    const seatJigs = safeParse(plan.assignedJigs, {}) || {};
    for (const seatKey of Object.keys(seatJigs)) {
      const { row, seat } = seatKeyParts(seatKey);
      for (const jig of toList(seatJigs[seatKey])) {
        const jigId = toObjectId(idOf(jig));
        if (!jigId) continue;
        activeJigs.add(String(jigId));
        await AssignJigModel.findOneAndUpdate(
          { processId, jigId },
          { $set: { ...common, processId, jigId, seatDetails: { rowNumber: String(row < 0 ? 0 : row), seatNumber: String(seat < 0 ? 0 : seat) } } },
          { upsert: true },
        );
      }
    }

    // Free what this plan used to hold but no longer does.
    const removedOperators = previousOperatorIds.map(String).filter((id) => !activeOperators.has(id)).map(toObjectId).filter(Boolean);
    if (removedOperators.length) {
      await AssignOperatorModel.deleteMany({ processId, userId: { $in: removedOperators } });
    }
    const removedJigs = previousJigIds.map(String).filter((id) => !activeJigs.has(id)).map(toObjectId).filter(Boolean);
    if (removedJigs.length) {
      await AssignJigModel.deleteMany({ processId, jigId: { $in: removedJigs } });
    }

    // Stale rows for this process that no longer belong to the plan. Same guard as the legacy
    // function: only when the plan still names someone, so rows made by the Operator Assignment
    // page for a plan with no operators are not wiped by an unrelated save.
    if (activeOperators.size > 0) {
      await AssignOperatorModel.deleteMany({ processId, userId: { $nin: [...activeOperators].map(toObjectId) } });
    }
    if (activeJigs.size > 0) {
      await AssignJigModel.deleteMany({ processId, jigId: { $nin: [...activeJigs].map(toObjectId) } });
    }
    return { ok: true, operators: activeOperators.size, jigs: activeJigs.size };
  } catch (error) {
    console.error("[planning-v2] syncPlanAssignments failed:", error);
    return { ok: false, error: error.message };
  }
};

module.exports = { syncPlanAssignments, operatorIdsOfPlan, jigIdsOfPlan, toObjectId };
