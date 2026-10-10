// The plan's assignedCustomStagesOp holds TWO different things in one array, because two parts of the system grew to use it:
//   * operator lists, one per common stage BY POSITION (what the planner and the operator pages read), and
//   * stage counters { name, totalUPHA, passedDevice, ngDevice } that the device-test code pushes and updates BY STAGE NAME (findIndex on
//     the name, so they can sit at any position, and are added at the end when missing).
// A save from the planner writes the operator lists. It must not wipe the counters, and it must not let the array grow on every save.
//
//   mergeCommonSlots({ lists, commonCount, existingRaw })  -> the array to store: the lists first (positions kept), then the counters

const { safeParse, toList, idOf } = require("./draft");

// a counter object the device-test code keeps: has a name and counts, is not an operator and not an operator list
const isStageCounter = (slot) =>
  !!slot &&
  typeof slot === "object" &&
  !Array.isArray(slot) &&
  !idOf(slot) &&
  !Array.isArray(slot.operators) &&
  !!String(slot.name || slot.stageName || "").trim() &&
  ["totalUPHA", "passedDevice", "ngDevice"].some((k) => k in slot);

/**
 * @param {Array}  lists        the operator list for each common stage, from the planner (extra empty slots are dropped)
 * @param {number} commonCount  how many common stages the process has
 * @param {*}      existingRaw  the stored assignedCustomStagesOp (string or array) the counters are taken from; may be empty
 */
const mergeCommonSlots = ({ lists, commonCount, existingRaw }) => {
  const slots = Array.isArray(lists) ? lists : [];
  const kept = [];
  slots.forEach((slot, i) => {
    const list = toList(slot);
    // a slot past the common stages is only kept if someone is in it
    if (i < commonCount || list.length > 0) kept.push(list);
  });
  while (kept.length < commonCount) kept.push([]);

  const stored = safeParse(existingRaw, []);
  const counters = (Array.isArray(stored) ? stored : Object.values(stored || {})).filter(isStageCounter);
  return [...kept, ...counters];
};

module.exports = { mergeCommonSlots, isStageCounter };
