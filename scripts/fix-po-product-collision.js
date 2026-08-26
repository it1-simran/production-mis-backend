#!/usr/bin/env node
/**
 * fix-po-product-collision.js
 *
 * One-shot migration for the "product dedupe by name" regression.
 * POs that share a product via the old findOne({ name }) reuse now each get
 * their own dedicated product, with stages resolved from their own PO config.
 *
 * Dry-run by default — pass --execute to write changes.
 *
 * Usage:
 *   node scripts/fix-po-product-collision.js              # dry run
 *   node scripts/fix-po-product-collision.js --execute    # apply
 *
 * The script:
 *   1. Groups all POs in state >= engineering_pending by fulfilment.productId.
 *   2. For each productId referenced by MORE than one PO, keeps the first PO
 *      (oldest) as-is and clones a fresh product for every subsequent PO —
 *      re-resolving stages from that PO's own slug values.
 *   3. Re-links po.fulfilment.productId to the clone.
 *   4. Idempotent: groups with only one PO are skipped.
 */

"use strict";

require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env.development"),
});

const mongoose = require("mongoose");
const Product = require("../models/Products");
const PurchaseOrder = require("../models/PurchaseOrder");
const ProductCategory = require("../models/productCategory");
const SlugMapping = require("../models/slugMapping");
const { resolveTestingPlan } = require("../services/slugResolver");

const DRY_RUN = !process.argv.includes("--execute");

// ─── helpers ─────────────────────────────────────────────────────────────────

function isActiveCategory(cat) {
  return (
    cat &&
    String(cat.status) !== "0" &&
    String(cat.status).toLowerCase() !== "inactive"
  );
}

async function resolveProductCategory(po) {
  const devId = po?.deviceCategory?.id;
  if (devId != null) {
    const byId = await ProductCategory.findOne({ deviceCategoryId: devId });
    if (byId) return byId;
  }
  const name = po?.deviceCategory?.name;
  if (name) {
    return ProductCategory.findOne({
      name: new RegExp(
        "^" + String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
        "i"
      ),
    });
  }
  return null;
}

async function resolveStagesForPo(po, originalProduct) {
  const cat = await resolveProductCategory(po);
  let stages = [];
  if (cat && Array.isArray(cat.testingPlan) && cat.testingPlan.length) {
    const slugMaps = await SlugMapping.find({ isActive: true }).lean();
    stages = resolveTestingPlan(cat.testingPlan, po, slugMaps);
  } else {
    // Fall back: clone the original product's stages (better than empty).
    stages = (originalProduct.stages || []).map((s) =>
      JSON.parse(JSON.stringify(s))
    );
  }
  return { cat, stages };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.DB_URL, {
    serverSelectionTimeoutMS: 10_000,
  });
  console.log("Connected to:", mongoose.connection.name);
  console.log(
    DRY_RUN
      ? "MODE: DRY RUN  (pass --execute to apply)"
      : "MODE: EXECUTE — writing changes to DB"
  );

  // POs that have a product linked and are past oc_raised.
  const relevantStates = [
    "engineering_pending",
    "engineering_approved",
    "invoiced",
    "dispatched",
  ];
  const pos = await PurchaseOrder.find({
    "fulfilment.productId": { $exists: true, $ne: null },
    "fulfilment.state": { $in: relevantStates },
  }).lean();

  console.log(`Found ${pos.length} PO(s) with a linked product.`);

  // Group by shared productId.
  const byProduct = new Map();
  for (const po of pos) {
    const key = String(po.fulfilment.productId);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(po);
  }

  let collisions = 0;
  let fixed = 0;
  let skipped = 0;

  for (const [productId, group] of byProduct) {
    if (group.length < 2) continue; // No collision.
    collisions++;

    const originalProduct = await Product.findById(productId).lean();
    if (!originalProduct) {
      console.warn(
        `  [WARN] product ${productId} not found in DB — skipping group of ${group.length} POs.`
      );
      skipped++;
      continue;
    }

    // Oldest PO keeps the original product; newer POs get clones.
    group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    console.log(
      `\nCollision: product "${originalProduct.name}" (${productId})`
    );
    console.log(
      `  Shared by ${group.length} POs: ${group.map((p) => p.poNumber).join(", ")}`
    );
    console.log(
      `  → PO ${group[0].poNumber} keeps the original product (no change).`
    );

    for (let i = 1; i < group.length; i++) {
      const po = group[i];
      const { cat, stages } = await resolveStagesForPo(po, originalProduct);

      console.log(
        `  → PO ${po.poNumber} (state: ${po.fulfilment.state}) — will get a cloned product`
      );
      console.log(`    stages resolved: ${stages.length}`);

      if (!DRY_RUN) {
        const clone = await new Product({
          name: originalProduct.name,
          stages,
          status: originalProduct.status, // preserve draft/active
          autoNgEnabled: originalProduct.autoNgEnabled || false,
          commonStages: (originalProduct.commonStages || []).map((s) =>
            JSON.parse(JSON.stringify(s))
          ),
          createdBy: originalProduct.createdBy,
          department: originalProduct.department || "",
        }).save();

        if (cat && isActiveCategory(cat)) {
          await ProductCategory.updateOne(
            { _id: cat._id },
            { $addToSet: { products: clone._id } }
          );
        }

        await PurchaseOrder.updateOne(
          { _id: po._id },
          {
            $set: {
              "fulfilment.productId": clone._id,
              "fulfilment.productName": clone.name,
            },
            $push: {
              statusHistory: {
                fromStatus: po.status,
                toStatus: po.status,
                actorType: "mes",
                changedByName: "migration:fix-po-product-collision",
                remarks: `Cloned product ${productId} → ${clone._id} to fix name-based dedup collision`,
                changedAt: new Date(),
              },
            },
          }
        );

        console.log(`    ✓ Clone saved: ${clone._id} — PO re-linked.`);
        fixed++;
      } else {
        console.log(
          `    [DRY RUN] Would clone and re-link PO ${po.poNumber}.`
        );
        fixed++;
      }
    }
  }

  console.log("\n─── Summary ───────────────────────────────────────");
  console.log(`  Collision groups     : ${collisions}`);
  console.log(`  POs processed/fixed  : ${fixed}`);
  console.log(`  Skipped              : ${skipped}`);
  if (DRY_RUN) console.log("\n  Re-run with --execute to apply.");

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
