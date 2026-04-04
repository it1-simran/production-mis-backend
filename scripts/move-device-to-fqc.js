const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const Device = require("../models/device");
const Process = require("../models/process");
const DeviceAttempt = require("../models/deviceAttempt");

const DEFAULT_STAGE_ALIASES = ["FQC", "Final QC", "FinalQualityCheck", "Final Quality Check"];

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

const normalizeText = (value) => String(value || "").trim();

const normalizeStageKey = (value) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const pushCsvValues = (target, rawValue) => {
  if (!rawValue) return;
  rawValue
    .split(",")
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .forEach((value) => target.push(value));
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    dryRun: false,
    keepStatus: false,
    serials: [],
    deviceIds: [],
    processIds: [],
    stageOverride: "",
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--keep-status") {
      parsed.keepStatus = true;
      continue;
    }

    if (arg.startsWith("--serial=")) {
      pushCsvValues(parsed.serials, arg.slice("--serial=".length));
      continue;
    }

    if (arg.startsWith("--serials=")) {
      pushCsvValues(parsed.serials, arg.slice("--serials=".length));
      continue;
    }

    if (arg.startsWith("--device=")) {
      pushCsvValues(parsed.deviceIds, arg.slice("--device=".length));
      continue;
    }

    if (arg.startsWith("--devices=")) {
      pushCsvValues(parsed.deviceIds, arg.slice("--devices=".length));
      continue;
    }

    if (arg.startsWith("--process=")) {
      pushCsvValues(parsed.processIds, arg.slice("--process=".length));
      continue;
    }

    if (arg.startsWith("--stage=")) {
      parsed.stageOverride = normalizeText(arg.slice("--stage=".length));
      continue;
    }

    if (!arg.startsWith("--")) {
      parsed.serials.push(normalizeText(arg));
    }
  }

  parsed.serials = Array.from(new Set(parsed.serials.filter(Boolean)));
  parsed.deviceIds = Array.from(new Set(parsed.deviceIds.filter(Boolean)));
  parsed.processIds = Array.from(new Set(parsed.processIds.filter(Boolean)));

  return parsed;
};

const normalizeObjectIds = (values = []) =>
  values
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .filter((value) => mongoose.Types.ObjectId.isValid(value))
    .map((value) => new mongoose.Types.ObjectId(value));

const buildDeviceQuery = ({ serials, deviceIds, processIds }) => {
  const clauses = [];

  if (serials.length > 0) {
    clauses.push({ serialNo: { $in: serials } });
  }

  const deviceObjectIds = normalizeObjectIds(deviceIds);
  if (deviceObjectIds.length > 0) {
    clauses.push({ _id: { $in: deviceObjectIds } });
  }

  if (clauses.length === 0) {
    return null;
  }

  const query = clauses.length === 1 ? clauses[0] : { $or: clauses };
  const processObjectIds = normalizeObjectIds(processIds);
  if (processObjectIds.length > 0) {
    query.processID = { $in: processObjectIds };
  }

  return query;
};

const resolveTargetStageName = (processDoc, stageOverride) => {
  const productStages = Array.isArray(processDoc?.stages) ? processDoc.stages : [];
  const commonStages = Array.isArray(processDoc?.commonStages) ? processDoc.commonStages : [];
  const allStages = [...productStages, ...commonStages]
    .map((stage) => normalizeText(stage?.stageName))
    .filter(Boolean);

  if (allStages.length === 0) {
    return "";
  }

  if (stageOverride) {
    const requestedKey = normalizeStageKey(stageOverride);
    const exactStage = allStages.find((stageName) => normalizeStageKey(stageName) === requestedKey);
    return exactStage || "";
  }

  const aliasKeys = new Set(DEFAULT_STAGE_ALIASES.map((value) => normalizeStageKey(value)));
  const matchedStage = allStages.find((stageName) => aliasKeys.has(normalizeStageKey(stageName)));
  return matchedStage || "";
};

const buildMissingInputs = (inputSerials, inputDeviceIds, devices) => {
  const foundSerials = new Set(devices.map((device) => normalizeText(device?.serialNo)).filter(Boolean));
  const foundIds = new Set(devices.map((device) => String(device?._id || "")).filter(Boolean));

  const missingSerials = inputSerials.filter((value) => !foundSerials.has(value));
  const missingDeviceIds = inputDeviceIds.filter((value) => !foundIds.has(value));

  return { missingSerials, missingDeviceIds };
};

