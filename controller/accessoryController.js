/**
 * Accessories Management: master, Product Category mapping, stock, and
 * PO-wise requirements / issue / return. Stock moves only through
 * services/accessoryStockService; PO lines through services/poAccessoryService.
 */
const mongoose = require("mongoose");
const Accessory = require("../models/Accessory");
const AccessoryStock = require("../models/AccessoryStock");
const AccessoryTransaction = require("../models/AccessoryTransaction");
const ProductCategory = require("../models/productCategory");
const PurchaseOrder = require("../models/PurchaseOrder");
const Sequence = require("../models/Sequence");
const stock = require("../services/accessoryStockService");
const poAcc = require("../services/poAccessoryService");
const serialSvc = require("../services/accessorySerialService");
const ppSerial = require("../services/processAccessorySerialService");
const AccessorySerial = require("../models/AccessorySerial");

const UNITS = ["pcs", "set", "m", "kg", "other"];
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isId = (v) => mongoose.isValidObjectId(v);

const fail = (res, error, where) => {
  const code = error?.status || 500;
  if (code >= 500) console.error(`accessory ${where} error:`, error);
  return res.status(code).json({ status: code, message: code >= 500 ? "Internal server error" : error.message, ...(code >= 500 ? { error: error.message } : {}) });
};

async function nextAccessoryCode() {
  const seq = await Sequence.findOneAndUpdate({ name: "accessory_code" }, { $inc: { value: 1 } }, { new: true, upsert: true });
  return `ACC-${String(seq.value).padStart(4, "0")}`;
}

async function nameTaken(name, exceptId) {
  const q = { name: new RegExp(`^${escapeRegex(String(name).trim())}$`, "i") };
  if (exceptId) q._id = { $ne: exceptId };
  return Accessory.exists(q);
}

function readMasterBody(b = {}, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) {
    const name = String(b.name || "").trim();
    if (!name) throw stock.httpError(400, "Accessory name is required.");
    if (name.length > 150) throw stock.httpError(400, "Accessory name is too long (max 150).");
    out.name = name;
  }
  if (b.description !== undefined) out.description = String(b.description || "").trim().slice(0, 1000);
  if (b.unit !== undefined) {
    if (!UNITS.includes(b.unit)) throw stock.httpError(400, `Unit must be one of: ${UNITS.join(", ")}.`);
    out.unit = b.unit;
  }
  if (b.trackStock !== undefined) out.trackStock = !!b.trackStock;
  if (b.activeStatus !== undefined) out.activeStatus = !!b.activeStatus;
  // serialMode is the source of truth; legacy callers may still send serialized.
  if (b.serialMode !== undefined) {
    if (!["none", "global", "per_process"].includes(b.serialMode)) throw stock.httpError(400, "Serial mode must be none, global or per_process.");
    out.serialMode = b.serialMode;
    out.serialized = b.serialMode === "global";
  } else if (b.serialized !== undefined) {
    out.serialized = !!b.serialized;
    out.serialMode = b.serialized ? "global" : "none";
  }
  if (b.serialSource !== undefined) {
    if (!["generated", "supplier"].includes(b.serialSource)) throw stock.httpError(400, "Serial source must be generated or supplier.");
    out.serialSource = b.serialSource;
  }
  if (b.serialFormat !== undefined) {
    const f = b.serialFormat || {};
    const prefix = String(f.prefix || "").trim().toUpperCase();
    const suffix = String(f.suffix || "").trim().toUpperCase();
    if (!/^[A-Z0-9-]{0,12}$/.test(prefix) || !/^[A-Z0-9-]{0,8}$/.test(suffix)) {
      throw stock.httpError(400, "Serial prefix/suffix may only use letters, digits and dashes (prefix up to 12, suffix up to 8).");
    }
    const padding = Number(f.padding ?? 6);
    if (!Number.isInteger(padding) || padding < 3 || padding > 10) throw stock.httpError(400, "Serial number padding must be 3-10 digits.");
    out.serialFormat = { prefix, suffix, padding, dateToken: ["none", "YYMM", "YYYYMM"].includes(f.dateToken) ? f.dateToken : "YYMM" };
  }
  if (out.serialized || out.serialMode === "per_process") out.trackStock = true; // serialized units are always stock-tracked
  return out;
}

