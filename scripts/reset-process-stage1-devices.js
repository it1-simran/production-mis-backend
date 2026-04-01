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
    processRef: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "").trim();
    if (!arg) continue;

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--process" || arg === "--process-id" || arg === "--processID") {
      parsed.processRef = String(args[index + 1] || "").trim();
      index += 1;
      continue;
    }

    if (!arg.startsWith("--") && !parsed.processRef) {
      parsed.processRef = arg;
    }
  }

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

const toObjectId = (value) => {
  const raw = String(value || "").trim();
  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
};

const getStageOneName = async (processId) => {
  if (!processId) return "Stage 1";
  const process = await Process.findById(processId).select("stages").lean();
  const first = Array.isArray(process?.stages) ? process.stages[0] : null;
  return String(first?.stageName || "Stage 1");
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
  const idStrings = Array.from(
    new Set(processIds.map((v) => String(v || "").trim()).filter(Boolean)),
  );
  if (idStrings.length === 0) return { plansUpdated: 0 };
  const objectIds = idStrings.map(toObjectId).filter(Boolean);

  const plans = await PlaningAndScheduling.find({
    $or: [
      { selectedProcess: { $in: objectIds } },
      { selectedProcess: { $in: idStrings } },
    ],
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
      const cappedTotal = processQty > 0 ? Math.min(rawTotal, processQty) : rawTotal;
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
        const wipKey = `${seatKey}:::${idx}`;

        const nextStage = {
          ...stageObj,
          passedDevice: fresh.pass,
          ngDevice: fresh.ng,
          totalUPHA: Math.max(toNumber(wipBySeatStage[wipKey]), 0),
        };

        if (
          toNumber(stageObj?.passedDevice) !== nextStage.passedDevice ||
          toNumber(stageObj?.ngDevice) !== nextStage.ngDevice ||
          toNumber(stageObj?.totalUPHA) !== nextStage.totalUPHA
        ) {
          changed = true;
        }

        return nextStage;
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

const resolveProcess = async (processRef) => {
  const ref = String(processRef || "").trim();
  if (!ref) {
    throw new Error("Missing process reference. Pass --process <mongoId|processID|name>.");
  }

  const orConditions = [{ processID: ref }, { name: ref }];
  if (mongoose.Types.ObjectId.isValid(ref)) {
    orConditions.unshift({ _id: new mongoose.Types.ObjectId(ref) });
  }

  const process = await Process.findOne({ $or: orConditions })
    .select("_id name processID stages")
    .lean();

  if (!process) {
    throw new Error(`Process not found for reference: ${ref}`);
  }

  return process;
};

const resetDevicesForProcess = async (process, dryRun = false) => {
  const processId = process?._id;
  const stageOne = await getStageOneName(processId);
  const devices = await Device.find({ processID: processId })
    .select("_id serialNo processID")
    .lean();

  const serials = devices.map((device) => String(device.serialNo || "").trim()).filter(Boolean);
  const deviceIds = devices.map((device) => device._id);

  const summary = {
    processId: String(processId || ""),
    processName: process?.name || "",
    processCode: process?.processID || "",
    stageOne,
    devicesMatched: devices.length,
    devicesUpdated: 0,
    testLogsDeleted: 0,
    ngLogsDeleted: 0,
    assignNgLogsDeleted: 0,
    issueLogsDeleted: 0,
    operatorEventsDeleted: 0,
    attemptsDeleted: 0,
    cartonsUpdated: 0,
    transferRequestsUpdated: 0,
    plansUpdated: 0,
  };

  if (devices.length === 0) {
    return summary;
  }

  if (dryRun) {
    summary.devicesUpdated = devices.length;
    return summary;
  }

  const [
    deviceUpdateRes,
    testDeleteRes,
    ngDeleteRes,
    assignNgDeleteRes,
    issueDeleteRes,
    operatorEventsDeleteRes,
    attemptsDeleteRes,
    cartonsUpdateRes,
  ] = await Promise.all([
    Device.updateMany(
      { processID: processId },
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
    ),
    DeviceTestRecord.deleteMany({
      $or: [{ processId: processId }, { deviceId: { $in: deviceIds } }, { serialNo: { $in: serials } }],
    }),
    NGDevice.deleteMany({ serialNo: { $in: serials } }),
    AssignNgDevice.deleteMany({
      $or: [{ deviceId: { $in: deviceIds } }, { serialNo: { $in: serials } }],
    }),
    ReportedIssue.deleteMany({ serialNo: { $in: serials } }),
    OperatorWorkEvent.deleteMany({
      $or: [
        { "payload.serialNo": { $in: serials } },
        { "payload.serial": { $in: serials } },
        { "payload.deviceSerial": { $in: serials } },
        { "payload.scannedSerial": { $in: serials } },
      ],
    }),
    DeviceAttempt.deleteMany({ deviceId: { $in: deviceIds } }),
    CartonManagement.updateMany(
      { devices: { $in: deviceIds } },
      { $pull: { devices: { $in: deviceIds } } },
    ),
  ]);

  const transferRequests = await KitTransferRequest.find({
    serials: { $in: serials },
  }).select("_id serials quantity");
  let transferRequestsUpdated = 0;
  for (const req of transferRequests) {
    const nextSerials = (req.serials || []).filter((serial) => !serials.includes(String(serial)));
    const removedCount = (req.serials || []).length - nextSerials.length;
    if (removedCount <= 0) continue;
    req.serials = nextSerials;
    req.quantity = Math.max(Number(req.quantity || 0) - removedCount, 0);
    await req.save();
    transferRequestsUpdated += 1;
  }

  const reconcile = await reconcileAssignedStagesForProcesses([processId]);

  summary.devicesUpdated = deviceUpdateRes?.modifiedCount || 0;
  summary.testLogsDeleted = testDeleteRes?.deletedCount || 0;
  summary.ngLogsDeleted = ngDeleteRes?.deletedCount || 0;
  summary.assignNgLogsDeleted = assignNgDeleteRes?.deletedCount || 0;
  summary.issueLogsDeleted = issueDeleteRes?.deletedCount || 0;
  summary.operatorEventsDeleted = operatorEventsDeleteRes?.deletedCount || 0;
  summary.attemptsDeleted = attemptsDeleteRes?.deletedCount || 0;
  summary.cartonsUpdated = cartonsUpdateRes?.modifiedCount || 0;
  summary.transferRequestsUpdated = transferRequestsUpdated;
  summary.plansUpdated = reconcile?.plansUpdated || 0;

  return summary;
};

const run = async () => {
  const { dryRun, processRef } = parseArgs();
  loadEnv();
  await connectDB();

  const process = await resolveProcess(processRef);
  console.log(`Dry run: ${dryRun ? "YES" : "NO"}`);
  console.log(`Process: ${process.name} (${process.processID})`);
  console.log(`Mongo ID: ${process._id}`);

  const summary = await resetDevicesForProcess(process, dryRun);

  console.log("\nSummary");
  console.log(`- Stage 1: ${summary.stageOne}`);
  console.log(`- Devices matched: ${summary.devicesMatched}`);
  console.log(`- Devices updated: ${summary.devicesUpdated}`);
  console.log(`- Test logs deleted: ${summary.testLogsDeleted}`);
  console.log(`- NG logs deleted: ${summary.ngLogsDeleted}`);
  console.log(`- Assigned NG logs deleted: ${summary.assignNgLogsDeleted}`);
  console.log(`- Issue logs deleted: ${summary.issueLogsDeleted}`);
  console.log(`- Operator events deleted: ${summary.operatorEventsDeleted}`);
  console.log(`- Attempts deleted: ${summary.attemptsDeleted}`);
  console.log(`- Cartons updated: ${summary.cartonsUpdated}`);
  console.log(`- Transfer requests updated: ${summary.transferRequestsUpdated}`);
  console.log(`- Plans reconciled: ${summary.plansUpdated}`);

  if (summary.devicesMatched === 0) {
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