const printUsageAndExit = () => {
  console.log("Usage:");
  console.log("  node scripts/move-device-to-fqc.js --serial=GAGN14A261400671");
  console.log("  node scripts/move-device-to-fqc.js --serials=SERIAL1,SERIAL2 --dry-run");
  console.log("  node scripts/move-device-to-fqc.js --device=<deviceId> --process=<processId>");
  console.log("  node scripts/move-device-to-fqc.js --serial=SERIAL --stage='Final QC'");
  process.exit(1);
};

const main = async () => {
  const parsed = parseArgs();
  const query = buildDeviceQuery(parsed);

  if (!query) {
    printUsageAndExit();
    return;
  }

  loadEnv();
  await connectDB();

  try {
    const devices = await Device.find(query)
      .select("_id serialNo processID currentStage status")
      .lean();

    if (devices.length === 0) {
      console.log("No matching devices found.");
      return;
    }

    const { missingSerials, missingDeviceIds } = buildMissingInputs(parsed.serials, parsed.deviceIds, devices);
    const processCache = new Map();
    const outcomes = [];

    for (const device of devices) {
      const processKey = String(device?.processID || "");
      if (!processKey) {
        outcomes.push({
          serialNo: normalizeText(device?.serialNo) || String(device?._id || ""),
          fromStage: normalizeText(device?.currentStage),
          toStage: "",
          attemptsCleared: 0,
          error: "Device has no process assigned",
        });
        continue;
      }

      if (!processCache.has(processKey)) {
        const processDoc = await Process.findById(processKey)
          .select("name processID stages commonStages")
          .lean();
        processCache.set(processKey, processDoc || null);
      }

      const processDoc = processCache.get(processKey);
      if (!processDoc) {
        outcomes.push({
          serialNo: normalizeText(device?.serialNo) || String(device?._id || ""),
          fromStage: normalizeText(device?.currentStage),
          toStage: "",
          attemptsCleared: 0,
          error: `Process not found for ${processKey}`,
        });
        continue;
      }

      const targetStage = resolveTargetStageName(processDoc, parsed.stageOverride);
      if (!targetStage) {
        outcomes.push({
          serialNo: normalizeText(device?.serialNo) || String(device?._id || ""),
          fromStage: normalizeText(device?.currentStage),
          toStage: "",
          attemptsCleared: 0,
          error: parsed.stageOverride
            ? `Stage '${parsed.stageOverride}' not found in process ${normalizeText(processDoc?.processID) || processKey}`
            : `FQC stage not found in process ${normalizeText(processDoc?.processID) || processKey}`,
        });
        continue;
      }

      const update = {
        currentStage: targetStage,
        assignedDeviceTo: "",
        updatedAt: new Date(),
      };

      if (!parsed.keepStatus) {
        update.status = "";
      }

      let attemptsCleared = 0;
      if (!parsed.dryRun) {
        const [attemptDeleteRes] = await Promise.all([
          DeviceAttempt.deleteMany({ deviceId: device._id }),
          Device.updateOne({ _id: device._id }, { $set: update }),
        ]);
        attemptsCleared = attemptDeleteRes?.deletedCount || 0;
      }

      outcomes.push({
        serialNo: normalizeText(device?.serialNo) || String(device?._id || ""),
        fromStage: normalizeText(device?.currentStage),
        toStage: targetStage,
        attemptsCleared,
        error: "",
      });
    }

    console.log("");
    console.log("Move devices to FQC summary");
    console.log("---------------------------");
    console.log(`Dry run: ${parsed.dryRun ? "yes" : "no"}`);
    console.log(`Matched devices: ${devices.length}`);
    console.log(`Missing serials: ${missingSerials.length > 0 ? missingSerials.join(", ") : "none"}`);
    console.log(`Missing device IDs: ${missingDeviceIds.length > 0 ? missingDeviceIds.join(", ") : "none"}`);
    console.log("");

    outcomes.forEach((row) => {
      if (row.error) {
        console.log(`- ${row.serialNo}: FAIL (${row.error})`);
        return;
      }

      if (parsed.dryRun) {
        console.log(`- ${row.serialNo}: WOULD MOVE ${row.fromStage || "<blank>"} -> ${row.toStage}`);
        return;
      }

      console.log(
        `- ${row.serialNo}: MOVED ${row.fromStage || "<blank>"} -> ${row.toStage} (attempts cleared: ${row.attemptsCleared})`,
      );
    });

    const failed = outcomes.filter((row) => row.error).length;
    console.log("");
    console.log(`Success: ${outcomes.length - failed}`);
    console.log(`Failed: ${failed}`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await mongoose.connection.close();
  }
};

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error("Failed to move devices to FQC:", error);
    mongoose.connection
      .close()
      .catch(() => {})
      .finally(() => process.exit(1));
  });
