/**
 * Serialized accessories: generation/import at receipt, serial-level issue
 * and return against a PO, and linking a serial to a device at packaging.
 *
 * AccessorySerial is the source of truth for which device a unit belongs to;
 * device.accessories is a denormalized copy for lookup/stickers. Every claim
 * is a single conditional findOneAndUpdate, so the same serial can never be
 * issued, linked or returned twice by concurrent requests. Stock counts still
 * move through accessoryStockService (onHand stays equal to IN_STOCK serials).
 */
const mongoose = require("mongoose");
const Accessory = require("../models/Accessory");
const AccessorySerial = require("../models/AccessorySerial");
const AccessoryStock = require("../models/AccessoryStock");
const AccessoryTransaction = require("../models/AccessoryTransaction");
const PurchaseOrder = require("../models/PurchaseOrder");
const Sequence = require("../models/Sequence");
const Device = require("../models/device");
const { httpError } = require("./accessoryStockService");

const MAX_BATCH = 5000;

// config/db.js runs with autoIndex:false, so schema indexes are never built
// automatically — build the ones this feature relies on (serial uniqueness,
// one stock bucket per accessory, Process→PO lookup) once per process.
let indexesReady = null;
function ensureIndexes() {
  if (!indexesReady) {
    indexesReady = Promise.all([
      AccessorySerial.createIndexes(),
      AccessoryStock.createIndexes(),
      AccessoryTransaction.createIndexes(),
      Accessory.createIndexes(),
      PurchaseOrder.collection.createIndex({ "fulfilment.processId": 1 }),
    ]).catch((e) => {
      indexesReady = null; // retry next call
      console.error("accessory ensureIndexes error:", e.message);
      throw httpError(500, "Could not prepare accessory serial indexes.");
    });
  }
  return indexesReady;
}

const actor = (user) => ({ by: user?._id || null, byName: user?.name || user?.email || "" });
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normSerial = (s) => String(s || "").trim();

/**
 * Find a serial as scanned: exact match first, then ignoring case (scanners
 * with Caps Lock / a different layout send lowercase). Returns the doc (with
 * its real serialNo) or null.
 */
async function findSerial(raw, filter = {}) {
  const serialNo = normSerial(raw);
  if (!serialNo) return null;
  const exact = await AccessorySerial.findOne({ ...filter, serialNo }).lean();
  if (exact) return exact;
  const rx = new RegExp(`^${escapeRegex(serialNo)}$`, "i");
  return AccessorySerial.findOne({ ...filter, serialNo: rx }).lean();
}

function datePart(token, d = new Date()) {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  if (token === "YYYYMM") return yyyy + mm;
  if (token === "YYMM") return yyyy.slice(2) + mm;
  return "";
}

/** Preview/format one generated serial. */
function formatSerial(fmt = {}, n, d = new Date()) {
  const pad = Math.min(10, Math.max(3, Number(fmt.padding) || 6));
  return `${fmt.prefix || ""}${datePart(fmt.dateToken || "YYMM", d)}${String(n).padStart(pad, "0")}${fmt.suffix || ""}`;
}

async function loadSerializedAccessory(accessoryId) {
  if (!mongoose.isValidObjectId(accessoryId)) throw httpError(404, "Accessory not found.");
  const a = await Accessory.findById(accessoryId).lean();
  if (!a) throw httpError(404, "Accessory not found.");
  if (!a.serialized) throw httpError(409, `"${a.name}" is not a serialized accessory.`);
  return a;
}

/** Refuse serials that already exist as an accessory serial or a device serial. */
async function assertFreeSerials(serials) {
  const [accHits, devHits] = await Promise.all([
    AccessorySerial.find({ serialNo: { $in: serials } }).select("serialNo").lean(),
    Device.find({ serialNo: { $in: serials } }).select("serialNo").lean(),
  ]);
  const clash = [...accHits.map((x) => x.serialNo), ...devHits.map((x) => `${x.serialNo} (device)`)];
  if (clash.length) {
    throw httpError(409, `${clash.length} serial(s) already exist: ${clash.slice(0, 10).join(", ")}${clash.length > 10 ? "…" : ""}`);
  }
}

