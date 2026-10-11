/**
 * Device Serial Formats master (Device Management → Device Serial Formats).
 * GPSCPANEL reads the active ones for its SKU form (listForCpanel).
 */
const mongoose = require("mongoose");
const DeviceSerialFormat = require("../models/DeviceSerialFormat");
const SkuRequest = require("../models/SkuRequest");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const fail = (res, e, where) => {
  if (e?.status) return res.status(e.status).json({ status: e.status, message: e.message });
  if (e?.code === 11000) {
    const byName = e?.keyPattern?.name;
    return res.status(409).json({ status: 409, message: byName ? "A serial format with this name already exists." : "A serial format with the same prefix, digits and suffix already exists." });
  }
  console.error(`deviceSerialFormat ${where} error:`, e);
  return res.status(500).json({ status: 500, message: "Internal server error", error: e.message });
};

// autoIndex is off (config/db.js) — make sure the unique indexes exist before the first write.
let ready = null;
const ensureIndexes = () => {
  if (!ready) ready = DeviceSerialFormat.createIndexes().catch((e) => { ready = null; throw e; });
  return ready;
};

const PART = /^[A-Za-z0-9\-_/]*$/;
function readBody(b = {}, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = String(b.name || "").trim();
    if (!out.name) throw httpError(400, "Format name is required.");
    if (out.name.length > 80) throw httpError(400, "Format name can be at most 80 characters.");
  }
  if (!partial || b.prefix !== undefined) {
    out.prefix = String(b.prefix || "").trim();
    if (!out.prefix) throw httpError(400, "A prefix is required.");
    if (out.prefix.length > 30 || !PART.test(out.prefix)) throw httpError(400, "Prefix may use letters, digits, - _ / (up to 30).");
  }
  if (!partial || b.suffix !== undefined) {
    out.suffix = String(b.suffix || "").trim();
    if (out.suffix.length > 15 || !PART.test(out.suffix)) throw httpError(400, "Suffix may use letters, digits, - _ / (up to 15).");
  }
  if (!partial || b.enableZero !== undefined) out.enableZero = b.enableZero === true || b.enableZero === "true";
  if (!partial || b.noOfZeroRequired !== undefined || b.enableZero !== undefined) {
    const enableZero = out.enableZero ?? true;
    const digits = Number(b.noOfZeroRequired);
    if (enableZero && (!Number.isInteger(digits) || digits < 1 || digits > 12)) throw httpError(400, "Number of digits must be 1-12.");
    if (b.noOfZeroRequired !== undefined || !partial) out.noOfZeroRequired = enableZero ? digits : 0;
  }
  if (b.description !== undefined) out.description = String(b.description || "").trim().slice(0, 300);
  if (b.activeStatus !== undefined) out.activeStatus = b.activeStatus === true || b.activeStatus === "true";
  return out;
}

const withSample = (f) => ({ ...f, sample: DeviceSerialFormat.sampleOf(f) });
const skuUsage = (ids) =>
  SkuRequest.aggregate([
    { $match: { "serialFormat.id": { $in: ids.map(String) } } },
    { $group: { _id: "$serialFormat.id", n: { $sum: 1 } } },
  ]).then((rows) => new Map(rows.map((r) => [String(r._id), r.n])));

module.exports = {
  list: async (req, res) => {
    try {
      const filter = {};
      if (req.query.active === "true") filter.activeStatus = true;
      if (req.query.active === "false") filter.activeStatus = false;
      if (req.query.search) {
        const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ name: rx }, { prefix: rx }, { suffix: rx }, { description: rx }];
      }
      const rows = await DeviceSerialFormat.find(filter).sort({ name: 1 }).limit(1000).lean();
      const usage = await skuUsage(rows.map((r) => r._id));
      return res.status(200).json({ status: 200, data: rows.map((r) => ({ ...withSample(r), skuCount: usage.get(String(r._id)) || 0 })) });
    } catch (e) { return fail(res, e, "list"); }
  },

  create: async (req, res) => {
    try {
      await ensureIndexes();
      const body = readBody(req.body);
      const doc = await DeviceSerialFormat.create({ ...body, createdBy: req.user?._id || null });
      return res.status(201).json({ status: 201, message: "Serial format created.", data: withSample(doc.toObject()) });
    } catch (e) { return fail(res, e, "create"); }
  },

  update: async (req, res) => {
    try {
      await ensureIndexes();
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 404, message: "Serial format not found." });
      const doc = await DeviceSerialFormat.findById(req.params.id);
      if (!doc) return res.status(404).json({ status: 404, message: "Serial format not found." });
      const body = readBody({ enableZero: doc.enableZero, noOfZeroRequired: doc.noOfZeroRequired, ...req.body }, true);
      // SKUs keep the sample they were raised with; a format already on SKUs can't change its pattern.
      const patternChanged = ["prefix", "suffix", "enableZero", "noOfZeroRequired"].some((k) => body[k] !== undefined && body[k] !== doc[k]);
      if (patternChanged) {
        const used = (await skuUsage([doc._id])).get(String(doc._id)) || 0;
        if (used) throw httpError(409, `This format is used by ${used} SKU(s) — its prefix, digits and suffix can't change. Create a new format instead (you can deactivate this one).`);
      }
      Object.assign(doc, body, { updatedBy: req.user?._id || null, updatedAt: new Date() });
      await doc.save();
      return res.status(200).json({ status: 200, message: "Serial format updated.", data: withSample(doc.toObject()) });
    } catch (e) { return fail(res, e, "update"); }
  },

  remove: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 404, message: "Serial format not found." });
      const used = (await skuUsage([req.params.id])).get(String(req.params.id)) || 0;
      if (used) return res.status(409).json({ status: 409, message: `This format is used by ${used} SKU(s) — deactivate it instead of deleting.` });
      const r = await DeviceSerialFormat.deleteOne({ _id: req.params.id });
      if (!r.deletedCount) return res.status(404).json({ status: 404, message: "Serial format not found." });
      return res.status(200).json({ status: 200, message: "Serial format deleted." });
    } catch (e) { return fail(res, e, "remove"); }
  },

  /**
   * GET /integrations/cpanel/device-serial-formats  (service-key auth)
   * Active formats for the GPSCPANEL SKU form's Serial Number Format select.
   */
  listForCpanel: async (req, res) => {
    try {
      const rows = await DeviceSerialFormat.find({ activeStatus: true })
        .select("_id name prefix suffix enableZero noOfZeroRequired description")
        .sort({ name: 1 })
        .lean();
      return res.status(200).json({ status: 200, data: rows.map(withSample) });
    } catch (e) { return fail(res, e, "listForCpanel"); }
  },
};
