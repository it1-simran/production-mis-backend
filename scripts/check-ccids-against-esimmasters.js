// check-ccids-against-esimmasters.js
//
// READ-ONLY: compares a list of CCIDs (from an external Excel export, extracted
// beforehand into a JSON array) against the `esimmasters` collection and writes
// out the CCIDs that are NOT present there.
//
// Usage:
//   node scripts/check-ccids-against-esimmasters.js <input-ccids.json> <output-missing.json>

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env.production") });
const fs = require("fs");
const mongoose = require("mongoose");
const EsimMaster = require("../models/EsimMaster");

const normalizeForCompare = (value) => (typeof value === "string" ? value.trim().toUpperCase() : value);

const [, , INPUT_PATH, OUTPUT_PATH] = process.argv;
if (!INPUT_PATH || !OUTPUT_PATH) {
  console.error("Usage: node check-ccids-against-esimmasters.js <input-ccids.json> <output-missing.json>");
  process.exit(1);
}

async function main() {
  const inputCcids = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const normalizedToOriginal = new Map();
  for (const ccid of inputCcids) {
    normalizedToOriginal.set(normalizeForCompare(ccid), ccid);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const dbName = mongoose.connection.name;
  console.log(`Connected to database: ${dbName} (read-only check, no writes)`);

  if (dbName !== "production-mis-live") {
    console.error(`Refusing to run: expected database "production-mis-live", got "${dbName}".`);
    process.exit(1);
  }

  const totalInCollection = await EsimMaster.estimatedDocumentCount();
  console.log(`esimmasters collection has ${totalInCollection} documents total.`);

  // esimmasters ccid values may not be case/whitespace-normalized in the DB,
  // so we can't rely on an exact $in match - fetch all ccids once, normalize, then compare.
  const foundNormalized = new Set();
  const cursor = EsimMaster.find({}).select("ccid").lean().cursor();
  for await (const doc of cursor) {
    if (typeof doc.ccid === "string") foundNormalized.add(normalizeForCompare(doc.ccid));
  }

  const normalizedKeys = Array.from(normalizedToOriginal.keys());
  const missing = [];
  for (const key of normalizedKeys) {
    if (!foundNormalized.has(key)) missing.push(normalizedToOriginal.get(key));
  }

  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        inputCount: inputCcids.length,
        esimmastersCount: totalInCollection,
        esimmastersDistinctCcidCount: foundNormalized.size,
        missingCount: missing.length,
        missing,
      },
      null,
      2
    )
  );

  console.log(`Input CCIDs: ${inputCcids.length}`);
  console.log(`Distinct CCIDs found in esimmasters: ${foundNormalized.size}`);
  console.log(`Missing (not in esimmasters): ${missing.length}`);
  console.log(`Report written to ${OUTPUT_PATH}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
