/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const Device = require("../models/device");
const Process = require("../models/process");
const DeviceTestRecord = require("../models/deviceTestModel");
const NGDevice = require("../models/NGDevice");
const DeviceAttempt = require("../models/deviceAttempt");
const AssignNgDevice = require("../models/assignNgDevice");
const ReportedIssue = require("../models/reportIssueModel");
const OperatorWorkEvent = require("../models/operatorWorkEvent");
const CartonManagement = require("../models/cartonManagement");
const KitTransferRequest = require("../models/kitTransferRequest");
const PlaningAndScheduling = require("../models/planingAndSchedulingModel");

const DEFAULT_SERIALS = [
  "28026110003",
  "28026110007",
  "28026110010",
  "28026110001",
  "28026110008",
  "28026110006",
  "28026110004",
  "28026110009",
  "28026110005",
  "28026110002",
];

const loadEnv = () => {
  const env = process.env.NODE_ENV || "production";
  const envFile = `.env.${env}`;
  const envPath = path.resolve(__dirname, "..", envFile);
  const fallbackPath = path.resolve(__dirname, "..", ".env");

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`Loaded ${envFile}`);
  } else if (fs.existsSync(fallbackPath)) {
    dotenv.config({ path: fallbackPath });
    console.log("Loaded .env");
  } else {
    console.warn("No .env file found. Using process env.");
  }
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    dryRun: false,
    serials: [],
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) continue;
    parsed.serials.push(String(arg).trim());
  }

  if (parsed.serials.length === 0) {
    parsed.serials = [...DEFAULT_SERIALS];
  }

  parsed.serials = Array.from(
    new Set(parsed.serials.map((s) => s.trim()).filter(Boolean)),
  );

  return parsed;
};

const safeParse = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const getStageOneName = async (device) => {
  if (!device?.processID) return "Stage 1";
  const process = await Process.findById(device.processID)
    .select("stages")
    .lean();
  const first = Array.isArray(process?.stages) ? process.stages[0] : null;
  return String(first?.stageName || "Stage 1");
};

const resetSingleDevice = async (serialNo, dryRun = false) => {
  const outcome = {
    serialNo,
    stageUpdated: false,
    testLogsDeleted: 0,
    ngLogsDeleted: 0,
    assignNgLogsDeleted: 0,
    issueLogsDeleted: 0,
    operatorEventsDeleted: 0,
    attemptsDeleted: 0,
    cartonsUpdated: 0,
    transferRequestsUpdated: 0,
    error: "",
  };

  const device = await Device.findOne({ serialNo }).lean();
  if (!device) {
    outcome.error = "Device not found";
    return outcome;
  }

  const stageOne = await getStageOneName(device);

  if (!dryRun) {
    await Device.updateOne(
      { _id: device._id },
      {
        $set: {
          currentStage: stageOne,
          status: "",
          assignedDeviceTo: "",
          customFields: {},
          flowVersion: 1,
          flowStartedAt: null,
          updatedAt: new Date(),
        },
      },
    );
  }
  outcome.stageUpdated = true;

  if (!dryRun) {
    const [
      testDeleteRes,
      ngDeleteRes,
      assignNgDeleteRes,
      issuesDeleteRes,
      eventsDeleteRes,
      attemptsDeleteRes,
      cartonUpdateRes,
    ] = await Promise.all([
      DeviceTestRecord.deleteMany({
        $or: [{ deviceId: device._id }, { serialNo }],
      }),
      NGDevice.deleteMany({ serialNo }),
      AssignNgDevice.deleteMany({
        $or: [{ deviceId: device._id }, { serialNo }],
      }),
      ReportedIssue.deleteMany({ serialNo }),
      OperatorWorkEvent.deleteMany({
        $or: [
          { "payload.serialNo": serialNo },
          { "payload.serial": serialNo },
          { "payload.deviceSerial": serialNo },
          { "payload.scannedSerial": serialNo },
        ],
      }),
      DeviceAttempt.deleteMany({ deviceId: device._id }),
      CartonManagement.updateMany(
        { devices: device._id },
        { $pull: { devices: device._id } },
      ),
    ]);

    const transferRequests = await KitTransferRequest.find({
      serials: serialNo,
    }).select("_id serials quantity");
    let transferRequestsUpdated = 0;
    for (const req of transferRequests) {
      const nextSerials = (req.serials || []).filter((s) => String(s) !== serialNo);
      const nextQty = Math.max(Number(req.quantity || 0) - 1, 0);
      req.serials = nextSerials;
      req.quantity = nextQty;
      await req.save();
      transferRequestsUpdated += 1;
    }

    outcome.testLogsDeleted = testDeleteRes?.deletedCount || 0;
    outcome.ngLogsDeleted = ngDeleteRes?.deletedCount || 0;
    outcome.assignNgLogsDeleted = assignNgDeleteRes?.deletedCount || 0;
    outcome.issueLogsDeleted = issuesDeleteRes?.deletedCount || 0;
    outcome.operatorEventsDeleted = eventsDeleteRes?.deletedCount || 0;
    outcome.attemptsDeleted = attemptsDeleteRes?.deletedCount || 0;
    outcome.cartonsUpdated = cartonUpdateRes?.modifiedCount || 0;
    outcome.transferRequestsUpdated = transferRequestsUpdated;
  }

  return outcome;
};