async function insertSerials(a, serials, source, { grnRef = "", user } = {}) {
  const now = new Date();
  const docs = serials.map((serialNo) => ({
    serialNo, accessoryId: a._id, code: a.code, name: a.name, status: "IN_STOCK", source, grnRef,
    history: [{ action: "RECEIVED", toStatus: "IN_STOCK", remarks: grnRef ? `GRN ${grnRef}` : "", ...actor(user), at: now }],
    createdAt: now, updatedAt: now,
  }));
  try {
    await AccessorySerial.insertMany(docs, { ordered: true });
  } catch (e) {
    if (e?.code === 11000) throw httpError(409, "Some serials already exist — nothing was received. Refresh and try again.");
    throw e;
  }
}

/** Generate `qty` new serials from the accessory's format and receive them into stock. */
async function generate(accessoryId, qty, { grnRef = "", user } = {}) {
  await ensureIndexes();
  const a = await loadSerializedAccessory(accessoryId);
  if (a.serialSource !== "generated") throw httpError(409, `"${a.name}" uses supplier serials — import them instead.`);
  if (!String(a.serialFormat?.prefix || "").trim()) throw httpError(400, `Set a serial prefix for "${a.name}" first.`);
  const q = Number(qty);
  if (!Number.isInteger(q) || q < 1 || q > MAX_BATCH) throw httpError(400, `Quantity must be 1–${MAX_BATCH}.`);

  // Reserve a contiguous block of numbers atomically (concurrent generations never overlap).
  const seq = await Sequence.findOneAndUpdate({ name: `acc_serial_${a._id}` }, { $inc: { value: q } }, { new: true, upsert: true });
  const start = seq.value - q + 1;
  const now = new Date();
  const serials = Array.from({ length: q }, (_, i) => formatSerial(a.serialFormat, start + i, now));
  await assertFreeSerials(serials);
  await insertSerials(a, serials, "generated", { grnRef, user });
  const stock = require("./accessoryStockService");
  try {
    await stock.receive(a._id, q, { refNo: grnRef, remarks: `Generated ${serials[0]} … ${serials[serials.length - 1]}`, user });
  } catch (e) {
    // Serials without matching stock would break "IN_STOCK serials = on hand".
    await AccessorySerial.deleteMany({ serialNo: { $in: serials }, accessoryId: a._id, status: "IN_STOCK" }).catch(() => {});
    throw e;
  }
  return serials;
}

/** Import supplier serials (one unit each) and receive them into stock. */
async function importSupplier(accessoryId, rawSerials, { grnRef = "", user } = {}) {
  await ensureIndexes();
  const a = await loadSerializedAccessory(accessoryId);
  const serials = [...new Set((Array.isArray(rawSerials) ? rawSerials : []).map(normSerial).filter(Boolean))];
  if (!serials.length) throw httpError(400, "No serials to import.");
  if (serials.length > MAX_BATCH) throw httpError(400, `At most ${MAX_BATCH} serials per import.`);
  if (serials.some((s) => s.length > 64 || /\s/.test(s))) throw httpError(400, "Serials can't contain spaces or be longer than 64 characters.");
  await assertFreeSerials(serials);
  await insertSerials(a, serials, "supplier", { grnRef, user });
  const stock = require("./accessoryStockService");
  try {
    await stock.receive(a._id, serials.length, { refNo: grnRef, remarks: `Imported ${serials.length} supplier serial(s)`, user });
  } catch (e) {
    await AccessorySerial.deleteMany({ serialNo: { $in: serials }, accessoryId: a._id, status: "IN_STOCK" }).catch(() => {});
    throw e;
  }
  return serials;
}

/**
 * Claim `qty` IN_STOCK serials (oldest first, or the given ones) as ISSUED to
 * a PO. All-or-nothing: on a shortfall the claimed ones are put back.
 */
