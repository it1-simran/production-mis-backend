/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const Carton = require("../models/cartonManagement");
const Process = require("../models/process");
const Product = require("../models/Products");

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
      parsed.processIds.push(...raw.split(",").map((value) => value.trim()).filter(Boolean));
    }
  }

  parsed.processIds = Array.from(
    new Set(parsed.processIds.filter((value) => mongoose.Types.ObjectId.isValid(value))),
  );
  return parsed;
};

const toFiniteNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const pickHybridTolerance = (...candidates) => {
  let sawZero = false;
  for (const candidate of candidates) {
    const parsed = toFiniteNumber(candidate);
    if (parsed === null || parsed < 0) continue;
    if (parsed > 0) return parsed;
    sawZero = true;
  }
  return sawZero ? 0 : null;
};

const extractPackagingDataFromStages = (stages = []) => {
  const list = Array.isArray(stages) ? stages : [];

  for (const stage of list) {
    const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
    const activePackagingSubStep = subSteps.find(
      (subStep) => subStep?.isPackagingStatus && !subStep?.disabled && subStep?.packagingData,
    );
    if (activePackagingSubStep?.packagingData) {
      return activePackagingSubStep.packagingData;
    }
  }

  for (const stage of list) {
    const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
    const packagingSubStep = subSteps.find(
      (subStep) => subStep?.isPackagingStatus && subStep?.packagingData,
    );
    if (packagingSubStep?.packagingData) {
      return packagingSubStep.packagingData;
    }
  }

  return null;
};

const buildCartonQuery = (processIds = []) => {
  if (!Array.isArray(processIds) || processIds.length === 0) return {};
  return {
    processId: {
      $in: processIds.map((id) => new mongoose.Types.ObjectId(id)),
    },
  };
};

const main = async () => {
  const { dryRun, processIds } = parseArgs();
  loadEnv();
  await connectDB();

  const summary = {
    dryRun,
    cartonsScanned: 0,
    updated: 0,
    candidates: 0,
    skippedStocked: 0,
    alreadyHasTolerance: 0,
    missingProcess: 0,
    noResolvedTolerance: 0,
  };

  try {
    const cartons = await Carton.find(buildCartonQuery(processIds))
      .select("_id cartonSerial processId cartonStatus packagingData")
      .lean();
    summary.cartonsScanned = cartons.length;

    if (cartons.length === 0) {
      console.log("No cartons matched the request.");
      return;
    }

    const processIdsInCartons = Array.from(
      new Set(cartons.map((carton) => String(carton?.processId || "")).filter(Boolean)),
    );
    const processes = await Process.find({ _id: { $in: processIdsInCartons } })
      .select("_id selectedProduct stages")
      .lean();
    const processMap = new Map(processes.map((processDoc) => [String(processDoc._id), processDoc]));

    const productIds = Array.from(
      new Set(
        processes
          .map((processDoc) => String(processDoc?.selectedProduct || ""))
          .filter((value) => mongoose.Types.ObjectId.isValid(value)),
      ),
    );
    const products = await Product.find({ _id: { $in: productIds } })
      .select("_id stages")
      .lean();
    const productMap = new Map(products.map((productDoc) => [String(productDoc._id), productDoc]));

    const bulkOps = [];
    const preview = [];

    for (const carton of cartons) {
      const normalizedCartonStatus = String(carton?.cartonStatus || "").trim().toUpperCase();
      if (normalizedCartonStatus === "STOCKED") {
        summary.skippedStocked += 1;
        continue;
      }

      const existingTolerance = Number(carton?.packagingData?.cartonWeightTolerance ?? 0);
      if (Number.isFinite(existingTolerance) && existingTolerance > 0) {
        summary.alreadyHasTolerance += 1;
        continue;
      }

      const processDoc = processMap.get(String(carton?.processId || ""));
      if (!processDoc) {
        summary.missingProcess += 1;
        continue;
      }

      const productDoc = productMap.get(String(processDoc?.selectedProduct || ""));
      const processPackaging = extractPackagingDataFromStages(processDoc?.stages);
      const productPackaging = extractPackagingDataFromStages(productDoc?.stages);
      const resolvedTolerance =
        pickHybridTolerance(
          carton?.packagingData?.cartonWeightTolerance,
          processPackaging?.cartonWeightTolerance,
          productPackaging?.cartonWeightTolerance,
        ) ?? 0;

      if (!Number.isFinite(resolvedTolerance) || resolvedTolerance <= 0) {
        summary.noResolvedTolerance += 1;
        continue;
      }

      summary.candidates += 1;
      bulkOps.push({
        updateOne: {
          filter: { _id: carton._id },
          update: {
            $set: {
              "packagingData.cartonWeightTolerance": resolvedTolerance,
              updatedAt: new Date(),
            },
          },
        },
      });

      if (preview.length < 20) {
        preview.push({
          cartonSerial: carton.cartonSerial,
          processId: String(carton.processId || ""),
          tolerance: resolvedTolerance,
        });
      }
    }

    if (!dryRun && bulkOps.length > 0) {
      const writeResult = await Carton.bulkWrite(bulkOps, { ordered: false });
      summary.updated = Number(writeResult?.modifiedCount || 0);
    } else {
      summary.updated = bulkOps.length;
    }

    console.log("");
    console.log("Backfill carton tolerance summary");
    console.log("--------------------------------");
    console.log(`Dry run: ${summary.dryRun ? "yes" : "no"}`);
    console.log(`Process filter count: ${processIds.length}`);
    console.log(`Cartons scanned: ${summary.cartonsScanned}`);
    console.log(`Skipped (stocked): ${summary.skippedStocked}`);
    console.log(`Skipped (already has tolerance): ${summary.alreadyHasTolerance}`);
    console.log(`Skipped (missing process): ${summary.missingProcess}`);
    console.log(`Skipped (no resolvable tolerance): ${summary.noResolvedTolerance}`);
    console.log(`Candidates: ${summary.candidates}`);
    console.log(`Updated: ${summary.updated}`);

    if (preview.length > 0) {
      console.log("");
      console.log("Sample updates (up to 20):");
      preview.forEach((row) => {
        console.log(`- ${row.cartonSerial} | process ${row.processId} | tolerance ${row.tolerance}`);
      });
    }
  } finally {
    await mongoose.connection.close();
  }
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to backfill carton tolerance:", error);
    mongoose.connection
      .close()
      .catch(() => {})
      .finally(() => process.exit(1));
  });
