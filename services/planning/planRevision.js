// A fingerprint of everything a planner edits in a plan, so two people editing at once can be told apart. PURE.
//
// The edit page receives the fingerprint when it opens the plan and sends it back when it saves. If the plan
// changed in between, the fingerprints differ and the save is refused (409) instead of silently overwriting
// the other person's work.
//
// Production counters, names and profile details are NOT part of it: they change all the time while a plan
// runs, and none of them is something a planner edits.

const crypto = require("crypto");
const { templateHash } = require("./allocationHash");
const { storedView } = require("./planViews");

const digest = (value) => crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const planRevision = (plan) => {
  const v = storedView(plan);
  const schedule = v.daySchedule.map((d) => [d.dayKey, d.startTime, d.endTime, d.working, (d.breaks || []).map((b) => `${b.startTime}-${b.endTime}`), d.note]);
  return digest([
    Number(plan?.isDrafted) === 1 ? 1 : 0,
    v.mode,
    v.startKey,
    v.endKey,
    v.plannedEndKey,
    v.roomId,
    v.shiftId,
    v.hours,
    schedule,
    templateHash({ assignedStages: v.stages, assignedOperators: v.operators, assignedJigs: v.jigs, assignedCustomStagesOp: v.common }),
  ]);
};

module.exports = { planRevision };