async function claimForIssue(accessoryId, po, qty, { serials = null, user } = {}) {
  await ensureIndexes();
  const claimed = [];
  const set = { status: "ISSUED", poId: po._id, poNumber: po.poNumber || "", processId: po.fulfilment?.processId || null, updatedAt: new Date() };
  const hist = { action: "ISSUED", fromStatus: "IN_STOCK", toStatus: "ISSUED", poNumber: po.poNumber || "", ...actor(user), at: new Date() };
  const claimOne = (filter) =>
    AccessorySerial.findOneAndUpdate({ ...filter, accessoryId, status: "IN_STOCK" }, { $set: set, $push: { history: hist } }, { new: true, sort: { createdAt: 1 } }).lean();

  if (Array.isArray(serials) && serials.length) {
    const wanted = [...new Set(serials.map(normSerial).filter(Boolean))];
    if (wanted.length !== qty) throw httpError(400, `Scan exactly ${qty} serial(s) (got ${wanted.length}).`);
    for (const raw of wanted) {
      const found = await findSerial(raw, { accessoryId });
      const s = found ? found.serialNo : raw;
      const doc = await claimOne({ serialNo: s });
      if (!doc) { await putBack(claimed, user); throw httpError(409, `Serial ${s} is not in stock for this accessory.`); }
      claimed.push(doc);
    }
  } else {
    for (let i = 0; i < qty; i += 1) {
      const doc = await claimOne({});
      if (!doc) { await putBack(claimed, user); throw httpError(409, `Only ${claimed.length} serial(s) in stock — ${qty} needed.`); }
      claimed.push(doc);
    }
  }
  return claimed;
}

async function putBack(claimed, user) {
  if (!claimed.length) return;
  await AccessorySerial.updateMany(
    { _id: { $in: claimed.map((c) => c._id) }, status: "ISSUED" },
    { $set: { status: "IN_STOCK", poId: null, poNumber: "", processId: null, updatedAt: new Date() }, $push: { history: { action: "RETURNED", fromStatus: "ISSUED", toStatus: "IN_STOCK", remarks: "Issue rolled back", ...actor(user), at: new Date() } } }
  );
}

/** Return `qty` ISSUED (not device-linked) serials of a PO back to IN_STOCK, newest first. */
async function returnFromPo(accessoryId, po, qty, { user } = {}) {
  const hist = { action: "RETURNED", fromStatus: "ISSUED", toStatus: "IN_STOCK", poNumber: po.poNumber || "", ...actor(user), at: new Date() };
  const done = [];
  for (let i = 0; i < qty; i += 1) {
    const doc = await AccessorySerial.findOneAndUpdate(
      { accessoryId, poId: po._id, status: "ISSUED", deviceId: null },
      { $set: { status: "IN_STOCK", poId: null, poNumber: "", processId: null, updatedAt: new Date() }, $push: { history: hist } },
      { new: true, sort: { updatedAt: -1 } }
    ).lean();
    if (!doc) break;
    done.push(doc);
  }
  if (done.length < qty) {
    // undo — a partial return would desync the stock count
    await AccessorySerial.updateMany(
      { _id: { $in: done.map((d) => d._id) } },
      { $set: { status: "ISSUED", poId: po._id, poNumber: po.poNumber || "", processId: po.fulfilment?.processId || null } }
    );
    throw httpError(400, `Only ${done.length} unlinked serial(s) of this accessory can be returned — unlink them from devices first.`);
  }
  return done;
}

/** Undo returnFromPo (the request it belonged to failed): the serials go back to the PO. */
async function undoReturnFromPo(done, po) {
  if (!done || !done.length) return;
  await AccessorySerial.updateMany(
    { _id: { $in: done.map((d) => d._id) }, status: "IN_STOCK" },
    { $set: { status: "ISSUED", poId: po._id, poNumber: po.poNumber || "", processId: po.fulfilment?.processId || null, updatedAt: new Date() }, $pop: { history: 1 } }
  );
}

