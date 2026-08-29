/* eslint-disable no-console */
// This connection runs with autoIndex:false (see config/db.js), so the
// processId/iapNo indexes declared on models/kitAllocationTransaction.js are
// never built automatically. Run this once per environment (dev, then prod)
// after deploying the IAP allocation-history feature, before the collection
// accumulates enough documents that unindexed lookups start costing real CPU.
//
// Usage:
//   node scripts/create-kit-allocation-transaction-indexes.js            (uses .env)
//   NODE_ENV=production node scripts/create-kit-allocation-transaction-indexes.js  (uses .env.production)
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const KitAllocationTransactionModel = require("../models/kitAllocationTransaction");

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

const main = async () => {
  loadEnv();
  await connectDB();

  const before = await KitAllocationTransactionModel.collection.indexes();
  console.log(`Existing indexes (${before.length}):`, before.map((i) => i.name).join(", "));

  await KitAllocationTransactionModel.syncIndexes();

  const after = await KitAllocationTransactionModel.collection.indexes();
  console.log(`Indexes after sync (${after.length}):`, after.map((i) => i.name).join(", "));

  await mongoose.disconnect();
  console.log("Done.");
};

main().catch((err) => {
  console.error("Failed to sync indexes:", err);
  process.exit(1);
});
