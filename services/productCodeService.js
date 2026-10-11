const Sequence = require("../models/Sequence");

/**
 * Atomic, gap-free Product Code: PRD-YYYY-000123.
 * Same pattern as nextPoNumber (purchaseOrderController.js) and nextProcessId
 * (purchaseOrderController.js) - a Sequence counter incremented atomically per
 * call, so concurrent product creations can never collide on the same code.
 */
async function nextProductCode() {
  const year = new Date().getFullYear();
  const seq = await Sequence.findOneAndUpdate(
    { name: "product_code" },
    { $inc: { value: 1 } },
    { new: true, upsert: true }
  );
  return `PRD-${year}-${String(seq.value).padStart(6, "0")}`;
}

module.exports = { nextProductCode };
