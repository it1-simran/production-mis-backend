const path = require("path");
require("dotenv").config({
  path: path.join(
    __dirname,
    process.env.NODE_ENV === "production"
      ? ".env.production"
      : ".env.development",
  ),
});
const mongoose = require("mongoose");
const Device = require("./models/device");
const DeviceTestRecord = require("./models/deviceTestModel");

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const DEFAULT_PROCESS_ID =
  process.env.PACKAGING_PROCESS_ID || "69b125f21878823797912f62";
const DEFAULT_SERIALS = [
  "28026120001",
  "28026120002",
  "28026120003",
  "28026120004",
  "28026120005",
  "28026120006",
  "28026120007",
  "28026120008",
  "28026120009",
  "28026120010",
];

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith("--")) continue;
    const [rawKey, ...rawValueParts] = entry.slice(2).split("=");
    const key = rawKey.trim();
    const value = rawValueParts.length ? rawValueParts.join("=").trim() : true;
    args[key] = value;
  }
  return args;
}

function normalizeSerial(serial) {
  return String(serial || "").trim();
}

function buildSerialList(rawValue) {
  if (!rawValue) return DEFAULT_SERIALS;
  if (Array.isArray(rawValue)) return rawValue.map(normalizeSerial).filter(Boolean);
  const value = String(rawValue).trim();
  if (!value) return DEFAULT_SERIALS;

  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeSerial).filter(Boolean);
      }
    } catch (error) {
      throw new Error("Invalid JSON passed to --serials");
    }
  }

  return value
    .split(",")
    .map(normalizeSerial)
    .filter(Boolean);
}

function dedupe(values) {
  return [...new Set(values)];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"] || args.dryRun);
  const processIdRaw = normalizeSerial(args.processId || DEFAULT_PROCESS_ID);
  const processId = mongoose.Types.ObjectId.isValid(processIdRaw)
    ? new mongoose.Types.ObjectId(processIdRaw)
    : null;
  const serials = dedupe(buildSerialList(args.serials));

  if (!MONGO_URI) {
    throw new Error("MONGODB_URI env var is not set.");
  }

  await mongoose.connect(MONGO_URI);

  const query = {
    serialNo: { $in: serials },
  };
  if (processId) {
    query.processID = processId;
  }

  const devices = await Device.find(query).lean();
  const deviceBySerial = new Map(
    devices.map((device) => [normalizeSerial(device.serialNo), device]),
  );

  const foundSerials = serials.filter((serial) => deviceBySerial.has(serial));
  const missingSerials = serials.filter((serial) => !deviceBySerial.has(serial));

  const testRecordQuery = {
    serialNo: { $in: foundSerials },
    stageName: "Packaging",
    flowType: "packaging",
  };
  if (processId) {
    testRecordQuery.processId = processId;
  }

  const existingRecords = await DeviceTestRecord.find(testRecordQuery)
    .select("serialNo processId deviceId createdAt")
    .lean();

  const existingSerialSet = new Set(
    existingRecords.map((record) => normalizeSerial(record.serialNo)),
  );

  const recordsToInsert = [];
  const devicesToUpdate = [];
  const now = new Date();

  for (const serial of foundSerials) {
    const device = deviceBySerial.get(serial);
    if (!device) continue;

    if (existingSerialSet.has(serial)) {
      continue;
    }

    recordsToInsert.push({
      deviceId: device._id,
      processId: processId || device.processID || undefined,
      productId: device.productType || undefined,
      serialNo: device.serialNo,
      searchType: "Dummy Packaging Seed",
      seatNumber: device.seatNumber || "",
      stageName: "Packaging",
      status: "Pass",
      trcRemarks: [],
      logs: [
        {
          stepName: "Packaging",
          stepType: "dummy-seed",
          logData: {
            source: "seed-packaging.js",
            serialNo: device.serialNo,
          },
          status: "Pass",
          createdAt: now,
        },
      ],
      assignedDeviceTo: "Packaging",
      ngDescription: "",
      flowVersion: Number(device.flowVersion || 1),
      flowBoundary: false,
      flowType: "packaging",
      previousFlowVersion: null,
      flowStartedAt: now,
      timeConsumed: "00:01:00",
      totalBreakTime: "00:00:00",
      startTime: now,
      endTime: new Date(now.getTime() + 60 * 1000),
      createdAt: now,
      updatedAt: now,
    });

    devicesToUpdate.push(device._id);
  }

  const summary = {
    inputSerials: serials.length,
    found: foundSerials.length,
    missing: missingSerials.length,
    skippedExisting: existingSerialSet.size,
    toInsert: recordsToInsert.length,
    dryRun,
  };

  if (dryRun) {
    console.log(JSON.stringify({ summary, missingSerials, insertPreview: recordsToInsert }, null, 2));
    await mongoose.disconnect();
    return;
  }

  if (recordsToInsert.length > 0) {
    await DeviceTestRecord.insertMany(recordsToInsert);
  }

  if (devicesToUpdate.length > 0) {
    await Device.updateMany(
      { _id: { $in: devicesToUpdate } },
      {
        $set: {
          currentStage: "Packaging",
          status: "Pass",
          updatedAt: new Date(),
        },
      },
    );
  }

  console.log(
    JSON.stringify(
      {
        ...summary,
        created: recordsToInsert.length,
        updatedDevices: devicesToUpdate.length,
        missingSerials,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error);
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  });
}
