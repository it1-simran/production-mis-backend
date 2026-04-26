/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const Device = require("../models/device");
const Process = require("../models/process");
const DeviceTestRecord = require("../models/deviceTestModel");
const PlaningAndScheduling = require("../models/planingAndSchedulingModel");

const DUMMY_FLOW_TYPE = "move-to-packaging-seed";
const DUMMY_SEARCH_TYPE = "Move To Packaging Script";

const loadEnv = () => {
  const env = process.env.NODE_ENV || "development";
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
    processIds: [],
    serials: [],
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg.startsWith("--process=")) {
      const raw = arg.slice("--process=".length);
      parsed.processIds.push(...raw.split(",").map((v) => v.trim()).filter(Boolean));
      continue;
    }
    if (arg.startsWith("--serials=")) {
      const raw = arg.slice("--serials=".length);
      parsed.serials.push(...raw.split(",").map((v) => v.trim()).filter(Boolean));
    }
  }

  parsed.processIds = Array.from(new Set(parsed.processIds));
  parsed.serials = Array.from(new Set(parsed.serials));
  return parsed;
};

const normalizeObjectIds = (values = []) =>
  values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => mongoose.Types.ObjectId.isValid(value))
    .map((value) => new mongoose.Types.ObjectId(value));

const normalizeStageKey = (value = "") =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const getStageLabel = (stage = {}) => String(stage?.stageName || stage?.name || "").trim();

const resolvePackagingStageMeta = (processDoc) => {
  const stages = Array.isArray(processDoc?.stages) ? processDoc.stages : [];

  let packagingStageIndex = stages.findIndex((stage) => {
    const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
    return subSteps.some((step) => step?.isPackagingStatus === true && !step?.disabled);
  });

  if (packagingStageIndex < 0) {
    packagingStageIndex = stages.findIndex(
      (stage) => normalizeStageKey(getStageLabel(stage)) === "packaging",
    );
  }

  if (packagingStageIndex < 0) {
    return {
      packagingStageName: "",
      previousStageName: "",
      validationStageName: "",
    };
  }

  const packagingStageName = getStageLabel(stages[packagingStageIndex]);
  const previousStageName = packagingStageIndex > 0
    ? getStageLabel(stages[packagingStageIndex - 1])
    : "";

  return {
    packagingStageName,
    previousStageName,
    validationStageName: previousStageName || packagingStageName,
  };
};

const buildLatestPlanMapByProcess = async (processIds = []) => {
  const processObjectIds = normalizeObjectIds(processIds);
  if (processObjectIds.length === 0) {
    return new Map();
  }

  const plans = await PlaningAndScheduling.find({
    selectedProcess: { $in: processObjectIds },
    status: { $ne: "completed" },
  })
    .select("_id selectedProcess startDate status")
    .sort({ startDate: -1, _id: -1 })
    .lean();

  const planMap = new Map();
  plans.forEach((plan) => {
    const processId = String(plan?.selectedProcess || "").trim();
    if (!processId || planMap.has(processId)) return;
    planMap.set(processId, plan);
  });
  return planMap;
};

const buildExistingValidationPassSet = async ({
  deviceIds = [],
  processIds = [],
  stageNames = [],
}) => {
  const uniqueStageNames = Array.from(
    new Set(
      (Array.isArray(stageNames) ? stageNames : [])
        .map((name) => String(name || "").trim())
        .filter(Boolean),
    ),
  );
  if (deviceIds.length === 0 || uniqueStageNames.length === 0) {
    return new Set();
  }

  const existingRecords = await DeviceTestRecord.find({
    deviceId: { $in: deviceIds },
    processId: { $in: processIds },
    status: { $regex: /^(pass|completed)$/i },
    $or: [
      { stageName: { $in: uniqueStageNames } },
      { currentLogicalStage: { $in: uniqueStageNames } },
    ],
  })
    .select("deviceId stageName currentLogicalStage")
    .lean();

  const recordKeySet = new Set();
  existingRecords.forEach((record) => {
    const deviceId = String(record?.deviceId || "").trim();
    if (!deviceId) return;
    [record?.stageName, record?.currentLogicalStage].forEach((stageName) => {
      const stageKey = normalizeStageKey(stageName);
      if (!stageKey) return;
      recordKeySet.add(`${deviceId}::${stageKey}`);
    });
  });
  return recordKeySet;
};

