const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const CartonManagement = require("../models/cartonManagement");
const CartonHistory = require("../models/cartonHistory");
const Device = require("../models/device");
const DeviceAttempt = require("../models/deviceAttempt");
const DeviceTest = require("../models/deviceTestModel");
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
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg.startsWith("--process=")) {
      const raw = arg.slice("--process=".length);
      parsed.processIds.push(...raw.split(",").map((v) => v.trim()).filter(Boolean));
    }
  }

  parsed.processIds = Array.from(new Set(parsed.processIds));
  return parsed;
};

const normalizeIds = (values = []) =>
  values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => mongoose.Types.ObjectId.isValid(value));

const getPrintingStageName = (processDoc) => {
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

  for (const stage of stages) {
    const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
    const hasPrinterSubStep = subSteps.some((step) => step?.isPrinterEnable === true);
    if (hasPrinterSubStep) {
      return String(stage?.stageName || "").trim();
    }
  }

  const packagingStage = stages.find((stage) =>
    String(stage?.stageName || "").trim().toLowerCase().includes("pack"),
  );
  if (packagingStage) {
    return String(packagingStage.stageName || "").trim();
  }

  return "";
};

const getStageNamesThroughPrinting = (processDoc) => {
  const stages = Array.isArray(processDoc?.stages) ? processDoc.stages : [];
  const printingStageName = getPrintingStageName(processDoc);
  if (!printingStageName) return [];

  const stageNames = stages
    .map((stage) => String(stage?.stageName || "").trim())
    .filter(Boolean);

  const printingStageIndex = stageNames.findIndex((name) => name === printingStageName);
  if (printingStageIndex === -1) {
    return [printingStageName];
  }

  return stageNames.slice(0, printingStageIndex + 1);
};

const buildCartonQuery = (processIds = []) => {
  const normalizedProcessIds = normalizeIds(processIds);
  if (normalizedProcessIds.length === 0) return {};

  return {
    processId: {
      $in: normalizedProcessIds.map((id) => new mongoose.Types.ObjectId(id)),
    },
  };
};

