/**
 * A SKU raised with "Others — create my own serial format" carries the
 * pattern itself (SkuRequest.serialFormat.custom). On NPD final approval the
 * pattern joins the Device Serial Formats master — an identical existing
 * format is reused, never duplicated (same idea as services/esimMasterSync).
 */
const DeviceSerialFormat = require("../models/DeviceSerialFormat");

const PART = /^[A-Za-z0-9\-_/]*$/;
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Validate a custom pattern from a request: { prefix, suffix, enableZero, noOfZeroRequired }. */
function readCustomPattern(c = {}) {
  const prefix = String(c.prefix || "").trim();
  const suffix = String(c.suffix || "").trim();
  const enableZero = c.enableZero === true || c.enableZero === "true" || c.enableZero === "1" || c.enableZero === 1;
  const digits = Number(c.noOfZeroRequired);
  if (!prefix) throw httpError(400, "Enter a prefix for the custom serial number format.");
  if (prefix.length > 30 || !PART.test(prefix)) throw httpError(400, "Serial prefix may use letters, digits, - _ / (up to 30).");
  if (suffix.length > 15 || !PART.test(suffix)) throw httpError(400, "Serial suffix may use letters, digits, - _ / (up to 15).");
  if (enableZero && (!Number.isInteger(digits) || digits < 1 || digits > 12)) throw httpError(400, "Number of digits must be 1-12.");
  return { prefix, suffix, enableZero, noOfZeroRequired: enableZero ? digits : 0 };
}

/** What approving will do: reuse an identical master format, or add one. */
async function planSerialFormatSync(sku) {
  const f = sku?.serialFormat;
  if (!f || !f.custom || f.id) return null;
  const pattern = { prefix: f.prefix || "", suffix: f.suffix || "", enableZero: !!f.enableZero, noOfZeroRequired: f.enableZero ? Number(f.noOfZeroRequired) || 1 : 0 };
  const existing = await DeviceSerialFormat.findOne(pattern).lean();
  return { pattern, existing, sample: DeviceSerialFormat.sampleOf(pattern) };
}

/** Apply on final approval. Returns { serialFormat, note } or null when nothing to do. */
async function applySerialFormatSync(sku) {
  const plan = await planSerialFormatSync(sku);
  if (!plan) return null;
  await DeviceSerialFormat.createIndexes();
  let doc = plan.existing;
  let note = "";
  if (doc) {
    note = `Serial format: used existing "${doc.name}"`;
  } else {
    // Name it after the SKU; add a counter if that name is somehow taken.
    const base = `${sku.skuCode || "SKU"} format`;
    for (let i = 0; i < 20 && !doc; i += 1) {
      const name = i ? `${base} ${i + 1}` : base;
      try {
        doc = (await DeviceSerialFormat.create({ ...plan.pattern, name, description: `Created from ${sku.skuCode || "a SKU"} (customer's own format)` })).toObject();
      } catch (e) {
        if (e?.code !== 11000) throw e;
        // Same pattern created meanwhile -> reuse it; same name -> try the next.
        const same = await DeviceSerialFormat.findOne(plan.pattern).lean();
        if (same) doc = same;
      }
    }
    if (!doc) throw new Error("Could not add the serial format to the master.");
    note = `Serial format added to master: "${doc.name}"`;
  }
  return {
    serialFormat: { ...plan.pattern, id: String(doc._id), name: doc.name, custom: true },
    note,
  };
}

module.exports = { readCustomPattern, planSerialFormatSync, applySerialFormatSync };