/** Scrap one IN_STOCK serial (damaged/lost) — also takes it out of stock. */
async function scrap(serialNo, reason, { user } = {}) {
  if (!String(reason || "").trim()) throw httpError(400, "A reason is required to scrap a serial.");
  const found = await findSerial(serialNo);
  const doc = await AccessorySerial.findOneAndUpdate(
    { serialNo: found ? found.serialNo : normSerial(serialNo), status: "IN_STOCK" },
    { $set: { status: "SCRAPPED", updatedAt: new Date() }, $push: { history: { action: "SCRAPPED", fromStatus: "IN_STOCK", toStatus: "SCRAPPED", remarks: reason, ...actor(user), at: new Date() } } },
    { new: true }
  ).lean();
  if (!doc) throw httpError(409, "Only an in-stock serial can be scrapped.");
  const stock = require("./accessoryStockService");
  try {
    await stock.adjust(doc.accessoryId, -1, { remarks: `Scrapped ${doc.serialNo}: ${reason}`, user });
  } catch (e) {
    await AccessorySerial.updateOne({ _id: doc._id }, { $set: { status: "IN_STOCK" }, $pop: { history: 1 } });
    throw e;
  }
  return doc;
}

// ---------------- Packaging: device ↔ serial ----------------

async function poForProcess(processId) {
  if (!processId) return null;
  return PurchaseOrder.findOne({ "fulfilment.processId": processId }).select("poNumber accessories fulfilment.processId").lean();
}

/**
 * What a device must carry: one slot per unit of each SERIALIZED per-device
 * accessory on its PO (qtyPerUnit), with the serials already linked.
 */
async function checklistForDevice(deviceOrId) {
  // A loaded device doc vs an id. (An ObjectId also has an `_id` getter that
  // returns itself, so `x._id` alone can't tell them apart.)
  const isDoc =
    deviceOrId && typeof deviceOrId === "object" && !(deviceOrId instanceof mongoose.Types.ObjectId) && ("processID" in deviceOrId || "serialNo" in deviceOrId);
  const device = isDoc ? deviceOrId : await Device.findById(deviceOrId).select("serialNo processID").lean();
  if (!device) throw httpError(404, "Device not found.");
  const po = await poForProcess(device.processID);
  const lines = (po?.accessories || []).filter((l) => l.qtyMode === "per_device" && (l.qtyPerUnit || 0) > 0);
  const accs = lines.length
    ? await Accessory.find({ _id: { $in: lines.map((l) => l.accessoryId) }, $or: [{ serialized: true }, { serialMode: "per_process" }] }).select("_id serialMode").lean()
    : [];
  const serializedIds = new Set(accs.map((a) => String(a._id)));
  const perProcessIds = new Set(accs.filter((a) => a.serialMode === "per_process").map((a) => String(a._id)));
  // An accessory made serialized AFTER this PO's units were already issued
  // count-only has no serials to scan for this PO — don't demand them (the
  // devices would be unpackable). Only lines issued as serials, or not yet
  // issued at all, need scanning.
  const serialCounts = po && serializedIds.size
    ? await AccessorySerial.aggregate([
        { $match: { poId: po._id, accessoryId: { $in: [...serializedIds].map((id) => new mongoose.Types.ObjectId(id)) }, status: { $in: ["ISSUED", "LINKED", "DISPATCHED"] } } },
        { $group: { _id: "$accessoryId", n: { $sum: 1 } } },
      ])
    : [];
  const serialIssued = new Map(serialCounts.map((x) => [String(x._id), x.n]));
  const needsScan = (l) => {
    const id = String(l.accessoryId);
    if (!serializedIds.has(id)) return false;
    // Per-process serials belong to one process: only a PO whose process has
    // serials for this accessory scans them (setting a format for one process
    // must not suddenly block packing on every other PO).
    if (perProcessIds.has(id)) return (serialIssued.get(id) || 0) > 0;
    const issued = (l.issuedQty || 0) - (l.returnedQty || 0);
    return issued <= 0 || (serialIssued.get(id) || 0) > 0;
  };
  const linked = await AccessorySerial.find({ deviceId: device._id, status: { $in: ["LINKED", "DISPATCHED"] } }).select("serialNo accessoryId").lean();
  const items = lines
    .filter(needsScan)
    .map((l) => {
      const mine = linked.filter((s) => String(s.accessoryId) === String(l.accessoryId)).map((s) => s.serialNo);
      return { accessoryId: String(l.accessoryId), code: l.code, name: l.name, need: l.qtyPerUnit, linked: mine, remaining: Math.max(0, l.qtyPerUnit - mine.length) };
    });
  return {
    deviceId: String(device._id),
    deviceSerial: device.serialNo,
    poId: po ? String(po._id) : null,
    poNumber: po?.poNumber || "",
    items,
    required: items.length > 0,
    complete: items.every((i) => i.remaining === 0),
    // Same rule the packing guard applies — the operator screen gates on this.
    enforce: items.length > 0 ? await require("./accessoryPackingRule").requiresScanForProcess(device.processID) : false,
  };
}

