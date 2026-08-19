const Product = require("../models/Products");
const ProductCategory = require("../models/productCategory");
const SlugMapping = require("../models/slugMapping");
const { resolveTestingPlan } = require("./slugResolver");

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

/**
 * Auto-create a draft Product from a PO after OC is raised.
 *
 * IMPORTANT — one product per PO (no name-based reuse):
 * The product name is built from model + eSIM + profiles + category, which is
 * intentionally coarse-grained (human-readable). Two POs can share the same
 * name but differ in configuration values (vendorId, pip, eip, firmware, …).
 * Re-using a product by name would:
 *   (a) silently discard the second PO's slug-resolved testing commands, and
 *   (b) collapse their quantities into a single shared inventory row.
 * Every PO therefore always gets its own dedicated product document.
 *
 * Mutates po.fulfilment (productId/productName/state) but does NOT save the PO —
 * the caller persists it. Returns the product.
 */
async function createProductFromPO(po, user = {}) {
  const cat = await resolveProductCategory(po);
  const categoryName = (cat && cat.name) || po?.deviceCategory?.name || "";

  // Name = <Model> <eSIM Make> <A+B> <Category>
  const name = [po?.modelName, po?.esim?.make, profilePair(po), categoryName]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!name) throw new Error("Cannot build product name from PO (missing model/eSIM/category).");

  // Resolve the category testing plan with this PO's own slug values.
  let stages = [];
  if (cat && Array.isArray(cat.testingPlan) && cat.testingPlan.length) {
    const slugMaps = await SlugMapping.find({ isActive: true }).lean();
    const poObj = typeof po.toObject === "function" ? po.toObject() : po;
    stages = resolveTestingPlan(cat.testingPlan, poObj, slugMaps);
  }

  const product = await new Product({
    name,
    stages,
    status: "draft", // Engineering approval activates it (and creates inventory).
    createdBy: user.id || null,
    department: user.department || "",
  }).save();

  if (cat && isActiveCategory(cat)) {
    await ProductCategory.updateOne({ _id: cat._id }, { $addToSet: { products: product._id } });
  }

  po.fulfilment = po.fulfilment || {};
  po.fulfilment.productId = product._id;
  po.fulfilment.productName = name;
  po.fulfilment.state = "engineering_pending";
  return product;
}

module.exports = { createProductFromPO, profilePair, providerLetter, resolveProductCategory };