/**
 * Serialized-accessory rules on save: a generated serial needs a prefix that no
 * other accessory uses (so a scanned serial identifies its type); an accessory
 * can only become serialized with no count-only stock on hand, and can only
 * stop being serialized once none of its serials are still in circulation.
 */
async function assertSerialRules(doc, body) {
  const next = { ...doc, ...body, serialFormat: { ...(doc.serialFormat || {}), ...(body.serialFormat || {}) } };
  const turningOn = next.serialized && !doc.serialized;
  const turningOff = !next.serialized && doc.serialized;
  if (next.serialized && next.serialSource === "generated") {
    const prefix = String(next.serialFormat.prefix || "");
    if (!prefix) throw stock.httpError(400, "A serial prefix is required for generated serials.");
    const clash = await Accessory.findOne({ _id: { $ne: doc._id }, serialized: true, "serialFormat.prefix": prefix }).select("name").lean();
    if (clash) throw stock.httpError(409, `Serial prefix "${prefix}" is already used by "${clash.name}".`);
    // New or changed global format: must not be able to produce another format's serials.
    const suffix = String(next.serialFormat.suffix || "");
    const changed = !doc.serialized || prefix !== String(doc.serialFormat?.prefix || "") || suffix !== String(doc.serialFormat?.suffix || "");
    if (changed) await ppSerial.assertNoFormatOverlap({ prefix, suffix }, { globalAccessoryId: doc._id });
  }
  if (turningOn && doc._id) {
    const b = await AccessoryStock.findOne({ accessoryId: doc._id }).lean();
    if (b && (b.onHand > 0 || b.reserved > 0)) {
      throw stock.httpError(409, `"${doc.name}" has ${b.onHand} unit(s) of count-only stock. Issue or adjust it to zero before making it serialized.`);
    }
  }
  const prevMode = doc.serialMode || (doc.serialized ? "global" : "none");
  if (next.serialMode && prevMode === "per_process" && next.serialMode !== "per_process") {
    const live = await AccessorySerial.countDocuments({ accessoryId: doc._id, status: { $in: ["ISSUED", "LINKED"] } });
    if (live) throw stock.httpError(409, `${live} per-process serial(s) of "${doc.name}" are still issued or linked - it cannot change serial mode.`);
  }
  if (doc._id && doc.trackStock !== false && next.trackStock === false) {
    const b = await AccessoryStock.findOne({ accessoryId: doc._id }).lean();
    if (b && (b.onHand > 0 || b.reserved > 0)) {
      throw stock.httpError(409, `"${doc.name}" still has ${b.onHand} on hand (${b.reserved} reserved). Issue, release or adjust it to zero before turning off stock tracking.`);
    }
  }
  if (turningOff) {
    const live = await AccessorySerial.countDocuments({ accessoryId: doc._id, status: { $in: ["IN_STOCK", "ISSUED", "LINKED"] } });
    if (live) throw stock.httpError(409, `${live} serial(s) of "${doc.name}" are still in stock, issued or linked - it cannot stop being serialized.`);
  }
}