async function syncDeviceCopy(deviceId) {
  const serials = await AccessorySerial.find({ deviceId, status: { $in: ["LINKED", "DISPATCHED"] } })
    .select("accessoryId code name serialNo updatedAt").sort({ updatedAt: 1 }).lean();
  await Device.updateOne(
    { _id: deviceId },
    serials.length
      ? { $set: { accessories: serials.map((s) => ({ accessoryId: s.accessoryId, code: s.code, name: s.name, serialNo: s.serialNo, linkedAt: s.updatedAt })) } }
      : { $unset: { accessories: "" } }
  );
}

/** Scan a serial onto a device (packaging). */
async function linkToDevice(deviceId, rawSerial, { user } = {}) {
  await ensureIndexes();
  let serialNo = normSerial(rawSerial);
  if (!serialNo) throw httpError(400, "Scan an accessory serial.");
  if (!mongoose.isValidObjectId(deviceId)) throw httpError(404, "Device not found.");
  const device = await Device.findById(deviceId).select("serialNo processID status dispatchStatus").lean();
  if (!device) throw httpError(404, "Device not found.");
  if (["RESERVED", "DISPATCHED"].includes(device.dispatchStatus)) {
    throw httpError(409, `${device.serialNo} is ${device.dispatchStatus.toLowerCase()} for dispatch — accessories can't be added now.`);
  }
  if (String(device.status || "").toUpperCase() === "NG") {
    throw httpError(409, `${device.serialNo} is marked NG — accessories can't be packed with it.`);
  }

  const unit = await findSerial(serialNo);
  if (!unit) {
    const isDevice = await Device.exists({ serialNo });
    throw httpError(404, isDevice ? `${serialNo} is a device serial, not an accessory serial.` : `${serialNo} is not a known accessory serial.`);
  }
  serialNo = unit.serialNo; // canonical spelling
  if (unit.deviceId && String(unit.deviceId) === String(device._id)) throw httpError(409, `${serialNo} is already linked to this device.`);
  if (unit.deviceId || unit.status === "LINKED" || unit.status === "DISPATCHED") {
    throw httpError(409, `${serialNo} (${unit.name}) is already linked to device ${unit.deviceSerial || ""}.`);
  }
  const checklist = await checklistForDevice(device);
  const item = checklist.items.find((i) => i.accessoryId === String(unit.accessoryId));
  if (!item) throw httpError(400, `${unit.name} is not required for this device's PO.`);
  if (item.remaining < 1) throw httpError(409, `${unit.name}: all ${item.need} already scanned for this device.`);
  if (unit.status === "ISSUED" && unit.poId && String(unit.poId) !== String(checklist.poId)) {
    throw httpError(409, `${serialNo} belongs to ${unit.poNumber || "another PO"} (another process) — scan a serial generated for ${checklist.poNumber || "this process"}.`);
  }
  if (unit.status !== "ISSUED" || String(unit.poId) !== String(checklist.poId)) {
    throw httpError(409, `${serialNo} hasn't been issued to ${checklist.poNumber || "this PO"} — issue it from the store first.`);
  }

  const claimed = await AccessorySerial.findOneAndUpdate(
    { _id: unit._id, status: "ISSUED", poId: unit.poId, deviceId: null },
    {
      $set: { status: "LINKED", deviceId: device._id, deviceSerial: device.serialNo, updatedAt: new Date() },
      $push: { history: { action: "LINKED", fromStatus: "ISSUED", toStatus: "LINKED", poNumber: unit.poNumber, deviceSerial: device.serialNo, ...actor(user), at: new Date() } },
    },
    { new: true }
  ).lean();
  if (!claimed) throw httpError(409, `${serialNo} was just used elsewhere — scan another.`);

  // Two different serials racing for the last slot: re-count, undo the loser.
  const count = await AccessorySerial.countDocuments({ deviceId: device._id, accessoryId: unit.accessoryId, status: "LINKED" });
  if (count > item.need) {
    await AccessorySerial.updateOne({ _id: claimed._id }, { $set: { status: "ISSUED", deviceId: null, deviceSerial: "" }, $pop: { history: 1 } });
    throw httpError(409, `${unit.name}: all ${item.need} already scanned for this device.`);
  }
  await syncDeviceCopy(device._id);
  return checklistForDevice(device);
}

