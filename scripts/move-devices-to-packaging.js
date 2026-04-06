/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const Device = require("../models/device");
const Process = require("../models/process");

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

const resolvePackagingStageName = (processDoc) => {
  const stages = Array.isArray(processDoc?.stages) ? processDoc.stages : [];

  const packagingStatusStage = stages.find((stage) => {
    const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
    return subSteps.some((step) => step?.isPackagingStatus === true);
  });
  if (packagingStatusStage) {
    return String(packagingStatusStage?.stageName || "").trim();
  }

  const exactPackagingStage = stages.find(
    (stage) => String(stage?.stageName || "").trim().toLowerCase() === "packaging",
  );
  if (exactPackagingStage) {
    return String(exactPackagingStage?.stageName || "").trim();
  }

  return "";
};

const main = async () => {
  const { dryRun, processIds, serials } = parseArgs();
  loadEnv();
  await connectDB();

  try {
    const processObjectIds = normalizeObjectIds(processIds);
    const processQuery =
      processObjectIds.length > 0 ? { _id: { $in: processObjectIds } } : {};

    const processes = await Process.find(processQuery).select("stages").lean();
    if (processes.length === 0) {
      console.log("No matching processes found.");
      return;
    }

    const processStageMap = new Map();
    let processesMissingPackagingStage = 0;

    processes.forEach((processDoc) => {
      const stageName = resolvePackagingStageName(processDoc);
      if (!stageName) {
        processesMissingPackagingStage += 1;
        return;
      }
      processStageMap.set(String(processDoc._id), stageName);
    });

    const deviceQuery = {
      processID: { $in: Array.from(processStageMap.keys()).map((id) => new mongoose.Types.ObjectId(id)) },
    };
    if (serials.length > 0) {
      deviceQuery.serialNo = { $in: serials };
    }

    const devices = await Device.find(deviceQuery).select("_id serialNo processID currentStage").lean();

    const bulkOps = devices
      .map((device) => {
        const targetStage = processStageMap.get(String(device?.processID || ""));
        if (!targetStage) return null;

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

    const summary = {
      dryRun,
      processesMatched: processes.length,
      processesMissingPackagingStage,
      devicesMatched: devices.length,
      devicesToMove: bulkOps.length,
      devicesMoved: 0,
    };

    if (!dryRun && bulkOps.length > 0) {
      const updateRes = await Device.bulkWrite(bulkOps, { ordered: false });
      summary.devicesMoved = updateRes?.modifiedCount || 0;
    } else if (dryRun) {
      summary.devicesMoved = bulkOps.length;
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