module.exports = {
  // ---------------- Master ----------------
  list: async (req, res) => {
    try {
      const { search, active } = req.query;
      const filter = {};
      if (active === "true") filter.activeStatus = true;
      if (active === "false") filter.activeStatus = false;
      if (search) {
        const rx = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ name: rx }, { code: rx }, { description: rx }];
      }
      const data = await Accessory.find(filter).sort({ name: 1 }).limit(2000).lean();
      return res.status(200).json({ status: 200, data });
    } catch (e) { return fail(res, e, "list"); }
  },

  create: async (req, res) => {
    try {
      const body = readMasterBody(req.body);
      if (await nameTaken(body.name)) return res.status(409).json({ status: 409, message: `An accessory named "${body.name}" already exists.` });
      await assertSerialRules({ serialized: false, serialSource: "generated", serialFormat: {} }, body);
      const doc = await Accessory.create({ ...body, code: await nextAccessoryCode(), createdBy: req.user?._id || null });
      return res.status(201).json({ status: 201, message: "Accessory created.", data: doc });
    } catch (e) { return fail(res, e, "create"); }
  },

  update: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ status: 404, message: "Accessory not found." });
      const doc = await Accessory.findById(req.params.id);
      if (!doc) return res.status(404).json({ status: 404, message: "Accessory not found." });
      const body = readMasterBody(req.body, true);
      if (body.name && (await nameTaken(body.name, doc._id))) {
        return res.status(409).json({ status: 409, message: `An accessory named "${body.name}" already exists.` });
      }
      await assertSerialRules(doc.toObject(), body);
      Object.assign(doc, body, { updatedBy: req.user?._id || null });
      await doc.save();
      return res.status(200).json({ status: 200, message: "Accessory updated.", data: doc });
    } catch (e) { return fail(res, e, "update"); }
  },

  // ---------------- Product Category mapping ----------------
  getCategoryMapping: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ status: 404, message: "Product category not found." });
      const cat = await ProductCategory.findById(req.params.id).select("name deviceCategoryId accessories status").lean();
      if (!cat) return res.status(404).json({ status: 404, message: "Product category not found." });
      const docs = await Accessory.find({ _id: { $in: (cat.accessories || []).map((m) => m.accessoryId) } }).lean();
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      const mapping = (cat.accessories || []).map((m) => ({ ...m, accessory: byId.get(String(m.accessoryId)) || null }));
      return res.status(200).json({ status: 200, data: { _id: cat._id, name: cat.name, deviceCategoryId: cat.deviceCategoryId, mapping } });
    } catch (e) { return fail(res, e, "getCategoryMapping"); }
  },

  /** Replaces the category's whole mapping: body.mapping [{accessoryId, mandatory, qtyMode, defaultQty, allowQtyChange}]. */
  saveCategoryMapping: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ status: 404, message: "Product category not found." });
      const rows = Array.isArray(req.body?.mapping) ? req.body.mapping : null;
      if (!rows) return res.status(400).json({ status: 400, message: "mapping must be an array." });
      const cat = await ProductCategory.findById(req.params.id);
      if (!cat) return res.status(404).json({ status: 404, message: "Product category not found." });

      const existingIds = new Set((cat.accessories || []).map((m) => String(m.accessoryId)));
      const ids = rows.map((r) => String(r?.accessoryId || ""));
      if (ids.some((id) => !isId(id))) return res.status(400).json({ status: 400, message: "Every row needs a valid accessory." });
      if (new Set(ids).size !== ids.length) return res.status(400).json({ status: 400, message: "An accessory is listed more than once." });
      const docs = await Accessory.find({ _id: { $in: ids } }).lean();
      const byId = new Map(docs.map((d) => [String(d._id), d]));

      const mapping = [];
      for (const r of rows) {
        const a = byId.get(String(r.accessoryId));
        if (!a) return res.status(400).json({ status: 400, message: "An accessory in the list no longer exists." });
        // An inactive accessory may stay mapped (already there), but can't be newly added.
        if (!a.activeStatus && !existingIds.has(String(a._id))) {
          return res.status(400).json({ status: 400, message: `"${a.name}" is inactive and can't be added.` });
        }
        const qty = Number(r.defaultQty);
        if (!Number.isInteger(qty) || qty < 1 || qty > 100000) {
          return res.status(400).json({ status: 400, message: `Default quantity for "${a.name}" must be a whole number of at least 1.` });
        }
        mapping.push({
          accessoryId: a._id,
          mandatory: !!r.mandatory,
          qtyMode: r.qtyMode === "per_po" ? "per_po" : "per_device",
          defaultQty: qty,
          allowQtyChange: !!r.allowQtyChange,
        });
      }
      cat.accessories = mapping;
      cat.markModified("accessories");
      await cat.save();
      return res.status(200).json({ status: 200, message: "Accessory mapping saved.", data: cat.accessories });
    } catch (e) { return fail(res, e, "saveCategoryMapping"); }
  },

  /** GET /integrations/cpanel/accessories?deviceCategoryId=&deviceCategoryName= (service key) — what a PO may carry. */
  mappedForCpanel: async (req, res) => {
    try {
      const idRaw = req.query.deviceCategoryId;
      const deviceCategory = {
        id: idRaw !== undefined && idRaw !== "" && Number.isFinite(Number(idRaw)) ? Number(idRaw) : null,
        name: String(req.query.deviceCategoryName || ""),
      };
      const { category, items } = await poAcc.mappedAccessoriesFor(deviceCategory);
      return res.status(200).json({
        status: 200,
        categoryMapped: !!category,
        productCategory: category ? category.name : "",
        data: items.map((i) => ({ ...i, accessoryId: String(i.accessoryId) })),
      });
    } catch (e) { return fail(res, e, "mappedForCpanel"); }
  },

  // ---------------- Stock ----------------
  stockList: async (req, res) => {
    try {
      const accessories = await Accessory.find(req.query.all === "true" ? {} : { trackStock: true }).sort({ name: 1 }).lean();
      const buckets = await AccessoryStock.find({ accessoryId: { $in: accessories.map((a) => a._id) } }).lean();
      const byId = new Map(buckets.map((b) => [String(b.accessoryId), b]));
      const data = accessories.map((a) => {
        const b = byId.get(String(a._id)) || { onHand: 0, reserved: 0 };
        return { ...a, onHand: b.onHand, reserved: b.reserved, available: b.onHand - b.reserved };
      });
      return res.status(200).json({ status: 200, data });
    } catch (e) { return fail(res, e, "stockList"); }
  },

  receive: async (req, res) => {
    try {
      const { accessoryId, qty, refNo, remarks } = req.body || {};
      const a = isId(accessoryId) ? await Accessory.findById(accessoryId).lean() : null;
      if (!a) return res.status(404).json({ status: 404, message: "Accessory not found." });
      if (!a.trackStock) return res.status(409).json({ status: 409, message: `"${a.name}" is not stock-tracked.` });
      if (a.serialized) return res.status(409).json({ status: 409, message: `"${a.name}" is serialized - receive it by generating or importing serials.` });
      const bucket = await stock.receive(a._id, qty, { refNo: String(refNo || "").trim(), remarks: String(remarks || "").trim(), user: req.user });
      return res.status(200).json({ status: 200, message: "Stock received.", data: bucket });
    } catch (e) { return fail(res, e, "receive"); }
  },

  adjust: async (req, res) => {
    try {
      const { accessoryId, delta, remarks } = req.body || {};
      const a = isId(accessoryId) ? await Accessory.findById(accessoryId).lean() : null;
      if (!a) return res.status(404).json({ status: 404, message: "Accessory not found." });
      if (!a.trackStock) return res.status(409).json({ status: 409, message: `"${a.name}" is not stock-tracked.` });
      if (a.serialized) return res.status(409).json({ status: 409, message: `"${a.name}" is serialized - scrap individual serials instead of adjusting the count.` });
      const bucket = await stock.adjust(a._id, delta, { remarks: String(remarks || "").trim(), user: req.user });
      return res.status(200).json({ status: 200, message: "Stock adjusted.", data: bucket });
    } catch (e) { return fail(res, e, "adjust"); }
  },

  transactions: async (req, res) => {
    try {
      const filter = {};
      if (req.query.accessoryId) {
        if (!isId(req.query.accessoryId)) return res.status(400).json({ status: 400, message: "Invalid accessory." });
        filter.accessoryId = req.query.accessoryId;
      }
      if (req.query.poId) {
        if (!isId(req.query.poId)) return res.status(400).json({ status: 400, message: "Invalid PO." });
        filter.poId = req.query.poId;
      }
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const data = await AccessoryTransaction.find(filter).sort({ at: -1 }).limit(limit).lean();
      return res.status(200).json({ status: 200, data });
    } catch (e) { return fail(res, e, "transactions"); }
  },

  // ---------------- PO requirements / issue / return ----------------
  requirements: async (req, res) => {
    try {
      const { search, view } = req.query; // view: open | short | complete | all
      const filter = { "accessories.0": { $exists: true } };
      // Closed POs are hidden unless they still hold a reservation (e.g. a cancel whose release failed).
      if (view !== "all") filter.$and = [{ $or: [{ status: { $in: ["Pending", "PendingPpc", "PendingSalesConfirm", "Approved"] } }, { "accessories.reservedQty": { $gt: 0 } }] }];
      if (search) {
        const rx = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ poNumber: rx }, { modelName: rx }, { "raisedBy.name": rx }, { "accessories.name": rx }];
      }
      const pos = await PurchaseOrder.find(filter)
        .select("poNumber status raisedBy.name deviceCategory modelName requiredQuantity accessories fulfilment.state fulfilment.processId createdAt")
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();
      let data = pos.map((po) => {
        const lines = (po.accessories || []).map((l) => ({
          ...l,
          netIssued: (l.issuedQty || 0) - (l.returnedQty || 0),
          pending: poAcc.netNeed(l),
          short: l.trackStock ? Math.max(0, poAcc.netNeed(l) - (l.reservedQty || 0)) : 0,
        }));
        const complete = lines.every((l) => l.pending === 0);
        const short = lines.some((l) => l.short > 0);
        // Holding more than it should: any reservation on a non-Approved PO, or above what an Approved one still needs.
        const outOfSync = lines.some((l) => l.trackStock && (l.reservedQty || 0) > (po.status === "Approved" ? l.pending : 0));
        return { ...po, accessories: lines, complete, short, outOfSync };
      });
      if (view === "short") data = data.filter((p) => p.short && p.status === "Approved");
      if (view === "complete") data = data.filter((p) => p.complete);
      if (view === "open" || !view) data = data.filter((p) => !p.complete || p.outOfSync);
      return res.status(200).json({ status: 200, data });
    } catch (e) { return fail(res, e, "requirements"); }
  },

  issue: async (req, res) => {
    try {
      if (!isId(req.params.poId)) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      const { items, refNo, remarks } = req.body || {};
      const po = await poAcc.issueForPo(req.params.poId, items, { refNo: String(refNo || "").trim(), remarks: String(remarks || "").trim(), user: req.user });
      return res.status(200).json({ status: 200, message: "Accessories issued.", data: po });
    } catch (e) { return fail(res, e, "issue"); }
  },

  returnItems: async (req, res) => {
    try {
      if (!isId(req.params.poId)) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      const { items, refNo, remarks } = req.body || {};
      const po = await poAcc.returnForPo(req.params.poId, items, { refNo: String(refNo || "").trim(), remarks: String(remarks || "").trim(), user: req.user });
      return res.status(200).json({ status: 200, message: "Accessories returned to store.", data: po });
    } catch (e) { return fail(res, e, "return"); }
  },

  /**
   * GET /accessories-requirements/by-process/:processId — the accessory lines
   * of the PO a Process was created from (read-only; for the planning view).
   */
  byProcess: async (req, res) => {
    try {
      if (!isId(req.params.processId)) return res.status(404).json({ status: 404, message: "Process not found." });
      const po = await PurchaseOrder.findOne({ "fulfilment.processId": req.params.processId })
        .select("poNumber status requiredQuantity accessories")
        .lean();
      if (!po) return res.status(200).json({ status: 200, data: null });
      const accDocs = await Accessory.find({ _id: { $in: (po.accessories || []).map((l) => l.accessoryId) } })
        .select("serialized serialMode serialSource serialFormat.prefix").lean();
      const accById = new Map(accDocs.map((d) => [String(d._id), d]));
      const formats = await require("../models/ProcessAccessorySerialFormat")
        .find({ processId: req.params.processId }).select("accessoryId prefix suffix enableZero noOfZeroRequired generatedCount").lean();
      const fmtById = new Map(formats.map((f) => [String(f.accessoryId), f]));
      const lines = (po.accessories || []).map((l) => ({
        processFormat: fmtById.get(String(l.accessoryId)) || null,
        ...l,
        serialized: !!accById.get(String(l.accessoryId))?.serialized,
        serialMode: accById.get(String(l.accessoryId))?.serialMode || (accById.get(String(l.accessoryId))?.serialized ? "global" : "none"),
        serialSource: accById.get(String(l.accessoryId))?.serialSource || "",
        serialPrefix: accById.get(String(l.accessoryId))?.serialFormat?.prefix || "",
        netIssued: (l.issuedQty || 0) - (l.returnedQty || 0),
        pending: poAcc.netNeed(l),
        short: l.trackStock ? Math.max(0, poAcc.netNeed(l) - (l.reservedQty || 0)) : 0,
      }));
      return res.status(200).json({ status: 200, data: { poId: po._id, poNumber: po.poNumber, status: po.status, requiredQuantity: po.requiredQuantity, accessories: lines } });
    } catch (e) { return fail(res, e, "byProcess"); }
  },

  // ---------------- Serials ----------------
  generateSerials: async (req, res) => {
    try {
      const serials = await serialSvc.generate(req.params.id, req.body?.qty, { grnRef: String(req.body?.grnRef || "").trim(), user: req.user });
      return res.status(201).json({ status: 201, message: `${serials.length} serial(s) generated and received.`, data: serials });
    } catch (e) { return fail(res, e, "generateSerials"); }
  },

  importSerials: async (req, res) => {
    try {
      const serials = await serialSvc.importSupplier(req.params.id, req.body?.serials, { grnRef: String(req.body?.grnRef || "").trim(), user: req.user });
      return res.status(201).json({ status: 201, message: `${serials.length} serial(s) imported and received.`, data: serials });
    } catch (e) { return fail(res, e, "importSerials"); }
  },

  listSerials: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ status: 404, message: "Accessory not found." });
      const data = await serialSvc.listForAccessory(req.params.id, { status: req.query.status, search: req.query.search, limit: req.query.limit });
      return res.status(200).json({ status: 200, data });
    } catch (e) { return fail(res, e, "listSerials"); }
  },

  previewSerial: async (req, res) => {
    try {
      const f = { prefix: String(req.query.prefix || "").toUpperCase(), dateToken: req.query.dateToken, padding: Number(req.query.padding) || 6, suffix: String(req.query.suffix || "").toUpperCase() };
      return res.status(200).json({ status: 200, data: serialSvc.formatSerial(f, 1) });
    } catch (e) { return fail(res, e, "previewSerial"); }
  },

  scrapSerial: async (req, res) => {
    try {
      const doc = await serialSvc.scrap(req.params.serialNo, req.body?.reason, { user: req.user });
      return res.status(200).json({ status: 200, message: `${doc.serialNo} scrapped.`, data: doc });
    } catch (e) { return fail(res, e, "scrapSerial"); }
  },

  lookupSerial: async (req, res) => {
    try {
      const data = await serialSvc.lookup(req.params.serialNo);
      if (!data) return res.status(404).json({ status: 404, message: "No accessory with that serial." });
      return res.status(200).json({ status: 200, data });
    } catch (e) { return fail(res, e, "lookupSerial"); }
  },

  // ---------------- Per-process serials (like device serials) ----------------
  processSerialSummary: async (req, res) => {
    try {
      return res.status(200).json({ status: 200, data: await ppSerial.summary(req.params.processId, req.params.accessoryId) });
    } catch (e) { return fail(res, e, "processSerialSummary"); }
  },

  processSerialLast: async (req, res) => {
    try {
      return res.status(200).json({ status: 200, data: await ppSerial.lastSerial(String(req.query.prefix || ""), String(req.query.suffix || "")) });
    } catch (e) { return fail(res, e, "processSerialLast"); }
  },

  processSerialSaveFormat: async (req, res) => {
    try {
      const data = await ppSerial.saveFormat(req.params.processId, req.params.accessoryId, req.body || {}, { user: req.user });
      return res.status(200).json({ status: 200, message: "Serial format saved for this process.", data });
    } catch (e) { return fail(res, e, "processSerialSaveFormat"); }
  },

  processSerialGenerate: async (req, res) => {
    try {
      const r = await ppSerial.generate(req.params.processId, req.params.accessoryId, req.body || {}, { user: req.user });
      return res.status(201).json({
        status: 201,
        message: `${r.serials.length} serial(s) generated${r.labelledExisting ? ` — ${r.labelledExisting} for units already issued` : ""}${r.issuedFromStock ? `, ${r.issuedFromStock} issued from stock` : ""}.`,
        data: r,
      });
    } catch (e) { return fail(res, e, "processSerialGenerate"); }
  },

  /** POST /accessory-serials/by-devices { serials: [...] } — accessories packed with each device. */
  byDevices: async (req, res) => {
    try {
      return res.status(200).json({ status: 200, data: await serialSvc.byDeviceSerials(req.body?.serials) });
    } catch (e) { return fail(res, e, "byDevices"); }
  },

  // ---------------- Packaging (operator) ----------------
  deviceChecklist: async (req, res) => {
    try {
      if (!isId(req.params.deviceId)) return res.status(404).json({ status: 404, message: "Device not found." });
      return res.status(200).json({ status: 200, data: await serialSvc.checklistForDevice(req.params.deviceId) });
    } catch (e) { return fail(res, e, "deviceChecklist"); }
  },

  linkDeviceAccessory: async (req, res) => {
    try {
      const data = await serialSvc.linkToDevice(req.params.deviceId, req.body?.serialNo, { user: req.user });
      return res.status(200).json({ status: 200, message: "Accessory linked.", data });
    } catch (e) { return fail(res, e, "linkDeviceAccessory"); }
  },

  unlinkDeviceAccessory: async (req, res) => {
    try {
      if (!isId(req.params.deviceId)) return res.status(404).json({ status: 404, message: "Device not found." });
      const data = await serialSvc.unlinkFromDevice(req.params.deviceId, req.body?.serialNo, req.body?.reason, { user: req.user });
      return res.status(200).json({ status: 200, message: "Accessory removed from device.", data });
    } catch (e) { return fail(res, e, "unlinkDeviceAccessory"); }
  },

  /** Re-run the reservation for one PO (e.g. after new stock arrived). */
  reserve: async (req, res) => {
    try {
      if (!isId(req.params.poId)) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      const notes = await poAcc.syncReservations(req.params.poId, req.user);
      const po = await PurchaseOrder.findById(req.params.poId).lean();
      return res.status(200).json({ status: 200, message: notes.length ? `Reserved what was available — ${notes.join(", ")}.` : "Reservation up to date.", data: po });
    } catch (e) { return fail(res, e, "reserve"); }
  },
};
