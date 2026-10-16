/* eslint-disable no-console */
// config/db.js runs with autoIndex:false, so indexes declared in schemas are never built
// automatically. This script builds the ones the v2 planner relies on. All are NON-unique, so
// they cannot reject or alter any existing data; they only speed lookups and (for the event
// collection) expire old rows.
//
// Usage:
//   node scripts/create-planning-indexes.js --dry-run    list what would be created
//   node scripts/create-planning-indexes.js              create them (dev: .env.development)
//   NODE_ENV=production node scripts/create-planning-indexes.js   (live: run off-peak)
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const loadEnv = () => {
  const env = process.env.NODE_ENV || "development";
  const envPath = path.resolve(__dirname, "..", `.env.${env}`);
  const fallback = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
  else if (fs.existsSync(fallback)) dotenv.config({ path: fallback });
  console.log(`Environment: ${env}`);
};

const INDEXES = [
  {
    model: "../models/planingAndSchedulingModel",
    label: "planingandschedulings",
    specs: [{ key: { selectedRoom: 1, isDrafted: 1, startDate: 1, estimatedEndDate: 1 }, options: { name: "room_draft_dates" } }],
  },
  {
    model: "../models/assignJigToPlan",
    label: "assignjigplans",
    specs: [
      { key: { processId: 1, status: 1 }, options: { name: "process_status" } },
      { key: { jigId: 1, status: 1 }, options: { name: "jig_status" } },
    ],
  },
  {
    model: "../models/ProcessLogs",
    label: "processlogs",
    specs: [{ key: { processId: 1, timestamp: -1 }, options: { name: "process_time" } }],
  },
  {
    model: "../models/planValidationEvent",
    label: "planvalidationevents",
    specs: [
      { key: { createdAt: 1 }, options: { name: "ttl_createdAt", expireAfterSeconds: 60 * 60 * 24 * 120 } },
      { key: { planId: 1 }, options: { name: "planId" } },
      { key: { "issues.code": 1, createdAt: -1 }, options: { name: "issue_code_time" } },
    ],
  },
];

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  loadEnv();
  const connectDB = require("../config/db");
  await connectDB();
  console.log(`Database: ${mongoose.connection.name}${dryRun ? "   (dry run: nothing will be created)" : ""}\n`);

  for (const entry of INDEXES) {
    const Model = require(entry.model);
    let existing = [];
    try {
      existing = await Model.collection.indexes();
    } catch {
      // collection does not exist yet; createIndex will create it
    }
    const have = new Set(existing.map((i) => i.name));
    console.log(`${entry.label}: existing = ${[...have].join(", ") || "(none)"}`);
    for (const spec of entry.specs) {
      const name = spec.options.name;
      if (have.has(name)) {
        console.log(`  = ${name} already exists`);
        continue;
      }
      if (dryRun) {
        console.log(`  + would create ${name} ${JSON.stringify(spec.key)}`);
        continue;
      }
      await Model.collection.createIndex(spec.key, { ...spec.options, background: true });
      console.log(`  + created ${name}`);
    }
  }
  await mongoose.disconnect();
  console.log("\nDone.");
};

main().catch((error) => {
  console.error("Failed:", error);
  process.exit(1);
});