/** Take a serial back off a device (wrong scan / replacement) — reason required. */
async function unlinkFromDevice(deviceId, rawSerial, reason, { user } = {}) {
  if (!String(reason || "").trim()) throw httpError(400, "A reason is required to remove an accessory from a device.");
  const scanned = normSerial(rawSerial);
  const found = await findSerial(scanned, { deviceId });
  const serialNo = found ? found.serialNo : scanned;
  // Once the device is in a carton or on an invoice its accessories are sealed
  // with it — removing one here would ship the device without it.
  const device = mongoose.isValidObjectId(deviceId)
    ? await Device.findById(deviceId).select("serialNo cartonSerial dispatchStatus").lean()
    : null;
  if (device && ["RESERVED", "DISPATCHED"].includes(device.dispatchStatus)) {
    throw httpError(409, `${device.serialNo} is ${device.dispatchStatus.toLowerCase()} for dispatch — its accessories can't be removed.`);
  }
  if (device && device.cartonSerial) {
    throw httpError(409, `${device.serialNo} is packed in carton ${device.cartonSerial} — remove it from the carton first, then change its accessories.`);
  }
  const doc = await AccessorySerial.findOneAndUpdate(
    { serialNo, deviceId, status: "LINKED" },
    {
      $set: { status: "ISSUED", deviceId: null, deviceSerial: "", updatedAt: new Date() },
      $push: { history: { action: "UNLINKED", fromStatus: "LINKED", toStatus: "ISSUED", remarks: reason, ...actor(user), at: new Date() } },
    },
    { new: true }
  ).lean();
  if (!doc) throw httpError(409, `${serialNo} is not linked to this device (or has already been dispatched).`);
  await syncDeviceCopy(deviceId);
  return checklistForDevice(deviceId);
}

/** Packing guard: devices whose checklist isn't complete (only for steps that require the scan). */
async function incompleteDevices(deviceIds) {
  const out = [];
  for (const id of deviceIds) {
    const c = await checklistForDevice(id);
    if (c.required && !c.complete) out.push({ deviceSerial: c.deviceSerial, missing: c.items.filter((i) => i.remaining > 0).map((i) => `${i.name} × ${i.remaining}`) });
  }
  return out;
}

/** Device deleted: its linked serials go back to ISSUED on their PO (not lost). */
async function releaseForDeletedDevices(deviceIds, { user, reason = "Device deleted" } = {}) {
  if (!deviceIds.length) return 0;
  const r = await AccessorySerial.updateMany(
    { deviceId: { $in: deviceIds }, status: "LINKED" },
    { $set: { status: "ISSUED", deviceId: null, deviceSerial: "", updatedAt: new Date() }, $push: { history: { action: "RELEASED", fromStatus: "LINKED", toStatus: "ISSUED", remarks: reason, ...actor(user), at: new Date() } } }
  );
  return r.modifiedCount || 0;
}

/** Any of these devices carrying linked accessories (kit-transfer guard). */
async function devicesWithLinkedAccessories(deviceIds) {
  if (!deviceIds.length) return [];
  return AccessorySerial.distinct("deviceSerial", { deviceId: { $in: deviceIds }, status: "LINKED" });
}

