// remove-ccid-fields.js
//
// Removes a fixed list of CCID/ICCID values from the `devices` collection in
// production-mis-live: unsets the root `ccid` field when it matches, and
// deletes any leaf key anywhere inside `customFields` whose value matches
// (customFields key naming for CCID is inconsistent across jig stages -
// CCID/ccid/ICCID/iccid/CCID1/CCID2/... - so matching is by value, not key).
//
// Usage:
//   node scripts/remove-ccid-fields.js            -> dry run: writes a report, no writes to the DB
//   node scripts/remove-ccid-fields.js --apply    -> applies the removals found by the dry run
//
// Target list: scripts/target-ccids-cleanup.json

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env.production") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Device = require("../models/device");
const { normalizeForCompare, stripCcidValuesFromObject } = require("../utils/customFieldsCcid");

const APPLY = process.argv.includes("--apply");
const TARGETS_PATH = path.join(__dirname, "target-ccids-cleanup.json");
const REPORT_PATH = path.join(__dirname, `ccid-cleanup-report-${APPLY ? "apply" : "dryrun"}.json`);

const targets = new Set(
  JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8")).map((v) => normalizeForCompare(v))
);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const dbName = mongoose.connection.name;
  console.log(`Connected to database: ${dbName} (${APPLY ? "APPLY MODE - will write" : "DRY RUN - no writes"})`);

  if (dbName !== "production-mis-live") {
    console.error(`Refusing to run: expected database "production-mis-live", got "${dbName}".`);
    process.exit(1);
  }

  const cursor = Device.find({}).select("_id serialNo ccid customFields").lean().cursor();

  const report = [];
  let scanned = 0;
  const bulkOps = [];

  for await (const doc of cursor) {
    scanned++;

    const rootMatches = typeof doc.ccid === "string" && doc.ccid && targets.has(normalizeForCompare(doc.ccid));
    // doc is a disposable lean (plain-object) cursor result and the update below
    // goes through a raw bulkWrite $set, not Document#save() - so mutating it
    // in place, with no defensive clone, is safe here (unlike the live-document
    // case in ccidTransferController.js, which needs a fresh top-level reference
    // for Mongoose's Mixed-type change detection to pick up the write).
    const customFields = doc.customFields || {};
    const cfRemoved = stripCcidValuesFromObject(customFields, targets);

    if (rootMatches || cfRemoved.length > 0) {
      report.push({
        _id: String(doc._id),
        serialNo: doc.serialNo,
        rootCcidRemoved: rootMatches ? doc.ccid : null,
        customFieldsRemoved: cfRemoved,
      });

      if (APPLY) {
        const update = { $set: { customFields, updatedAt: new Date() } };
        if (rootMatches) {
          update.$unset = { ccid: "" };
        }
        bulkOps.push({ updateOne: { filter: { _id: doc._id }, update } });
      }
    }
  }

  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify({ scanned, matchedDocs: report.length, matches: report }, null, 2)
  );
  console.log(`Scanned ${scanned} devices, ${report.length} matched.`);
  console.log(`Report written to ${REPORT_PATH}`);

  if (APPLY && bulkOps.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < bulkOps.length; i += BATCH) {
      const batch = bulkOps.slice(i, i + BATCH);
      const res = await Device.bulkWrite(batch, { ordered: false });
      console.log(`Batch ${i / BATCH + 1}: matched=${res.matchedCount} modified=${res.modifiedCount}`);
    }
  } else if (!APPLY) {
    console.log("Dry run only - no writes performed. Review the report, then re-run with --apply.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