const buildStageCountMapForPlan = async (planId) => {
  const records = await DeviceTestRecord.find(
    { planId },
    "seatNumber stageName status",
  ).lean();

  const map = new Map();
  for (const r of records) {
    const seat = String(r?.seatNumber || "").trim();
    const stage = String(r?.stageName || "").trim();
    if (!seat || !stage) continue;

    const key = `${seat}:::${stage}`;
    const current = map.get(key) || { pass: 0, ng: 0 };
    const status = String(r?.status || "").trim().toUpperCase();
    if (status === "PASS" || status === "COMPLETED") current.pass += 1;
    else if (status === "NG" || status === "FAIL") current.ng += 1;
    map.set(key, current);
  }
  return map;
};

const reconcileAssignedStagesForProcesses = async (processIds) => {
  const ids = Array.from(new Set(processIds.map((v) => String(v || "")).filter(Boolean)));
  if (ids.length === 0) return { plansUpdated: 0 };

  const plans = await PlaningAndScheduling.find({
    selectedProcess: { $in: ids },
  }).lean();

  let plansUpdated = 0;
  for (const plan of plans) {
    const assignedStages = safeParse(plan?.assignedStages, {});
    if (!assignedStages || typeof assignedStages !== "object") continue;
    const processDoc = await Process.findById(plan?.selectedProcess)
      .select("quantity")
      .lean();
    const processQty = Math.max(toNumber(processDoc?.quantity), 0);

    const stageCountMap = await buildStageCountMapForPlan(plan._id);
    const deviceStageCountsRaw = await Device.aggregate([
      { $match: { processID: plan?.selectedProcess } },
      {
        $group: {
          _id: {
            $trim: { input: { $ifNull: ["$currentStage", ""] } },
          },
          count: { $sum: 1 },
        },
      },
    ]);
    const deviceStageCounts = {};
    deviceStageCountsRaw.forEach((row) => {
      const stageName = String(row?._id || "").trim();
      if (!stageName) return;
      deviceStageCounts[stageName] = Math.max(toNumber(row?.count), 0);
    });

    // Build seat references per stage so WIP can be distributed if a stage appears on multiple seats.
    const seatsByStage = {};
    for (const seatKey of Object.keys(assignedStages)) {
      const stages = Array.isArray(assignedStages[seatKey])
        ? assignedStages[seatKey]
        : [assignedStages[seatKey]];
      stages.forEach((stageObj, idx) => {
        const stageName = String(stageObj?.name || stageObj?.stageName || "").trim();
        if (!stageName || stageName.toLowerCase() === "reserved") return;
        if (!seatsByStage[stageName]) seatsByStage[stageName] = [];
        seatsByStage[stageName].push({ seatKey, idx });
      });
    }

    const wipBySeatStage = {};
    Object.keys(seatsByStage).forEach((stageName) => {
      const refs = seatsByStage[stageName] || [];
      if (refs.length === 0) return;
      const rawTotal = Math.max(toNumber(deviceStageCounts[stageName]), 0);
      const cappedTotal =
        processQty > 0 ? Math.min(rawTotal, processQty) : rawTotal;
      const base = Math.floor(cappedTotal / refs.length);
      let rem = cappedTotal % refs.length;
      refs.forEach((ref) => {
        const key = `${ref.seatKey}:::${ref.idx}`;
        wipBySeatStage[key] = base + (rem > 0 ? 1 : 0);
        if (rem > 0) rem -= 1;
      });
    });

    let changed = false;

    for (const seatKey of Object.keys(assignedStages)) {
      const stages = Array.isArray(assignedStages[seatKey])
        ? assignedStages[seatKey]
        : [assignedStages[seatKey]];

      const nextStages = stages.map((stageObj, idx) => {
        const stageName = String(stageObj?.name || stageObj?.stageName || "").trim();
        if (!stageName || stageName.toLowerCase() === "reserved") return stageObj;

        const key = `${seatKey}:::${stageName}`;
        const fresh = stageCountMap.get(key) || { pass: 0, ng: 0 };

        const oldPass = toNumber(stageObj?.passedDevice);
        const oldNg = toNumber(stageObj?.ngDevice);
        const oldWip = toNumber(stageObj?.totalUPHA);
        const nextPass = fresh.pass;
        const nextNg = fresh.ng;
        const wipKey = `${seatKey}:::${idx}`;
        const nextWip = Math.max(toNumber(wipBySeatStage[wipKey]), 0);

        if (nextPass !== oldPass || nextNg !== oldNg || nextWip !== oldWip) {
          changed = true;
        }

        return {
          ...stageObj,
          passedDevice: nextPass,
          ngDevice: nextNg,
          totalUPHA: nextWip,
        };
      });

      assignedStages[seatKey] = nextStages;
    }

    if (changed) {
      await PlaningAndScheduling.updateOne(
        { _id: plan._id },
        {
          $set: {
            assignedStages: JSON.stringify(assignedStages),
            updatedAt: new Date(),
          },
        },
      );
      plansUpdated += 1;
    }
  }

  return { plansUpdated };
};