/** Dispatch confirmed: mark linked serials DISPATCHED with their carton snapshot (retried per device). */
async function markDispatched(devices, { user } = {}) {
  let n = 0;
  const failed = [];
  for (const d of devices) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const r = await AccessorySerial.updateMany(
          { deviceId: d._id, status: "LINKED" },
          { $set: { status: "DISPATCHED", dispatchedCartonSerial: d.cartonSerial || "", updatedAt: new Date() }, $push: { history: { action: "DISPATCHED", fromStatus: "LINKED", toStatus: "DISPATCHED", deviceSerial: d.serialNo || "", ...actor(user), at: new Date() } } }
        );
        n += r.modifiedCount || 0;
        break;
      } catch (e) {
        if (attempt >= 2) { failed.push(d.serialNo || String(d._id)); break; }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  if (failed.length) console.error(`markDispatched: accessory serials of ${failed.length} device(s) left LINKED (reconciled on the next dispatch): ${failed.slice(0, 20).join(", ")}`);
  return n;
}

/**
 * Safety net: serials still LINKED to a device that has already been
 * dispatched (an earlier markDispatched failed) are marked DISPATCHED.
 */
async function reconcileDispatched({ user } = {}) {
  const deviceIds = await AccessorySerial.distinct("deviceId", { status: "LINKED" });
  if (!deviceIds.length) return 0;
  const shipped = await Device.find({ _id: { $in: deviceIds }, dispatchStatus: "DISPATCHED" }).select("_id serialNo cartonSerial").lean();
  return shipped.length ? markDispatched(shipped, { user }) : 0;
}

/** Linked accessory serials per device id, from the source of truth (dispatch snapshot). */
async function linkedByDeviceIds(deviceIds) {
  const rows = deviceIds.length
    ? await AccessorySerial.find({ deviceId: { $in: deviceIds }, status: { $in: ["LINKED", "DISPATCHED"] } }).select("deviceId code name serialNo").sort({ code: 1, serialNo: 1 }).lean()
    : [];
  const out = new Map();
  for (const r of rows) {
    const k = String(r.deviceId);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ code: r.code, name: r.name, serialNo: r.serialNo });
  }
  return out;
}

/**
 * Accessory serials packed with each of these devices, for history views:
 * { [deviceSerial]: [{ code, name, serialNo, status }] }. Source of truth is
 * AccessorySerial (LINKED/DISPATCHED); one indexed query for the whole page.
 */
async function byDeviceSerials(rawSerials) {
  await ensureIndexes();
  const serials = [...new Set((Array.isArray(rawSerials) ? rawSerials : []).map(normSerial).filter(Boolean))].slice(0, 2000);
  if (!serials.length) return {};
  const rows = await AccessorySerial.find({ deviceSerial: { $in: serials }, status: { $in: ["LINKED", "DISPATCHED"] } })
    .select("deviceSerial code name serialNo status").sort({ code: 1, serialNo: 1 }).lean();
  const out = {};
  for (const r of rows) (out[r.deviceSerial] = out[r.deviceSerial] || []).push({ code: r.code, name: r.name, serialNo: r.serialNo, status: r.status });
  return out;
}

/** Everything about one serial (Find Device / Accessory Stock). */
async function lookup(rawSerial) {
  const doc = await findSerial(rawSerial);
  if (!doc) return null;
  const device = doc.deviceId ? await Device.findById(doc.deviceId).select("serialNo imeiNo cartonSerial currentStage status processID").lean() : null;
  return { ...doc, device };
}

async function listForAccessory(accessoryId, { status, search, limit = 500 } = {}) {
  const filter = { accessoryId };
  if (status) filter.status = status;
  if (search) filter.serialNo = new RegExp(escapeRegex(search), "i");
  return AccessorySerial.find(filter).select("-history").sort({ createdAt: -1 }).limit(Math.min(2000, Number(limit) || 500)).lean();
}

module.exports = {
  ensureIndexes, formatSerial, generate, importSupplier, claimForIssue, putBack, returnFromPo, undoReturnFromPo, scrap,
  checklistForDevice, linkToDevice, unlinkFromDevice, incompleteDevices, releaseForDeletedDevices,
  devicesWithLinkedAccessories, markDispatched, reconcileDispatched, linkedByDeviceIds, lookup, listForAccessory, byDeviceSerials, findSerial,
};