const main = async () => {
  const { dryRun, processIds, serials } = parseArgs();
  loadEnv();
  await connectDB();

  try {
    const processObjectIds = normalizeObjectIds(processIds);
    const processQuery =
      processObjectIds.length > 0 ? { _id: { $in: processObjectIds } } : {};

    const processes = await Process.find(processQuery)
      .select("stages selectedProduct processID name")
      .lean();
    if (processes.length === 0) {
      console.log("No matching processes found.");
      return;
    }

    const processMetaMap = new Map();
    let processesMissingPackagingStage = 0;

    processes.forEach((processDoc) => {
      const stageMeta = resolvePackagingStageMeta(processDoc);
      if (!stageMeta.packagingStageName) {
        processesMissingPackagingStage += 1;
        return;
      }
      processMetaMap.set(String(processDoc._id), {
        processId: String(processDoc._id),
        processCode: String(processDoc?.processID || ""),
        processName: String(processDoc?.name || ""),
        selectedProduct: processDoc?.selectedProduct || null,
        ...stageMeta,
      });
    });

    if (processMetaMap.size === 0) {
      console.log("No processes with a Packaging stage were found.");
      return;
    }

    const deviceQuery = {
      processID: { $in: Array.from(processMetaMap.keys()).map((id) => new mongoose.Types.ObjectId(id)) },
    };
    if (serials.length > 0) {
      deviceQuery.serialNo = { $in: serials };
    }

    const devices = await Device.find(deviceQuery)
      .select("_id serialNo processID currentStage flowVersion flowStartedAt productType")
      .lean();

    const processIdsInScope = Array.from(
      new Set(devices.map((device) => String(device?.processID || "").trim()).filter(Boolean)),
    );
    const processObjectIdsInScope = normalizeObjectIds(processIdsInScope);
    const latestPlanMap = await buildLatestPlanMapByProcess(processIdsInScope);

    const validationStageNames = Array.from(
      new Set(
        Array.from(processMetaMap.values())
          .map((meta) => String(meta?.validationStageName || "").trim())
          .filter(Boolean),
      ),
    );
    const deviceIdsInScope = devices.map((device) => device?._id).filter(Boolean);
    const existingValidationPassSet = await buildExistingValidationPassSet({
      deviceIds: deviceIdsInScope,
      processIds: processObjectIdsInScope,
      stageNames: validationStageNames,
    });

    const bulkOps = devices
      .map((device) => {
        const processMeta = processMetaMap.get(String(device?.processID || ""));
        const targetStage = processMeta?.packagingStageName || "";
        if (!targetStage || !device?._id) return null;

        return {
          updateOne: {
            filter: { _id: device._id },
            update: {
              $set: {
                currentStage: targetStage,
                status: "",
                assignedDeviceTo: "",
                updatedAt: new Date(),
              },
            },
          },
        };
      })
      .filter(Boolean);

    const now = new Date();
    const dummyRecords = [];
    let dummyRecordsSkippedExistingPass = 0;
    devices.forEach((device) => {
      const processMeta = processMetaMap.get(String(device?.processID || ""));
      if (!processMeta || !device?._id) return;

      const validationStageName = String(processMeta?.validationStageName || "").trim();
      if (!validationStageName) return;

      const stageKey = normalizeStageKey(validationStageName);
      const dedupeKey = `${String(device._id)}::${stageKey}`;
      if (existingValidationPassSet.has(dedupeKey)) {
        dummyRecordsSkippedExistingPass += 1;
        return;
      }
      existingValidationPassSet.add(dedupeKey);

      const linkedPlan = latestPlanMap.get(String(device?.processID || ""));
      const flowVersion = Number(device?.flowVersion || 1);

      dummyRecords.push({
        deviceId: device._id,
        processId: device.processID,
        productId: device?.productType || processMeta?.selectedProduct || undefined,
        planId: linkedPlan?._id || undefined,
        serialNo: String(device?.serialNo || "").trim(),
        searchType: DUMMY_SEARCH_TYPE,
        stageName: validationStageName,
        status: "Pass",
        logs: [
          {
            stepName: validationStageName,
            stepType: "dummy-stage-seed",
            logData: {
              source: "scripts/move-devices-to-packaging.js",
              movedToStage: processMeta?.packagingStageName || "",
            },
            status: "Pass",
            createdAt: now,
          },
        ],
        assignedDeviceTo: processMeta?.packagingStageName || "",
        flowVersion: Number.isFinite(flowVersion) && flowVersion > 0 ? flowVersion : 1,
        flowType: DUMMY_FLOW_TYPE,
        flowBoundary: false,
        previousFlowVersion: null,
        flowStartedAt: device?.flowStartedAt || now,
        timeConsumed: "00:00:05",
        totalBreakTime: "00:00:00",
        startTime: now,
        endTime: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    const summary = {
      dryRun,
      processesMatched: processes.length,
      processesMissingPackagingStage,
      devicesMatched: devices.length,
      devicesToMove: bulkOps.length,
      devicesMoved: 0,
      linkedPlansResolved: latestPlanMap.size,
      dummyRecordsToCreate: dummyRecords.length,
      dummyRecordsCreated: 0,
      dummyRecordsSkippedExistingPass,
    };

    if (!dryRun) {
      if (bulkOps.length > 0) {
        const updateRes = await Device.bulkWrite(bulkOps, { ordered: false });
        summary.devicesMoved = updateRes?.modifiedCount || 0;
      }
      if (dummyRecords.length > 0) {
        const insertRes = await DeviceTestRecord.insertMany(dummyRecords, {
          ordered: false,
        });
        summary.dummyRecordsCreated = Array.isArray(insertRes) ? insertRes.length : 0;
      }
    } else {
      summary.devicesMoved = bulkOps.length;
      summary.dummyRecordsCreated = dummyRecords.length;
    }

    console.log("");
    console.log("Move devices to packaging summary");
    console.log("--------------------------------");
    console.log(`Dry run: ${summary.dryRun ? "yes" : "no"}`);
    console.log(`Processes matched: ${summary.processesMatched}`);
    console.log(`Processes missing packaging stage: ${summary.processesMissingPackagingStage}`);
    console.log(`Devices matched: ${summary.devicesMatched}`);
    console.log(`Devices to move: ${summary.devicesToMove}`);
    console.log(`Devices moved: ${summary.devicesMoved}`);
    console.log(`Linked active plans resolved: ${summary.linkedPlansResolved}`);
    console.log(`Dummy validation records to create: ${summary.dummyRecordsToCreate}`);
    console.log(`Dummy validation records created: ${summary.dummyRecordsCreated}`);
    console.log(`Dummy validation records skipped (existing pass): ${summary.dummyRecordsSkippedExistingPass}`);
  } finally {
    await mongoose.connection.close();
  }
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to move devices to packaging:", error);
    mongoose.connection
      .close()
      .catch(() => {})
      .finally(() => process.exit(1));
  });
