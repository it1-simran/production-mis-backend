const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const PlaningAndScheduling = require("../models/planingAndSchedulingModel");
const Process = require("../models/process");

const loadEnv = () => {
  const env = process.env.NODE_ENV || "development";
  const envFile = ".env." + env;
  const envPath = path.resolve(__dirname, "..", envFile);
  const fallbackPath = path.resolve(__dirname, "..", ".env");

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log("Loaded " + envFile);
  } else if (fs.existsSync(fallbackPath)) {
    dotenv.config({ path: fallbackPath });
    console.log("Loaded .env");
  } else {
    console.warn("No .env file found. Using process env.");
  }
};

const normalizeValue = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeValue(value).toLowerCase().replace(/\s+/g, " ");

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    dryRun: false,
    all: false,
    planId: "",
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--all") {
      parsed.all = true;
      continue;
    }
    if (arg.startsWith("--plan=")) {
      parsed.planId = normalizeValue(arg.slice("--plan=".length));
    }
  }

  return parsed;
};

const buildStageMap = (processStages = []) => {
  const stageMap = new Map();
  (Array.isArray(processStages) ? processStages : []).forEach((stage) => {
    const key = normalizeKey(stage?.stageName || stage?.name);
    if (key && !stageMap.has(key)) {
      stageMap.set(key, stage);
    }
  });
  return stageMap;
};

const normalizeAssignedStages = ({ assignedStages = {}, processDoc = null }) => {
  const processStages = Array.isArray(processDoc?.stages) ? processDoc.stages : [];
  const stageMap = buildStageMap(processStages);
  const normalized = {};
  let repairedCount = 0;
  let retainedReservedCount = 0;
  let totalSeatEntries = 0;

  for (const [seatKey, seatValue] of Object.entries(assignedStages || {})) {
    const seatItems = Array.isArray(seatValue) ? seatValue : seatValue ? [seatValue] : [];
    const normalizedSeatItems = seatItems.map((item) => {
      totalSeatEntries += 1;
      const itemStageName = normalizeValue(item?.stageName || item?.name || item?.stage);
      const matchingStage = stageMap.get(normalizeKey(itemStageName));
      const belongsToCurrentProcess =
        normalizeValue(item?.pId) === normalizeValue(processDoc?.processID) ||
        normalizeValue(item?.processName) === normalizeValue(processDoc?.name);

      if (!item?.reserved) {
        return item;
      }

      if (belongsToCurrentProcess && matchingStage) {
        repairedCount += 1;
        return {
          ...item,
          reserved: false,
          name: matchingStage?.stageName || itemStageName,
          stageName: matchingStage?.stageName || itemStageName,
          requiredSkill:
            item?.requiredSkill ||
            matchingStage?.requiredSkill ||
            matchingStage?.stageName ||
            itemStageName,
          managedBy: item?.managedBy || matchingStage?.managedBy,
          upha: item?.upha || matchingStage?.upha,
          hasJigStepType:
            item?.hasJigStepType ||
            matchingStage?.hasJigStepType ||
            (Array.isArray(matchingStage?.subSteps)
              ? matchingStage.subSteps.some((step) => step?.stepType === "jig")
              : false),
        };
      }

      retainedReservedCount += 1;
      return item;
    });

    if (normalizedSeatItems.length > 0) {
      normalized[seatKey] = normalizedSeatItems;
    }
  }

  return {
    normalized,
    repairedCount,
    retainedReservedCount,
    totalSeatEntries,
  };
};

const loadPlans = async ({ planId, all }) => {
  if (all) {
    return PlaningAndScheduling.find({}).select("selectedProcess assignedStages processName").lean();
  }

  if (!planId) {
    throw new Error("Pass --plan=<planId> or use --all");
  }

  const query = mongoose.Types.ObjectId.isValid(planId)
    ? { _id: new mongoose.Types.ObjectId(planId) }
    : { _id: planId };

  const plan = await PlaningAndScheduling.findOne(query)
    .select("selectedProcess assignedStages processName")
    .lean();

  return plan ? [plan] : [];
};

const main = async () => {
  const { dryRun, all, planId } = parseArgs();

  loadEnv();
  await connectDB();

  try {
    const plans = await loadPlans({ planId, all });
    if (!plans.length) {
      throw new Error("No planning records found for the supplied criteria.");
    }

    for (const plan of plans) {
      const assignedStages = (() => {
        try {
          return typeof plan?.assignedStages === "string"
            ? JSON.parse(plan.assignedStages || "{}")
            : plan?.assignedStages || {};
        } catch (error) {
          console.warn("Skipping plan with invalid assignedStages:", String(plan?._id || ""));
          return null;
        }
      })();

      if (!assignedStages) {
        continue;
      }

      const processDoc = plan?.selectedProcess
        ? await Process.findById(plan.selectedProcess).lean()
        : null;

      if (!processDoc) {
        console.warn("Skipping plan without selected process:", String(plan?._id || ""));
        continue;
      }

      const { normalized, repairedCount, retainedReservedCount, totalSeatEntries } = normalizeAssignedStages({
        assignedStages,
        processDoc,
      });

      console.log(
        JSON.stringify(
          {
            planId: String(plan._id || ""),
            processName: processDoc?.name || plan?.processName || "",
            totalSeatEntries,
            repairedSelfReservedSeats: repairedCount,
            retainedExternalReservedSeats: retainedReservedCount,
            dryRun,
          },
          null,
          2,
        ),
      );

      if (!dryRun && repairedCount > 0) {
        await PlaningAndScheduling.updateOne(
          { _id: plan._id },
          {
            $set: {
              assignedStages: JSON.stringify(normalized),
            },
          },
        );
      }
    }
  } finally {
    await mongoose.connection.close();
  }
};

main().catch((error) => {
  console.error("Repair failed:", error.message || error);
  mongoose.connection
    .close()
    .catch(() => null)
    .finally(() => process.exit(1));
});
