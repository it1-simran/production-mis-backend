const crypto = require("crypto");
const Product = require("../models/Products");
const ProductCategory = require("../models/productCategory");
const { nextProductCode } = require("./productCodeService");

// eSIM provider -> single-letter code for the product name (Airtel→A, BSNL→B, Vi→V).
const PROVIDER_LETTER = { airtel: "A", bsnl: "B", vi: "V", vodafone: "V", jio: "J" };

function providerLetter(profileStr) {
  const first = String(profileStr || "").trim().split(/[\s/]+/)[0].toLowerCase();
  if (!first) return "";
  return PROVIDER_LETTER[first] || first[0].toUpperCase();
}

// eSIM comes as a pair -> "A+B".
function profilePair(po) {
  const a = providerLetter(po?.esim?.profile1);
  const b = providerLetter(po?.esim?.profile2);
  return [a, b].filter(Boolean).join("+");
}

// PDI / FG to Store seed for products created by the PO path (the product
// editor's COMMON_STAGE_DEFAULTS); Dispatch/Delivery reserved, left unassigned.
const DEFAULT_COMMON_STAGES = [
  { stageName: "PDI", managedBy: "QC", requiredSkill: "PDI" },
  { stageName: "FG to Store", managedBy: "Store", requiredSkill: "FG to Store" },
  { stageName: "Dispatch", managedBy: "", requiredSkill: "" },
  { stageName: "Delivery", managedBy: "", requiredSkill: "" },
];

function isActiveCategory(cat) {
  return cat && String(cat.status) !== "0" && String(cat.status).toLowerCase() !== "inactive";
}

/**
 * Resolve the MES Product Category for a PO: prefer an explicit deviceCategoryId
 * mapping on a Product Category, else fall back to a name match.
 */
