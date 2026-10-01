/**
 * One answer to "must accessories be scanned before this device is packed?",
 * used by the packing guard (carton create / repackage) AND returned to the
 * operator screen with the checklist, so the two can never disagree.
 *
 * The process's own packaging sub-step decides (its copy is what the operator
 * works from); the product's is only a fallback for a process that has no
 * packaging sub-step of its own. Existing processes/products default to false.
 */
const mongoose = require("mongoose");

const packagingSteps = (stages) =>
  (Array.isArray(stages) ? stages : []).flatMap((stage) =>
    (Array.isArray(stage?.subSteps) ? stage.subSteps : []).filter((ss) => ss?.isPackagingStatus && !ss?.disabled)
  );

function packagingRequiresAccessoryScan(processDoc, productDoc) {
  const own = packagingSteps(processDoc?.stages);
  const steps = own.length ? own : packagingSteps(productDoc?.stages);
  return steps.some((ss) => ss?.requireAccessoryScan === true);
}

// Short cache: a checklist is fetched on every scan and repackaging checks many devices.
const TTL_MS = 30 * 1000;
const cache = new Map();

async function requiresScanForProcess(processId) {
  if (!processId || !mongoose.isValidObjectId(String(processId))) return false;
  const key = String(processId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const Process = require("../models/process");
  const Product = require("../models/Products");
  const processDoc = await Process.findById(key).select("stages selectedProduct productType productId").lean();
  const productId = processDoc?.selectedProduct || processDoc?.productType || processDoc?.productId || null;
  const productDoc = productId && mongoose.isValidObjectId(String(productId)) ? await Product.findById(productId).select("stages").lean() : null;
  const value = packagingRequiresAccessoryScan(processDoc, productDoc);
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { packagingRequiresAccessoryScan, requiresScanForProcess };
