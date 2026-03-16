const mongoose = require("mongoose");

const uri = process.env.MONGO_URI;

const processId = "69b125f21878823797912f62";
const serials = [
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

const operators = {
  "Visual Inspection": "6995a1abba950bc9f6f6fc22",
  "Power Flow & Code Flashing": "6995a262ba950bc9f6f6feb0",
  "Functional": "6995a2f4ba950bc9f6f6ff0a",
  "Conformal Coating": "6995a34fba950bc9f6f6ff64",
  "Enclosure Assembly": "6995a392ba950bc9f6f6ffbe",
  "FQC": "6995a422ba950bc9f6f702a0",
  "Packaging": "6995a45cba950bc9f6f702fa",
};

const stages = [
  "Visual Inspection",
  "Power Flow & Code Flashing",
  "Functional",
  "Conformal Coating",
  "Enclosure Assembly",
  "FQC",
  "Packaging",
];

async function run() {
  if (!uri) {
    console.error("MONGO_URI env var not set.");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  const devicesCol = db.collection("devices");
  const recordsCol = db.collection("devicetestrecords");

  const devices = await devicesCol.find({
    serialNo: { $in: serials },
    processID: new mongoose.Types.ObjectId(processId),
  }).toArray();

  if (!devices.length) {
    console.log("No matching devices found.");
    process.exit(0);
  }

  await devicesCol.updateMany(
    { _id: { $in: devices.map(d => d._id) } },
    { $set: { currentStage: "Packaging", status: "Pass", updatedAt: new Date() } }
  );

  await recordsCol.deleteMany({
    processId: new mongoose.Types.ObjectId(processId),
    serialNo: { $in: serials },
    stageName: { $in: stages },
  });

  const now = new Date();
  const testRecords = [];

  devices.forEach((device, idx) => {
    stages.forEach((stageName, sIdx) => {
      testRecords.push({
        deviceId: device._id,
        processId: new mongoose.Types.ObjectId(processId),
        operatorId: new mongoose.Types.ObjectId(operators[stageName]),
        serialNo: device.serialNo,
        stageName,
        status: "Pass",
        assignedDeviceTo: "Operator",
        timeConsumed: "00:01:00",
        startTime: new Date(now.getTime() + sIdx * 60000),
        endTime: new Date(now.getTime() + (sIdx + 1) * 60000),
        logs: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
  });

  await recordsCol.insertMany(testRecords);

  console.log("Updated devices to Packaging + inserted stage history till FQC + Packaging.");
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