async function resolveProductCategory(po) {
  const devId = po?.deviceCategory?.id;
  if (devId != null) {
    const byId = await ProductCategory.findOne({ deviceCategoryId: devId });
    if (byId) return byId;
  }
  const name = po?.deviceCategory?.name;
  if (name) {
    return ProductCategory.findOne({ name: new RegExp(`^${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
  }
  return null;
}

// ---- product identity ----------------------------------------------------------------------------------------------------

const norm = (v) => String(v === undefined || v === null ? "" : v).trim();

// The configuration values of a PO (the SKU's snapshot), reduced to one digest so two POs can be compared. Order does not matter.
function configValuesDigest(po) {
  let values = po?.configuration?.values;
  if (values instanceof Map) values = Object.fromEntries(values);
  if (!values || typeof values !== "object") return "none";
  const entries = Object.keys(values)
    .sort()
    .map((k) => [k, norm(values[k] && typeof values[k] === "object" && "value" in values[k] ? values[k].value : values[k])]);
  return entries.length ? crypto.createHash("sha1").update(JSON.stringify(entries)).digest("hex") : "none";
}

/**
 * What makes two POs the same PRODUCT: the same SKU, the same configuration values, and the same eSIM, vendor, model, category and
 * firmware (every field a testing-plan slug can read, see SlugMapping). The quantity, delivery date and who raised it do not matter.
 * Returns null when the PO has no SKU, which means "do not reuse a product for this PO".
 */
function productIdentityKey(po) {
  const sku = norm(po?.skuCode);
  if (!sku) return null;
  return [
    sku,
    configValuesDigest(po),
    norm(po?.vendorId),
    norm(po?.esim?.make),
    norm(po?.esim?.profile1),
    norm(po?.esim?.profile2),
    norm(po?.modelName),
    norm(po?.deviceCategory?.id),
    norm(po?.firmware?.id),
  ].join("|");
}

const REUSABLE_STATUS = ["draft", "active"];

/**
 * An existing product made for the same configuration, or null. First by the identity stored on the product; then, for products that
 * were made from earlier POs before the identity was stored, by finding an earlier PO of the same SKU with the same identity (the
 * product is then given its identity so the next lookup is direct).
 */
async function findReusableProduct(po, key) {
  if (!key) return null;
  const direct = await Product.findOne({ sourceKey: key });
  if (direct) return REUSABLE_STATUS.includes(direct.status) ? direct : null;

  const PurchaseOrder = require("../models/PurchaseOrder");
  const earlier = await PurchaseOrder.find({ skuCode: norm(po.skuCode), "fulfilment.productId": { $ne: null }, _id: { $ne: po._id } })
    .select("skuCode configuration vendorId esim modelName deviceCategory firmware fulfilment.productId")
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();
  for (const other of earlier) {
    if (productIdentityKey(other) !== key) continue;
    const candidate = await Product.findById(other.fulfilment.productId);
    if (!candidate || !REUSABLE_STATUS.includes(candidate.status)) continue;
    try {
      await Product.updateOne({ _id: candidate._id, sourceKey: { $exists: false } }, { $set: { sourceKey: key } });
    } catch (e) {
      if (e?.code !== 11000) throw e; // someone else already holds this identity: use theirs below
      const holder = await Product.findOne({ sourceKey: key });
      if (holder) return holder;
    }
    return candidate;
  }
  return null;
}

function linkPoToProduct(po, product) {
  po.fulfilment = po.fulfilment || {};
  po.fulfilment.productId = product._id;
  po.fulfilment.productName = product.name;
  po.fulfilment.state = "engineering_pending";
}

/**
 * Give a PO its Product after OC is raised: REUSE the product already made for the same configuration, otherwise create a draft one.
 *
 * Reuse is by CONFIGURATION IDENTITY (productIdentityKey), never by name alone. An earlier version reused by name; the name is coarse
 * (model + eSIM + profiles + category), two POs with the same name can differ in vendor, PIP, EIP or firmware, and sharing one product
 * then silently dropped the second PO's testing commands and merged the quantities of different products. Two POs raised against the
 * same SKU with the same configuration are the same product, so they share it - and its inventory row - and each still gets its own
 * Process when Engineering approves it. A PO with no SKU is never matched (a new product, as before).
 *
 * Mutates po.fulfilment (productId/productName/state) but does NOT save the PO: the caller persists it.
 * Returns { product, reused }.
 */
async function findOrCreateProductFromPO(po, user = {}) {
  const key = productIdentityKey(po);
  const cat = await resolveProductCategory(po);

  const existing = await findReusableProduct(po, key);
  if (existing) {
    if (cat && isActiveCategory(cat)) await ProductCategory.updateOne({ _id: cat._id }, { $addToSet: { products: existing._id } });
    linkPoToProduct(po, existing);
    return { product: existing, reused: true };
  }

  const categoryName = (cat && cat.name) || po?.deviceCategory?.name || "";

  // Name = <Model> <eSIM Make> <A+B> <Category>
  const name = [po?.modelName, po?.esim?.make, profilePair(po), categoryName]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!name) throw new Error("Cannot build product name from PO (missing model/eSIM/category).");

  // NEW: Store the category testing plan RAW (with ${slug} tokens intact)
  // instead of resolving+freezing it here. Baking slug values in at creation
  // time meant a later fix in Slug Management (e.g. correcting which PO field
  // a slug points at) could never reach already-created products - resolution
  // now happens live at read time (see productController.getProductByID's
  // resolveSlugs option) against whatever SlugMapping docs are active *now*.
  const stages = cat && Array.isArray(cat.testingPlan) ? cat.testingPlan : [];

  // NEW: Same PDI/FG to Store defaults as the product editor's
  // COMMON_STAGE_DEFAULTS (components/product/edit/page.tsx) - a product
  // created here (the automated PO path) never passes through that UI, so it
  // needs the same seed applied directly, or it's created with commonStages: []
  // and both the product editor and any auto-created Process silently inherit
  // that empty array. Dispatch/Delivery intentionally left unset (not in
  // active use yet), matching the frontend.
  const commonStages = DEFAULT_COMMON_STAGES.map((s) => ({ ...s }));

  const productCode = await nextProductCode();
  let product;
  try {
    product = await new Product({
      name,
      productCode,
      ...(key ? { sourceKey: key } : {}),
      stages,
      stagesFromCategory: true, // later edits to the category's testing plan reach it until approval
      commonStages,
      status: "draft", // Engineering approval activates it (and creates inventory).
      createdBy: user.id || null,
      department: user.department || "",
    }).save();
  } catch (e) {
    // Two POs of the same configuration were processed at the same moment and the other one won: use its product.
    if (e?.code === 11000 && key) {
      const winner = await Product.findOne({ sourceKey: key });
      if (winner) {
        if (cat && isActiveCategory(cat)) await ProductCategory.updateOne({ _id: cat._id }, { $addToSet: { products: winner._id } });
        linkPoToProduct(po, winner);
        return { product: winner, reused: true };
      }
    }
    throw e;
  }

  if (cat && isActiveCategory(cat)) {
    await ProductCategory.updateOne({ _id: cat._id }, { $addToSet: { products: product._id } });
  }

  linkPoToProduct(po, product);
  po.fulfilment.productName = name;
  return { product, reused: false };
}

// The original entry point: returns just the product.
async function createProductFromPO(po, user = {}) {
  return (await findOrCreateProductFromPO(po, user)).product;
}

/**
 * The category's testing plan changed: products auto-created from POs that are
 * still waiting for Engineering (pending / on hold) take the new plan, unless
 * their stages were edited by hand. Returns how many products were updated.
 */
async function syncPendingProductsForCategory(category) {
  if (!category || !Array.isArray(category.testingPlan)) return 0;
  const PurchaseOrder = require("../models/PurchaseOrder");
  const pos = await PurchaseOrder.find({
    "fulfilment.state": { $in: ["engineering_pending", "engineering_hold"] },
    "fulfilment.productId": { $ne: null },
  }).select("deviceCategory fulfilment.productId").lean();
  const productIds = [];
  for (const po of pos) {
    const cat = await resolveProductCategory(po);
    if (cat && String(cat._id) === String(category._id)) productIds.push(po.fulfilment.productId);
  }
  if (!productIds.length) return 0;
  const r = await Product.updateMany(
    // Field missing = auto-created before the flag existed: still following the plan.
    { _id: { $in: productIds }, status: "draft", stagesFromCategory: { $ne: false } },
    { $set: { stages: category.testingPlan, updatedAt: new Date() } }
  );
  return r.modifiedCount || 0;
}

module.exports = { createProductFromPO, findOrCreateProductFromPO, productIdentityKey, findReusableProduct, profilePair, providerLetter, resolveProductCategory, syncPendingProductsForCategory, DEFAULT_COMMON_STAGES };
