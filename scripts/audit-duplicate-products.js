/* eslint-disable no-console */
// READ-ONLY. Finds products that were created more than once for the SAME purchase-order configuration (same SKU, configuration values,
// eSIM, vendor, model, category and firmware: see productIdentityKey in services/poProductService.js), which is what put two
// "GB429 JIONET A+B GB429" rows on the inventory screen. Also lists inventory rows that repeat for one product (there should be none).
//
// Nothing is changed. Merging duplicates means re-pointing POs, processes, devices, cartons and stock onto one product, so it is a
// decision for a person: this report shows what each duplicate holds so the one to keep is easy to choose.
//
// Usage:
//   node scripts/audit-duplicate-products.js                         (uses .env.development unless NODE_ENV is set)
//   NODE_ENV=production node scripts/audit-duplicate-products.js
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

const main = async () => {
  loadEnv();
  await require("../config/db")();
  console.log(`Database: ${mongoose.connection.name}\n`);

  const Product = require("../models/Products");
  const Inventory = require("../models/inventoryManagement");
  const PurchaseOrder = require("../models/PurchaseOrder");
  const ProcessModel = require("../models/process");
  const { productIdentityKey } = require("../services/poProductService");

  const pos = await PurchaseOrder.find({ "fulfilment.productId": { $ne: null } })
    .select("poNumber skuCode configuration vendorId esim modelName deviceCategory firmware fulfilment.productId fulfilment.state createdAt")
    .sort({ createdAt: 1 })
    .lean();

  // identity -> productId -> the POs that point at it
  const groups = new Map();
  let withoutSku = 0;
  pos.forEach((po) => {
    const key = productIdentityKey(po);
    if (!key) {
      withoutSku += 1;
      return;
    }
    const byProduct = groups.get(key) || new Map();
    const id = String(po.fulfilment.productId);
    byProduct.set(id, [...(byProduct.get(id) || []), po]);
    groups.set(key, byProduct);
  });

  const duplicates = Array.from(groups.entries()).filter(([, byProduct]) => byProduct.size > 1);
  console.log(`${pos.length} PO(s) with a product; ${withoutSku} without a SKU (never matched); ${groups.size} distinct configuration(s).`);
  console.log(`${duplicates.length} configuration(s) have more than one product:\n`);

  for (const [key, byProduct] of duplicates) {
    console.log(`SKU ${key.split("|")[0]}  (${byProduct.size} products for one configuration)`);
    for (const [productId, poList] of byProduct) {
      const [product, inventory, processes] = await Promise.all([
        Product.findById(productId).select("name productCode status createdAt sourceKey").lean(),
        Inventory.findOne({ productType: productId }).select("quantity cartonQuantity status").lean(),
        ProcessModel.find({ selectedProduct: productId }).select("name processID status").lean(),
      ]);
      console.log(`  ${product ? `${product.productCode || "-"}  ${product.name}  [${product.status}]  made ${product.createdAt && product.createdAt.toISOString().slice(0, 10)}` : "(product no longer exists)"}  id ${productId}`);
      console.log(`      POs: ${poList.map((p) => `${p.poNumber} (${p.fulfilment.state || "-"})`).join(", ")}`);
      console.log(`      inventory: ${inventory ? `${inventory.quantity} kits, ${inventory.cartonQuantity} cartons, ${inventory.status}` : "none"}   processes: ${processes.length ? processes.map((p) => `${p.processID || p.name} [${p.status}]`).join(", ") : "none"}`);
    }
    console.log("");
  }

  const repeated = await Inventory.aggregate([{ $group: { _id: "$productType", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
  console.log(`Products with more than one inventory row: ${repeated.length}${repeated.length ? `  (${repeated.map((r) => String(r._id)).join(", ")})` : ""}`);
  if (duplicates.length) {
    console.log("\nNew POs no longer add to this: a PO of an existing configuration now reuses its product. To merge the ones above, keep the product");
    console.log("with the most history (processes, stock) and move the others' POs, processes, devices and stock onto it. Nothing here does that for you.");
  }
  await mongoose.disconnect();
  process.exit(0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