const main = async () => {
  const { dryRun, processIds } = parseArgs();
  loadEnv();
  await connectDB();

  const summary = {
    dryRun,
    cartonsFound: 0,
    cartonsDeleted: 0,
    cartonHistoryDeleted: 0,
    deviceTestsDeleted: 0,
    deviceAttemptsDeleted: 0,
    devicesTargeted: 0,
    devicesMoved: 0,
    devicesMissingProcess: 0,
    devicesMissingPrintingStage: 0,
    devicesNotFound: 0,
    processFilterCount: processIds.length,
  };

  try {
    const cartons = await CartonManagement.find(buildCartonQuery(processIds))
      .select("_id cartonSerial processId devices")
      .lean();

    summary.cartonsFound = cartons.length;

    if (cartons.length === 0) {
      console.log("No cartons matched the request.");
      return;
    }

    const processIdsFromCartons = Array.from(
      new Set(cartons.map((carton) => String(carton?.processId || "")).filter(Boolean)),
    );

    const processes = await Process.find({ _id: { $in: processIdsFromCartons } })
      .select("stages")
      .lean();

    const processMap = new Map(processes.map((processDoc) => [String(processDoc._id), processDoc]));

    const deviceToStageMap = new Map();
    const deviceToResetStageNamesMap = new Map();
    const deviceIds = [];
    const cartonSerials = cartons.map((carton) => String(carton?.cartonSerial || "").trim()).filter(Boolean);

    cartons.forEach((carton) => {
      const processDoc = processMap.get(String(carton?.processId || ""));
      if (!processDoc) {
        const count = Array.isArray(carton?.devices) ? carton.devices.length : 0;
        summary.devicesMissingProcess += count;
        return;
      }

      const printingStageName = getPrintingStageName(processDoc);
      const resetStageNames = getStageNamesThroughPrinting(processDoc);
      const cartonDeviceIds = Array.isArray(carton?.devices) ? carton.devices : [];

      if (!printingStageName) {
        summary.devicesMissingPrintingStage += cartonDeviceIds.length;
        return;
      }

      cartonDeviceIds.forEach((deviceId) => {
        const id = String(deviceId || "").trim();
        if (!id) return;
        deviceIds.push(id);
        deviceToStageMap.set(id, printingStageName);
        deviceToResetStageNamesMap.set(id, resetStageNames);
      });
    });

    const uniqueDeviceIds = Array.from(new Set(deviceIds));
    summary.devicesTargeted = uniqueDeviceIds.length;

    if (uniqueDeviceIds.length > 0) {
      const devices = await Device.find({ _id: { $in: uniqueDeviceIds } })
        .select("_id serialNo currentStage processID")
        .lean();

      const foundDeviceIds = new Set(devices.map((device) => String(device._id)));
      summary.devicesNotFound = uniqueDeviceIds.filter((id) => !foundDeviceIds.has(id)).length;

      const deviceIdsForCleanup = devices.map((device) => device._id);
      const resetStageNames = Array.from(
        new Set(
          devices.flatMap((device) => deviceToResetStageNamesMap.get(String(device._id)) || []),
        ),
      );

      const bulkOps = devices
        .map((device) => {
          const targetStage = deviceToStageMap.get(String(device._id));
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

      if (dryRun) {
        summary.devicesMoved = bulkOps.length;
        if (deviceIdsForCleanup.length > 0 && resetStageNames.length > 0) {
          summary.deviceTestsDeleted = await DeviceTest.countDocuments({
            deviceId: { $in: deviceIdsForCleanup },
            processId: { $in: processIdsFromCartons },
            stageName: { $in: resetStageNames },
          });
        }
        if (deviceIdsForCleanup.length > 0) {
          summary.deviceAttemptsDeleted = await DeviceAttempt.countDocuments({
            deviceId: { $in: deviceIdsForCleanup },
            processId: { $in: processIdsFromCartons },
          });
        }
      } else {
        if (bulkOps.length > 0) {
          const updateRes = await Device.bulkWrite(bulkOps, { ordered: false });
          summary.devicesMoved = updateRes?.modifiedCount || 0;
        }

        if (deviceIdsForCleanup.length > 0 && resetStageNames.length > 0) {
          const deleteTestsRes = await DeviceTest.deleteMany({
            deviceId: { $in: deviceIdsForCleanup },
            processId: { $in: processIdsFromCartons },
            stageName: { $in: resetStageNames },
          });
          summary.deviceTestsDeleted = deleteTestsRes?.deletedCount || 0;
        }

        if (deviceIdsForCleanup.length > 0) {
          const deleteAttemptsRes = await DeviceAttempt.deleteMany({
            deviceId: { $in: deviceIdsForCleanup },
            processId: { $in: processIdsFromCartons },
          });
          summary.deviceAttemptsDeleted = deleteAttemptsRes?.deletedCount || 0;
        }
      }
    }

    if (dryRun) {
      summary.cartonsDeleted = cartons.length;
      if (cartonSerials.length > 0) {
        summary.cartonHistoryDeleted = await CartonHistory.countDocuments({
          cartonSerial: { $in: cartonSerials },
        });
      }
    } else {
      const cartonIds = cartons.map((carton) => carton._id);
      const deleteRes = await CartonManagement.deleteMany({ _id: { $in: cartonIds } });
      summary.cartonsDeleted = deleteRes?.deletedCount || 0;

      if (cartonSerials.length > 0) {
        const deleteHistoryRes = await CartonHistory.deleteMany({
          cartonSerial: { $in: cartonSerials },
        });
        summary.cartonHistoryDeleted = deleteHistoryRes?.deletedCount || 0;
      }
    }

    console.log("");
    console.log("Reset cartons to printing stage summary");
    console.log("-------------------------------------");
    console.log(`Dry run: ${summary.dryRun ? "yes" : "no"}`);
    console.log(`Process filters: ${summary.processFilterCount}`);
    console.log(`Cartons found: ${summary.cartonsFound}`);
    console.log(`Cartons deleted: ${summary.cartonsDeleted}`);
    console.log(`Carton history deleted: ${summary.cartonHistoryDeleted}`);
    console.log(`Devices targeted: ${summary.devicesTargeted}`);
    console.log(`Devices moved: ${summary.devicesMoved}`);
    console.log(`Device test records deleted: ${summary.deviceTestsDeleted}`);
    console.log(`Device attempt records deleted: ${summary.deviceAttemptsDeleted}`);
    console.log(`Devices missing process: ${summary.devicesMissingProcess}`);
    console.log(`Devices missing printing stage: ${summary.devicesMissingPrintingStage}`);
    console.log(`Devices not found: ${summary.devicesNotFound}`);
  } finally {
    await mongoose.connection.close();
  }
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed to reset cartons:", error);
    mongoose.connection
      .close()
      .catch(() => {})
      .finally(() => process.exit(1));
  });
