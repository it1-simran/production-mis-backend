/* eslint-disable no-console */
// End-to-end check of "one product (and one inventory) per PO configuration". It runs the REAL poProductService and
// inventoryService against a real MongoDB, inside a throwaway database ("po-product-e2e-<timestamp>") that it drops at the end,
// so no existing data is read or changed.
//
// Usage:   node scripts/po-product-reuse-smoke.js          (uses .env.development)
// Refuses to run with NODE_ENV=production.
const path = require("path");
const fs = require("fs");
const dns = require("dns");
const assert = require("node:assert/strict");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const env = process.env.NODE_ENV || "development";
if (env === "production") {
  console.error("Refusing to run with NODE_ENV=production.");
  process.exit(2);
}
const envPath = path.resolve(__dirname, "..", `.env.${env}`);
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const scratchName = `po-product-e2e-${Date.now()}`;
const results = [];
let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL ${name}\n         ${String(error.message).split("\n").join("\n         ")}`);
  }
};

const main = async () => {
  try {
    const existing = dns.getServers();
    dns.setServers(["8.8.8.8", "1.1.1.1", ...existing.filter((s) => s !== "8.8.8.8" && s !== "1.1.1.1")]);
  } catch {
    // keep system resolvers
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: scratchName, autoIndex: false, serverSelectionTimeoutMS: 15000 });
  assert.equal(mongoose.connection.name, scratchName);
  console.log(`Scratch database: ${mongoose.connection.name}\n`);

  const Product = require("../models/Products");
  const Inventory = require("../models/inventoryManagement");
  const PurchaseOrder = require("../models/PurchaseOrder");
  const { findOrCreateProductFromPO, productIdentityKey } = require("../services/poProductService");
  const { createInventoryForProduct } = require("../services/inventoryService");
  // autoIndex is off here, so build the unique index the way a deployed server does
  await Product.createIndexes();
  await Inventory.createIndexes(); // the unique productType index, built here because autoIndex is off

  let n = 0;
  const makePo = (over = {}) =>
    new PurchaseOrder({
      poNumber: `PO-E2E-${++n}`,
      skuCode: "SKU-1",
      modelName: "GB429",
      vendorId: "JSD",
      deviceCategory: { id: 1, name: "GB429" },
      esim: { make: "JIONET", profile1: "ARWEE", profile2: "BSNL / BSNL Mobile" },
      firmware: { id: 1, name: "Basic" },
      requiredQuantity: 300,
      configuration: { values: { ip: { id: "18", value: "act.gpsbox.co.in" }, port: { id: "19", value: "9001" } } },
      ...over,
    });
  const user = { id: new mongoose.Types.ObjectId(), department: "Engineering" };
  const productCount = () => Product.countDocuments({});

  let first;
  await step("the first PO of a configuration creates a draft product that remembers its identity", async () => {
    const po = makePo();
    first = await findOrCreateProductFromPO(po, user);
    assert.equal(first.reused, false);
    assert.equal(first.product.status, "draft");
    assert.equal(first.product.name, "GB429 JIONET A+B GB429");
    assert.equal(first.product.sourceKey, productIdentityKey(po));
    assert.equal(String(po.fulfilment.productId), String(first.product._id));
    assert.equal(po.fulfilment.state, "engineering_pending");
    assert.equal(await productCount(), 1);
  });

  await step("a second PO of the same SKU and configuration reuses that product, whatever its quantity or number", async () => {
    const po = makePo({ requiredQuantity: 5000 });
    const again = await findOrCreateProductFromPO(po, user);
    assert.equal(again.reused, true);
    assert.equal(String(again.product._id), String(first.product._id));
    assert.equal(String(po.fulfilment.productId), String(first.product._id));
    assert.equal(po.fulfilment.state, "engineering_pending", "it still goes to Engineering, which creates this PO's own Process");
    assert.equal(await productCount(), 1, "no second product");
  });

  await step("reusing a product does not use up a product code", async () => {
    const other = await findOrCreateProductFromPO(makePo({ skuCode: "SKU-2" }), user);
    const a = Number(String(first.product.productCode).split("-").pop());
    const b = Number(String(other.product.productCode).split("-").pop());
    assert.equal(b, a + 1, `codes ${first.product.productCode} then ${other.product.productCode}: nothing was skipped`);
  });

  await step("the same NAME with a different configuration is a different product (a name alone never matches)", async () => {
    const before = await productCount();
    const diffConfig = makePo({ configuration: { values: { ip: { id: "18", value: "other.example.com" }, port: { id: "19", value: "9001" } } } });
    const r1 = await findOrCreateProductFromPO(diffConfig, user);
    assert.equal(r1.reused, false);
    assert.equal(r1.product.name, first.product.name, "same name");
    assert.notEqual(String(r1.product._id), String(first.product._id));
    const diffProfile = makePo({ esim: { make: "JIONET", profile1: "ARWEE", profile2: "Airtel" } });
    const r2 = await findOrCreateProductFromPO(diffProfile, user);
    assert.equal(r2.reused, false);
    const diffVendor = makePo({ vendorId: "OTHER" });
    assert.equal((await findOrCreateProductFromPO(diffVendor, user)).reused, false);
    assert.equal(await productCount(), before + 3);
  });

  await step("the order of the configuration values does not matter", async () => {
    const a = productIdentityKey(makePo({ configuration: { values: { ip: { value: "1" }, port: { value: "2" } } } }));
    const b = productIdentityKey(makePo({ configuration: { values: { port: { value: "2" }, ip: { value: "1" } } } }));
    assert.equal(a, b);
  });

  await step("a PO with no SKU is never matched: each gets its own product, as before", async () => {
    const before = await productCount();
    const x = await findOrCreateProductFromPO(makePo({ skuCode: "" }), user);
    const y = await findOrCreateProductFromPO(makePo({ skuCode: "" }), user);
    assert.equal(x.reused || y.reused, false);
    assert.equal(x.product.sourceKey, undefined);
    assert.equal(await productCount(), before + 2);
  });

  await step("a product made by the older code (no stored identity) is found through its PO and given the identity", async () => {
    const legacyPo = makePo({ skuCode: "SKU-LEGACY" });
    const legacyProduct = await new Product({ name: "GB429 JIONET A+B GB429", status: "active", stages: [], commonStages: [] }).save();
    legacyPo.fulfilment = { productId: legacyProduct._id, state: "production_pending" };
    await legacyPo.save();
    assert.equal(legacyProduct.sourceKey, undefined);
    const before = await productCount();
    const po = makePo({ skuCode: "SKU-LEGACY" });
    const r = await findOrCreateProductFromPO(po, user);
    assert.equal(r.reused, true);
    assert.equal(String(r.product._id), String(legacyProduct._id));
    assert.equal(await productCount(), before, "nothing new was made");
    assert.equal((await Product.findById(legacyProduct._id).lean()).sourceKey, productIdentityKey(po), "the identity is now stored on the product");
    assert.equal((await findOrCreateProductFromPO(makePo({ skuCode: "SKU-LEGACY" }), user)).reused, true, "and the next lookup is direct");
  });

  await step("a product that no longer exists is not reused", async () => {
    const gonePo = makePo({ skuCode: "SKU-GONE" });
    const gone = await new Product({ name: "Gone", status: "active", stages: [], commonStages: [] }).save();
    gonePo.fulfilment = { productId: gone._id, state: "production_pending" };
    await gonePo.save();
    await Product.deleteOne({ _id: gone._id });
    const r = await findOrCreateProductFromPO(makePo({ skuCode: "SKU-GONE" }), user);
    assert.equal(r.reused, false);
    assert.notEqual(String(r.product._id), String(gone._id));
  });

  await step("two POs of one configuration processed at the same moment end up with ONE product", async () => {
    for (let i = 0; i < 6; i += 1) {
      const sku = `SKU-RACE-${i}`;
      const before = await Product.countDocuments({ sourceKey: new RegExp(`^${sku}\\|`) });
      const [a, b] = await Promise.all([findOrCreateProductFromPO(makePo({ skuCode: sku }), user), findOrCreateProductFromPO(makePo({ skuCode: sku }), user)]);
      assert.equal(String(a.product._id), String(b.product._id), `round ${i}: both POs share the product`);
      assert.equal(await Product.countDocuments({ sourceKey: new RegExp(`^${sku}\\|`) }), before + 1, `round ${i}: one product`);
      assert.equal(Number(a.reused) + Number(b.reused), 1, `round ${i}: exactly one of them created it`);
    }
  });

  await step("the database refuses a second product with the same identity", async () => {
    const key = productIdentityKey(makePo({ skuCode: "SKU-UNIQUE" }));
    await new Product({ name: "One", sourceKey: key, stages: [], commonStages: [] }).save();
    await assert.rejects(() => new Product({ name: "Two", sourceKey: key, stages: [], commonStages: [] }).save(), (e) => e.code === 11000);
    // products without an identity (made by hand) are unaffected: any number can exist
    await new Product({ name: "Hand 1", stages: [], commonStages: [] }).save();
    await new Product({ name: "Hand 2", stages: [], commonStages: [] }).save();
  });

  await step("approving the POs of a shared product leaves ONE inventory row, however many times it is asked for", async () => {
    const [a, b] = [first.product, (await findOrCreateProductFromPO(makePo(), user)).product];
    assert.equal(String(a._id), String(b._id));
    await Promise.all(Array.from({ length: 8 }, (_, i) => createInventoryForProduct(i % 2 ? a : b, user)));
    assert.equal(await Inventory.countDocuments({ productType: a._id }), 1);
    const row = await Inventory.findOne({ productType: a._id }).lean();
    assert.equal(row.productName, "GB429 JIONET A+B GB429");
    assert.equal(row.quantity, 0);
  });

  console.log(results.join("\n"));
  console.log(`\n${results.filter((r) => r.startsWith("  ok")).length}/${results.length} passed, ${failures} failed`);
  await mongoose.connection.dropDatabase();
  console.log(`Dropped scratch database ${scratchName}`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
};

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch {
    // nothing to clean
  }
  process.exit(1);
});
