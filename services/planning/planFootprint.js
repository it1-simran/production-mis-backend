// What has already happened on a plan: the "activity footprint" the edit guards protect. Read-only.
//
//   buildFootprint(...)  PURE: turns raw rows into the structure editGuard.js reads.
//   loadFootprint(plan)  reads those rows (bounded, indexed queries) and calls buildFootprint.
//
// It is called when the edit page opens, when changes are reviewed and when they are saved. It is never
// called from an operator-facing path.

const { dayKeyLocal } = require("../../utils/planDates");
const { safeParse, toList } = require("./draft");
const { normName } = require("./capacity");

const GROUP_LIMIT = 2000; // seat/stage combinations; a plan has a few dozen
const ROW_LIMIT = 500;
const LIVE_PROCESS_STATUS = new Set(["active", "down_time_hold"]);

const buildFootprint = ({ processStatus = "", plan = null, outputRows = [], kitRows = [], sessions = [] } = {}) => {
  const outputBySeatStage = new Map();
  const stagesWithOutput = new Set();
  let firstActivityKey = "";
  let lastActivityKey = "";

  // Counters kept in the plan itself (passed + failed devices per seat and stage)
  const stages = safeParse(plan?.assignedStages, {}) || {};
  Object.entries(stages).forEach(([seatKey, entries]) => {
    toList(entries).forEach((entry) => {
      if (!entry || entry.reserved) return;
      const count = (Number(entry.passedDevice) || 0) + (Number(entry.ngDevice) || 0);
      if (count > 0) {
        const stage = normName(entry.name || entry.stageName);
        const key = `${seatKey}|${stage}`;
        outputBySeatStage.set(key, Math.max(outputBySeatStage.get(key) || 0, count));
        stagesWithOutput.add(stage);
      }
    });
  });

  // Device test records (seat key and stage name are stored on each)
  outputRows.forEach((row) => {
    const stage = normName(row?._id?.stage);
    const seat = String(row?._id?.seat || "").trim();
    const n = Number(row?.n) || 0;
    if (!stage || n <= 0) return;
    stagesWithOutput.add(stage);
    if (seat) {
      const key = `${seat}|${stage}`;
      outputBySeatStage.set(key, Math.max(outputBySeatStage.get(key) || 0, n));
    }
    const first = row.first ? dayKeyLocal(new Date(row.first)) : "";
    const last = row.last ? dayKeyLocal(new Date(row.last)) : "";
    if (first && (!firstActivityKey || first < firstActivityKey)) firstActivityKey = first;
    if (last && (!lastActivityKey || last > lastActivityKey)) lastActivityKey = last;
  });

  // Kits issued to seats (rejected rows are filtered out by the reader)
  const kitSeats = new Map();
  kitRows.forEach((row) => {
    toList(row?.seatDetails).forEach((seat) => {
      const issued = Number(seat?.issuedKits) || 0;
      if (issued <= 0) return;
      const key = `${seat.rowNumber}-${seat.seatNumber}`;
      const current = kitSeats.get(key) || { issued: 0, awaitingConfirmation: false };
      current.issued += issued;
      if (row.status === "ASSIGN_TO_OPERATOR") current.awaitingConfirmation = true;
      kitSeats.set(key, current);
    });
  });

  const openSessionOperatorIds = new Set(sessions.map((s) => String(s?.operatorId || "")).filter(Boolean));

  return {
    processStatus,
    outputBySeatStage,
    stagesWithOutput,
    kitSeats,
    kitsAssigned: kitRows.length > 0,
    openSessionOperatorIds,
    firstActivityKey,
    lastActivityKey,
    started: outputBySeatStage.size > 0 || stagesWithOutput.size > 0 || LIVE_PROCESS_STATUS.has(processStatus),
  };
};

// A small, serialisable summary for the edit page (Maps and Sets do not travel as JSON).
const summarizeFootprint = (footprint) => ({
  processStatus: footprint.processStatus,
  started: footprint.started,
  kitsAssigned: footprint.kitsAssigned,
  stagesWithOutput: Array.from(footprint.stagesWithOutput),
  seatsWithOutput: Array.from(new Set(Array.from(footprint.outputBySeatStage.keys()).map((k) => k.split("|")[0]))),
  seatsWithKits: Array.from(footprint.kitSeats.keys()),
  openSessions: footprint.openSessionOperatorIds.size,
  openSessionOperatorIds: Array.from(footprint.openSessionOperatorIds),
  firstActivityKey: footprint.firstActivityKey || null,
  lastActivityKey: footprint.lastActivityKey || null,
});

// ---- the database reader ----------------------------------------------------------------------------

const loadFootprint = async (plan) => {
  const mongoose = require("mongoose");
  const ProcessModel = require("../../models/process");
  const DeviceTest = require("../../models/deviceTestModel");
  const AssignKits = require("../../models/assignKitsToLine");
  const WorkSession = require("../../models/operatorWorkSession");

  if (!plan?._id || !plan?.selectedProcess) return buildFootprint({ plan });
  const planId = new mongoose.Types.ObjectId(String(plan._id));
  const processId = new mongoose.Types.ObjectId(String(plan.selectedProcess));
  const sessionMs = (Number(process.env.SESSION_MAX_HOURS) || 10) * 60 * 60 * 1000; // same lifetime the work-session code uses

  const [processDoc, outputRows, kitRows, sessions] = await Promise.all([
    ProcessModel.findById(processId).select("status").lean(),
    DeviceTest.aggregate([
      { $match: { planId } },
      { $group: { _id: { seat: "$seatNumber", stage: "$stageName" }, n: { $sum: 1 }, first: { $min: "$createdAt" }, last: { $max: "$createdAt" } } },
      { $limit: GROUP_LIMIT },
    ]),
    AssignKits.find({ planId, status: { $ne: "REJECT" } }).select("seatDetails status").limit(ROW_LIMIT).lean(),
    WorkSession.find({ processId, status: "active", startedAt: { $gte: new Date(Date.now() - sessionMs) } }).select("operatorId").limit(ROW_LIMIT).lean(),
  ]);

  return buildFootprint({ processStatus: processDoc?.status || "", plan, outputRows, kitRows, sessions });
};

module.exports = { buildFootprint, summarizeFootprint, loadFootprint };
