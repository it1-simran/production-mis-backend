/**
 * Engineering approval of a PO auto-creates the Process; this then creates the
 * Process's devices with serial numbers from the SKU's serial format, so
 * Planning doesn't have to generate them by hand (Device Management →
 * Generate Serials still works for anything left over).
 *
 * Serial = prefix + running number (zero-padded to N digits, or not) + suffix,
 * the same rule as deviceController.generateSerials. The `devices.serialNo`
 * index is not unique, so collisions are prevented here: the running number
 * continues after the highest existing serial of this exact format, a block is
 * reserved atomically (Sequence), and every serial is re-checked before insert.
 */
const mongoose = require("mongoose");
const Device = require("../models/device");
const Sequence = require("../models/Sequence");
const SkuRequest = require("../models/SkuRequest");
const AccessorySerial = require("../models/AccessorySerial");

const MAX_DEVICES = 20000;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const build = (f, n) => `${f.prefix}${f.enableZero ? String(n).padStart(Math.max(1, f.noOfZeroRequired || 1), "0") : String(n)}${f.suffix}`;

/**
 * Best guess at the pattern behind a typed sample serial (SKUs from before the
 * serial format master), e.g. "GAGN14A26000001" -> GAGN14A26 + 6-digit number.
 * The sample is taken as the first serial: its running number is the trailing
 * zero-padded part ("000001"); without leading zeros the whole trailing digit
 * run is the number, unpadded. Engineering confirms/corrects it on approval.
 */
function deriveFromSample(sample) {
  const s = String(sample || "").trim();
  const m = s.match(/^(.*?)([0-9]+)([^0-9]*)$/);
  if (!m || !m[1] && !m[3]) return null;
  const [, head, digits, suffix] = m;
  const padded = digits.match(/0+[1-9][0-9]*$|0+$/);
  if (padded && padded.index > 0) {
    return { prefix: head + digits.slice(0, padded.index), suffix, enableZero: true, noOfZeroRequired: padded[0].length };
  }
  if (padded) return { prefix: head, suffix, enableZero: true, noOfZeroRequired: digits.length };
  return { prefix: head, suffix, enableZero: false, noOfZeroRequired: 0 };
}

/**
 * The serial pattern for a PO: its SKU's format (master / customer's own), or
 * one derived from the SKU's typed sample. { ...pattern, source, name } or null.
 */
async function formatForPo(po) {
  if (!po?.skuCode && !po?.serialNumberFormat) return null;
  const sku = po?.skuCode ? await SkuRequest.findOne({ skuCode: po.skuCode }).select("serialFormat serialNumberFormat").lean() : null;
  const f = sku?.serialFormat;
  if (f && String(f.prefix || "").trim()) {
    return {
      prefix: String(f.prefix).trim(),
      suffix: String(f.suffix || "").trim(),
      enableZero: !!f.enableZero,
      noOfZeroRequired: f.enableZero ? Number(f.noOfZeroRequired) || 1 : 0,
      name: f.name || "",
      source: f.custom ? "custom" : "master",
    };
  }
  const derived = deriveFromSample(sku?.serialNumberFormat || po?.serialNumberFormat);
  return derived ? { ...derived, name: "", source: "sample", sample: sku?.serialNumberFormat || po?.serialNumberFormat || "" } : null;
}

/** Where numbering for this pattern would start next (after devices and reserved blocks). */
async function nextNumber(f) {
  const name = `device_serial|${f.prefix}|${f.enableZero ? f.noOfZeroRequired : 0}|${f.suffix}`;
  const [used, seq] = await Promise.all([highestUsed(f), Sequence.findOne({ name }).lean()]);
  return Math.max(used, seq?.value || 0) + 1;
}

/** What approving would generate: format, quantity, first/last serial. */
async function previewForPo({ po, override = null }) {
  const f = override ? { ...override, name: "", source: "engineering" } : await formatForPo(po);
  const quantity = parseInt(po?.requiredQuantity, 10) || 0;
  if (!f) return { format: null, quantity, reason: "This PO's SKU has no serial number format." };
  const start = await nextNumber(f);
  return {
    format: f,
    quantity,
    first: build(f, start),
    last: build(f, start + Math.max(0, quantity - 1)),
    overflow: f.enableZero && String(start + quantity - 1).length > f.noOfZeroRequired,
  };
}

