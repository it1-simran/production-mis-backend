// Staleness detection for day-wise rows (Phase 2, slice 1). PURE.
//
// Rows are generated from a plan's template and from the calendar (shift weekdays, shift window,
// holidays). If either changes after the rows were written, for example someone edits the plan on
// a legacy screen or a holiday is added, the rows no longer describe the plan. We store two small
// hashes when rows are generated and compare them on read: no extra writes, no background job.
//
// Production counters (passedDevice, ngDevice, totalUPHA ...) change constantly while a plan runs
// and are NOT part of the template hash, otherwise every finished device would make the plan stale.

const crypto = require("crypto");
const { toList, idOf, seatKeyParts } = require("./draft");

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const digest = (value) => crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const sortedIds = (slot) => Array.from(new Set(toList(slot).map(idOf).filter(Boolean))).sort();

const bySeatKey = (a, b) => {
  const pa = seatKeyParts(a);
  const pb = seatKeyParts(b);
  return pa.row - pb.row || pa.seat - pb.seat || String(a).localeCompare(String(b));
};

const stageFingerprint = (entry) => [
  String(entry?.name || entry?.stageName || ""),
  String(entry?.stageInstanceId || ""),
  String(entry?.parallelGroupKey || ""),
  String(entry?.requiredSkill || ""),
  String(entry?.managedBy || ""),
  String(entry?.upha ?? ""),
  !!entry?.hasJigStepType,
];

const templateHash = (draft) => {
  const stages = draft?.assignedStages || {};
  const operators = draft?.assignedOperators || {};
  const jigs = draft?.assignedJigs || {};
  const seatKeys = Object.keys({ ...stages, ...operators, ...jigs }).sort(bySeatKey);

  const seats = seatKeys
    .map((key) => [key, toList(stages[key]).filter((e) => e && !e.reserved).map(stageFingerprint), sortedIds(operators[key]), sortedIds(jigs[key])])
    .filter(([, stageList, ops, jigList]) => stageList.length || ops.length || jigList.length);

  const common = (draft?.assignedCustomStagesOp || []).map((slot) => sortedIds(slot));
  return digest({ seats, common });
};

// `calendar`: { startKey, endKey, window:{startTime,endTime}, weekDays, holidayKeys:Set|Array }
const calendarHash = (calendar) => {
  const holidays = Array.from(calendar?.holidayKeys || [])
    .filter((k) => (!calendar.startKey || k >= calendar.startKey) && (!calendar.endKey || k <= calendar.endKey))
    .sort();
  const weekDays = calendar?.weekDays ? DAY_NAMES.map((d) => !!calendar.weekDays[d]) : null;
  return digest({
    start: calendar?.startKey || "",
    end: calendar?.endKey || "",
    window: [String(calendar?.window?.startTime || ""), String(calendar?.window?.endTime || "")],
    weekDays,
    holidays,
  });
};

const computeAllocationHash = ({ draft, calendar }) => {
  const template = templateHash(draft);
  const cal = calendarHash(calendar);
  return { templateHash: template, calendarHash: cal, combined: digest([template, cal]) };
};

// stored: what was saved when the rows were generated; current: computeAllocationHash() of the plan as it is now.
const stalenessOf = (stored, current) => {
  if (!stored || (!stored.templateHash && !stored.combined)) return { stale: true, reason: "missing" };
  if (stored.templateHash !== current.templateHash) return { stale: true, reason: "template" };
  if (stored.calendarHash !== current.calendarHash) return { stale: true, reason: "calendar" };
  return { stale: false, reason: null };
};

module.exports = { templateHash, calendarHash, computeAllocationHash, stalenessOf };
