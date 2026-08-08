// Read-only check against production-mis-live for duplicate serial numbers.
// Reuses the app's own .env.production so the raw connection string is never printed.
// Temporary script — safe to delete after use.
process.env.NODE_ENV = "production";
require("dotenv").config({ path: require("path").join(__dirname, ".env.production") });

const mongoose = require("mongoose");
const connectDB = require("./config/db");
require("./models/process");
const deviceModel = require("./models/device");

async function main() {
  await connectDB();

  const dups = await deviceModel.aggregate([
    { $match: { serialNo: { $exists: true, $ne: "" } } },
    {
      $group: {
        _id: { $toLower: "$serialNo" },
        count: { $sum: 1 },
        docs: { $push: { id: "$_id", serialNo: "$serialNo", processID: "$processID", currentStage: "$currentStage", status: "$status", createdAt: "$createdAt" } },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);

  console.log(`Found ${dups.length} duplicated serial(s) (case-insensitive) out of the full devices collection.`);

  const processIds = [...new Set(dups.flatMap((d) => d.docs.map((doc) => String(doc.processID || ""))).filter(Boolean))];
  const Process = mongoose.model("process");
  const processes = await Process.find({ _id: { $in: processIds } }).select("name processName").lean();
  const processNameById = new Map(processes.map((p) => [String(p._id), p.name || p.processName || ""]));

  dups.forEach((d, i) => {
    console.log(`\n--- Duplicate ${i + 1}: "${d.docs[0].serialNo}" (${d.count} records) ---`);
    d.docs.forEach((doc) => {
      console.log({
        id: String(doc.id),
        serialNo: doc.serialNo,
        process: processNameById.get(String(doc.processID)) || String(doc.processID || "—"),
        currentStage: doc.currentStage,
        status: doc.status,
        createdAt: doc.createdAt,
      });
    });
  });

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