/** Highest running number already used by devices with exactly this format. */
async function highestUsed(f) {
  const rx = new RegExp(`^${escapeRegex(f.prefix)}([0-9]+)${escapeRegex(f.suffix)}$`);
  const [top] = await Device.aggregate([
    { $match: { serialNo: { $regex: `^${escapeRegex(f.prefix)}[0-9]+${escapeRegex(f.suffix)}$` } } },
    { $project: { serialNo: 1, len: { $strLenCP: "$serialNo" } } },
    { $sort: { len: -1, serialNo: -1 } },
    { $limit: 1 },
  ]);
  const m = top ? String(top.serialNo).match(rx) : null;
  return m ? parseInt(m[1], 10) : 0;
}

/** Reserve `count` consecutive numbers for this format (never handed out twice). */
async function reserveNumbers(f, count, floor) {
  const name = `device_serial|${f.prefix}|${f.enableZero ? f.noOfZeroRequired : 0}|${f.suffix}`;
  await Sequence.updateOne({ name }, { $max: { value: floor } }, { upsert: true });
  const seq = await Sequence.findOneAndUpdate({ name }, { $inc: { value: count } }, { new: true }).lean();
  return seq.value - count + 1;
}

/**
 * Create the devices for an auto-created Process. Returns a summary
 * { created, skipped, first, last, reason } — never throws for "nothing to do"
 * cases (no format on the SKU, devices already generated).
 */
async function generateDevicesForProcess({ po, product, process, format = null }) {
  const target = Math.min(MAX_DEVICES, parseInt(process?.quantity, 10) || parseInt(po?.requiredQuantity, 10) || 0);
  if (!target) return { created: 0, reason: "The process has no quantity." };
  const existing = await Device.countDocuments({ processID: process._id });
  const needed = target - existing;
  if (needed <= 0) return { created: 0, reason: "Devices are already generated for this process." };

  const f = format || (await formatForPo(po));
  if (!f) return { created: 0, reason: "The SKU has no serial number format — generate serials from Planning." };

  await Sequence.createIndexes().catch((e) => console.error("Sequence index:", e.message));
  const firstStage = product?.stages?.[0]?.stageName || process?.stages?.[0]?.stageName || "";
  const created = [];
  let skipped = 0;
  // A few rounds at most: a round only falls short when a reserved number was
  // already taken (e.g. typed by hand), and the next round continues after it.
  for (let round = 0; round < 5 && created.length < needed; round += 1) {
    const want = needed - created.length;
    const start = await reserveNumbers(f, want, await highestUsed(f));
    const candidates = Array.from({ length: want }, (_, i) => build(f, start + i));
    const [devHits, accHits] = await Promise.all([
      Device.find({ serialNo: { $in: candidates } }).select("serialNo").lean(),
      AccessorySerial.find({ serialNo: { $in: candidates } }).select("serialNo").lean(),
    ]);
    const taken = new Set([...devHits, ...accHits].map((d) => d.serialNo));
    const fresh = candidates.filter((s) => !taken.has(s));
    skipped += candidates.length - fresh.length;
    const docs = fresh.map((serialNo) => ({
      productType: product._id,
      processID: process._id,
      serialNo,
      currentStage: firstStage,
      modelName: po?.modelName || "",
    }));
    for (let i = 0; i < docs.length; i += 500) {
      await Device.insertMany(docs.slice(i, i + 500), { ordered: true });
    }
    created.push(...fresh);
  }
  return {
    created: created.length,
    skipped,
    first: created[0] || "",
    last: created[created.length - 1] || "",
    format: f,
    reason: created.length < needed ? `Only ${created.length} of ${needed} could be generated — generate the rest from Planning.` : "",
  };
}

module.exports = { generateDevicesForProcess, formatForPo, deriveFromSample, previewForPo };
