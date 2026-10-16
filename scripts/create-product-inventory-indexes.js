/* eslint-disable no-console */
// Builds the two unique indexes "one product per PO configuration, one inventory row per product" relies on. This connection runs
// with autoIndex:false (config/db.js), so indexes declared on the models are never built automatically.
//
//   products.sourceKey        unique + sparse   two POs of one configuration processed at the same moment cannot both create a product
//   inventories.productType   unique            two requests for one product's inventory at the same moment cannot both insert a row
//
// The code reuses products and inventory rows without the indexes too; the indexes only close the same-moment race.
// It only ever CREATES indexes (never drops or changes another one). The inventory index is refused while any product has more than one
// inventory row (it could not be built): the duplicates are listed so they can be merged first (see audit-duplicate-products.js).
//
// Usage:
//   node scripts/create-product-inventory-indexes.js --dry-run       (shows what it would do)
//   node scripts/create-product-inventory-indexes.js                 (uses .env.development unless NODE_ENV is set)
//   NODE_ENV=production node scripts/create-product-inventory-indexes.js
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

// returns "exists", "created", "would create" or "blocked"
const ensureIndex = async ({ label, model, key, options, dryRun, blockedBy }) => {
  const indexes = await model.collection.indexes();
  const field = Object.keys(key)[0];
  const found = indexes.find((i) => i.key && Object.keys(i.key).length === 1 && i.key[field] === 1);
  console.log(`\n${label}: ${indexes.length} index(es) today (${indexes.map((i) => i.name).join(", ")})`);
  if (found) {
    const wantsSparse = !!options.sparse;
    const ok = found.unique && (!wantsSparse || found.sparse);
    console.log(`  an index on ${field} exists (${found.name}, unique: ${!!found.unique}, sparse: ${!!found.sparse}).${ok ? " Nothing to do." : " It is not as required: drop it by hand and run this again."}`);
    return ok ? "exists" : "blocked";
  }
  if (blockedBy) {
    const reason = await blockedBy();
    if (reason) {
      console.log(`  NOT created: ${reason}`);
      return "blocked";
    }
  }
  if (dryRun) {
    console.log(`  would create { ${field}: 1 } ${options.unique ? "unique " : ""}${options.sparse ? "sparse" : ""}`);
    return "would create";
  }
  const name = await model.collection.createIndex(key, options);
  console.log(`  created ${name}`);
  return "created";
};

const main = async () => {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");
  await require("../config/db")();
  console.log(`Database: ${mongoose.connection.name}${dryRun ? "   (dry run: nothing will be changed)" : ""}`);

  const Product = require("../models/Products");
  const Inventory = require("../models/inventoryManagement");

  const outcomes = [];
  outcomes.push(await ensureIndex({ label: "products", model: Product, key: { sourceKey: 1 }, options: { unique: true, sparse: true, name: "sourceKey_1" }, dryRun }));
  outcomes.push(
    await ensureIndex({
      label: "inventories",
      model: Inventory,
      key: { productType: 1 },
      options: { unique: true, name: "productType_1" },
      dryRun,
      blockedBy: async () => {
        const repeated = await Inventory.aggregate([{ $group: { _id: "$productType", n: { $sum: 1 }, ids: { $push: "$_id" } } }, { $match: { n: { $gt: 1 } } }]);
        if (!repeated.length) return "";
        repeated.forEach((r) => console.log(`    product ${r._id} has ${r.n} inventory rows: ${r.ids.join(", ")}`));
        return `${repeated.length} product(s) have more than one inventory row, so a unique index cannot be built. Merge those rows first.`;
      },
    })
  );

  await mongoose.disconnect();
  console.log(`\nDone: ${outcomes.join(", ")}.`);
  process.exit(outcomes.includes("blocked") ? 1 : 0);
};

main().catch((error) => {
  console.error("Failed:", error);
  process.exit(1);
});