const run = async () => {
  const { dryRun, serials } = parseArgs();
  loadEnv();
  await connectDB();

  console.log(`Dry run: ${dryRun ? "YES" : "NO"}`);
  console.log(`Devices: ${serials.length}`);

  const rows = [];
  const affectedProcessIds = [];
  for (const serialNo of serials) {
    const device = await Device.findOne({ serialNo }).select("processID").lean();
    if (device?.processID) {
      affectedProcessIds.push(String(device.processID));
    }
    const row = await resetSingleDevice(serialNo, dryRun);
    rows.push(row);
    if (row.error) {
      console.log(`- ${serialNo}: FAIL (${row.error})`);
    } else if (dryRun) {
      console.log(`- ${serialNo}: OK (would reset to stage 1 + clear logs)`);
    } else {
      console.log(
        `- ${serialNo}: OK (testLogs=${row.testLogsDeleted}, ngLogs=${row.ngLogsDeleted}, assignNgLogs=${row.assignNgLogsDeleted}, issues=${row.issueLogsDeleted}, operatorEvents=${row.operatorEventsDeleted}, attempts=${row.attemptsDeleted}, cartons=${row.cartonsUpdated}, transfers=${row.transferRequestsUpdated})`,
      );
    }
  }

  if (!dryRun) {
    const reconcile = await reconcileAssignedStagesForProcesses(affectedProcessIds);
    console.log(`- Reconciled plans: ${reconcile.plansUpdated}`);
  }

  const success = rows.filter((r) => !r.error).length;
  const failed = rows.length - success;
  console.log("\nSummary");
  console.log(`- Success: ${success}`);
  console.log(`- Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
};

run()
  .catch((error) => {
    console.error("Script failed:", error.message);
    process.exit(1);
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
