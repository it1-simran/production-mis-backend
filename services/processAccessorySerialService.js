/**
 * Per-process accessory serials (Accessory.serialMode "per_process") —
 * generated like device serials: prefix + optional zero-padded running number
 * + suffix, one format per (process, accessory), unique across processes.
 *
 * Stock stays count-only. Generating serials for a process LABELS the units
 * already issued to its PO (no stock movement); anything beyond that is
 * issued from stock in the same call. Serials are created ISSUED to the PO,
 * so at packaging a scan must be one of THIS process's serials.
 */
const mongoose = require("mongoose");
const Accessory = require("../models/Accessory");
const AccessorySerial = require("../models/AccessorySerial");
const ProcessAccessorySerialFormat = require("../models/ProcessAccessorySerialFormat");
const PurchaseOrder = require("../models/PurchaseOrder");
const Device = require("../models/device");
const { httpError } = require("./accessoryStockService");

const MAX_BATCH = 5000;
const LIVE = ["ISSUED", "LINKED", "DISPATCHED"];
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const actor = (user) => ({ by: user?._id || null, byName: user?.name || user?.email || "" });

let ready = null;
const ensureIndexes = () => {
  if (!ready) {
    ready = Promise.all([ProcessAccessorySerialFormat.createIndexes(), require("./accessorySerialService").ensureIndexes()]).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
};

const buildSerial = (f, n) =>
  `${f.prefix || ""}${f.enableZero ? String(n).padStart(Math.max(1, Number(f.noOfZeroRequired) || 1), "0") : String(n)}${f.suffix || ""}`;

/** Trailing running number of a serial for this prefix/suffix (like the device helper). */
function sequenceOf(serialNo, prefix, suffix) {
  let s = String(serialNo || "");
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  if (suffix && s.endsWith(suffix)) s = s.slice(0, s.length - suffix.length);
  const m = s.match(/\d+/g);
  return m ? parseInt(m[m.length - 1], 10) : -1;
}

/** Last accessory serial for a prefix/suffix (mirrors getLastEntryBasedOnPrefixAndSuffix). */
async function lastSerial(prefix = "", suffix = "") {
  // Exactly prefix + digits + suffix (".*" also matched longer prefixes and
  // global serials). Longest, then highest string = highest number.
  const rx = new RegExp(`^${escapeRegex(prefix)}[0-9]+${escapeRegex(suffix)}$`);
  const [top] = await AccessorySerial.aggregate([
    { $match: { serialNo: rx } },
    { $project: { serialNo: 1, len: { $strLenCP: "$serialNo" } } },
    { $sort: { len: -1, serialNo: -1 } },
    { $limit: 1 },
  ]);
  let best = top ? { serialNo: top.serialNo, number: sequenceOf(top.serialNo, prefix, suffix) } : null;
  // Numbers reserved by this format (incl. voided/rolled-back ones) are used too.
  const fmt = await ProcessAccessorySerialFormat.findOne({ prefix, suffix }).lean();
  if (fmt && (fmt.lastNumber || 0) > (best ? best.number : 0)) best = { serialNo: buildSerial(fmt, fmt.lastNumber), number: fmt.lastNumber };
  return best;
}

async function loadContext(processId, accessoryId) {
  if (!mongoose.isValidObjectId(processId) || !mongoose.isValidObjectId(accessoryId)) throw httpError(404, "Process or accessory not found.");
  const [po, accessory] = await Promise.all([
    PurchaseOrder.findOne({ "fulfilment.processId": processId }).select("poNumber status accessories requiredQuantity fulfilment.processId").lean(),
    Accessory.findById(accessoryId).lean(),
  ]);
  if (!accessory) throw httpError(404, "Accessory not found.");
  if (!po) throw httpError(404, "This process isn't linked to a Purchase Order.");
  const line = (po.accessories || []).find((l) => String(l.accessoryId) === String(accessoryId));
  if (!line) throw httpError(400, `${accessory.name} is not on ${po.poNumber}.`);
  const [format, live] = await Promise.all([
    ProcessAccessorySerialFormat.findOne({ processId, accessoryId }).lean(),
    AccessorySerial.countDocuments({ poId: po._id, accessoryId, status: { $in: LIVE } }),
  ]);
  const issuedNet = (line.issuedQty || 0) - (line.returnedQty || 0);
  return {
    po, accessory, line, format,
    serialsGenerated: live,
    issuedNet,
    unlabeled: Math.max(0, issuedNet - live), // issued units still without a serial
    capacity: Math.max(0, (line.requiredQty || 0) - live), // how many more serials this process can have
  };
}

/** Everything the "Generate Accessory Serials" screen needs. */
async function summary(processId, accessoryId) {
  await ensureIndexes();
  const ctx = await loadContext(processId, accessoryId);
  const serials = await AccessorySerial.find({ poId: ctx.po._id, accessoryId, processId })
    .select("serialNo status deviceSerial createdAt").sort({ createdAt: 1 }).limit(5000).lean();
  return {
    poNumber: ctx.po.poNumber,
    accessory: { _id: ctx.accessory._id, code: ctx.accessory.code, name: ctx.accessory.name, serialMode: ctx.accessory.serialMode || "none" },
    requiredQty: ctx.line.requiredQty || 0,
    issuedNet: ctx.issuedNet,
    serialsGenerated: ctx.serialsGenerated,
    unlabeled: ctx.unlabeled,
    capacity: ctx.capacity,
    format: ctx.format,
    serials,
  };
}

/**
 * Every accessory format makes serials "prefix + digits + suffix" (global
 * formats too: their date part is digits). Two formats can produce the SAME
 * serial when one prefix is the other plus only digits and likewise the
 * suffixes — e.g. "CH" and "CH1" ("CH1001" is CH#1001 and CH1#001).
 */
const digitsOnly = (x) => /^\d*$/.test(x);
function formatsOverlap(x, y) {
  const a = { prefix: String(x.prefix || "").toUpperCase(), suffix: String(x.suffix || "").toUpperCase() };
  const b = { prefix: String(y.prefix || "").toUpperCase(), suffix: String(y.suffix || "").toUpperCase() };
  const [p1, p2] = a.prefix.length <= b.prefix.length ? [a.prefix, b.prefix] : [b.prefix, a.prefix];
  if (!p2.startsWith(p1) || !digitsOnly(p2.slice(p1.length))) return false;
  const [s1, s2] = a.suffix.length <= b.suffix.length ? [a.suffix, b.suffix] : [b.suffix, a.suffix];
  return s2.endsWith(s1) && digitsOnly(s2.slice(0, s2.length - s1.length));
}

/**
 * Refuse a new format whose serials could collide with another process's
 * format or an accessory's global format. `self` excludes the format being
 * changed: { processId, accessoryId } for a process format, { globalAccessoryId } for a global one.
 */
async function assertNoFormatOverlap(fmt, self = {}) {
  const mine = { prefix: String(fmt.prefix || ""), suffix: String(fmt.suffix || "") };
  const [procFormats, globals] = await Promise.all([
    ProcessAccessorySerialFormat.find({}).select("prefix suffix processId accessoryId poNumber").lean(),
    Accessory.find({ serialized: true, serialSource: "generated" }).select("name serialFormat").lean(),
  ]);
  for (const f of procFormats) {
    if (self.processId && String(f.processId) === String(self.processId) && String(f.accessoryId) === String(self.accessoryId)) continue;
    if (formatsOverlap(mine, { prefix: f.prefix || "", suffix: f.suffix || "" })) {
      throw httpError(409, `"${mine.prefix}…${mine.suffix}" can produce the same serials as "${f.prefix}…${f.suffix}" (${f.poNumber || "another process"}) — choose a prefix that isn't the other one plus digits.`);
    }
  }
  for (const a of globals) {
    if (self.globalAccessoryId && String(a._id) === String(self.globalAccessoryId)) continue;
    const g = { prefix: a.serialFormat?.prefix || "", suffix: a.serialFormat?.suffix || "" };
    if (!g.prefix) continue;
    if (formatsOverlap(mine, g)) {
      throw httpError(409, `"${mine.prefix}…${mine.suffix}" can produce the same serials as ${a.name}'s serial format "${g.prefix}…${g.suffix}" — choose a different prefix.`);
    }
  }
}

/** Give back units issued for a failed generation; retried because the PO lock may be busy. */
async function returnWithRetry(poAcc, ctx, accessoryId, qty, user) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await poAcc.returnForPo(ctx.po._id, [{ accessoryId, qty }], { remarks: "Serial generation failed — rolled back", user });
    } catch (e) {
      if (e.status === 409 && attempt < 4) { await new Promise((r) => setTimeout(r, 400)); continue; }
      console.error(`per-process serial generation rollback failed for ${ctx.po.poNumber} (${qty} unit(s) of ${ctx.accessory.name} stay issued without serials — return them from PO Accessory Requirements):`, e.message);
      return null;
    }
  }
}

/** Validate prefix / suffix / zero padding from a request body. */
function readFormat(body = {}) {
  const prefix = String(body.prefix || "").trim();
  const suffix = String(body.suffix || "").trim();
  if (!prefix) throw httpError(400, "A prefix is required.");
  if (!/^[A-Za-z0-9\-_/]{1,20}$/.test(prefix) || (suffix && !/^[A-Za-z0-9\-_/]{1,12}$/.test(suffix))) {
    throw httpError(400, "Prefix/suffix may use letters, digits, - _ / (prefix up to 20, suffix up to 12).");
  }
  const enableZero = !!body.enableZero;
  const noOfZeroRequired = enableZero ? Number(body.noOfZeroRequired) : 0;
  if (enableZero && (!Number.isInteger(noOfZeroRequired) || noOfZeroRequired < 1 || noOfZeroRequired > 10)) throw httpError(400, "Number of digits must be 1-10.");
  return { prefix, suffix, enableZero, noOfZeroRequired };
}

/**
 * Setting a process format from the planning popup switches a count-only
 * accessory to per-process serials. One using a single global format can't be
 * switched here (its serials were made at receipt).
 */
async function ensurePerProcessMode(accessory) {
  const mode = accessory.serialMode || (accessory.serialized ? "global" : "none");
  if (mode === "per_process") return;
  if (mode === "global") throw httpError(409, `${accessory.name} uses one serial format for all processes (Accessory Master). Change its serial mode there to use per-process formats.`);
  await Accessory.updateOne({ _id: accessory._id }, { $set: { serialMode: "per_process", serialized: false, trackStock: true, updatedAt: new Date() } });
  accessory.serialMode = "per_process";
}

/** The prefix/suffix is fixed once this process has serials, and never shared with another process. */
async function assertFormatUsable(ctx, processId, accessoryId, prefix, suffix) {
  const lockedHere = ctx.format && (ctx.format.generatedCount || 0) > 0;
  if (lockedHere && (ctx.format.prefix !== prefix || ctx.format.suffix !== suffix)) {
    throw httpError(409, `This process already has serials "${ctx.format.prefix}…${ctx.format.suffix}" for ${ctx.accessory.name} — the prefix/suffix can't change now.`);
  }
  const clash = await ProcessAccessorySerialFormat.findOne({ prefix, suffix, $or: [{ processId: { $ne: processId } }, { accessoryId: { $ne: accessoryId } }] }).lean();
  if (clash) throw httpError(409, `Prefix/suffix "${prefix}…${suffix}" is already used by ${clash.poNumber || "another process"} — every process needs its own.`);
  // A format already in use here was checked when it was first used; only new/changed ones are.
  if (!lockedHere) await assertNoFormatOverlap({ prefix, suffix }, { processId, accessoryId });
}

/** Save (or change, until serials exist) this process's format without generating. */
async function saveFormat(processId, accessoryId, body = {}, { user } = {}) {
  await ensureIndexes();
  const ctx = await loadContext(processId, accessoryId);
  const fmt = readFormat(body);
  await assertFormatUsable(ctx, processId, accessoryId, fmt.prefix, fmt.suffix);
  await ensurePerProcessMode(ctx.accessory);
  const locked = ctx.format && (ctx.format.generatedCount || 0) > 0;
  try {
    return await ProcessAccessorySerialFormat.findOneAndUpdate(
      { processId, accessoryId },
      {
        $setOnInsert: { processId, accessoryId, poId: ctx.po._id, poNumber: ctx.po.poNumber, createdBy: user?._id || null, createdAt: new Date() },
        // Once serials exist only the display settings are left alone too — numbering must not change mid-way.
        $set: locked ? { updatedAt: new Date() } : { ...fmt, updatedAt: new Date() },
      },
      { upsert: true, new: true }
    ).lean();
  } catch (e) {
    if (e?.code === 11000) throw httpError(409, `Prefix/suffix "${fmt.prefix}…${fmt.suffix}" is already used by another process.`);
    throw e;
  }
}

/**
 * Generate `count` serials for a process: prefix + running number + suffix.
 * All-or-nothing; the format (prefix/suffix) is locked to the process after
 * the first generation and cannot be used by any other process.
 */
async function generate(processId, accessoryId, body = {}, { user } = {}) {
  await ensureIndexes();
  const ctx = await loadContext(processId, accessoryId);
  if (ctx.po.status !== "Approved") throw httpError(409, `${ctx.po.poNumber} is ${ctx.po.status} — serials can be generated once it is Approved.`);

  const { prefix, suffix } = readFormat(body);
  let { enableZero, noOfZeroRequired } = readFormat(body);
  // Once this process has serials the numbering (padding/digits) is fixed too,
  // or the next batch would come out as CH011 after CH00010.
  if (ctx.format && (ctx.format.generatedCount || 0) > 0) {
    enableZero = !!ctx.format.enableZero;
    noOfZeroRequired = enableZero ? Number(ctx.format.noOfZeroRequired) || 1 : 0;
  }
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) throw httpError(400, `Number of serials must be 1-${MAX_BATCH}.`);
  if (count > ctx.capacity) throw httpError(400, `Only ${ctx.capacity} more serial(s) can be generated for this process (${ctx.line.requiredQty} required, ${ctx.serialsGenerated} already generated).`);

  await assertFormatUsable(ctx, processId, accessoryId, prefix, suffix);
  await ensurePerProcessMode(ctx.accessory);

  const floor = ctx.format ? (ctx.format.lastNumber || 0) + 1 : 1;
  const startFrom = body.startFrom != null && body.startFrom !== "" ? Number(body.startFrom) : floor;
  if (!Number.isInteger(startFrom) || startFrom < 1 || startFrom > 1e12) throw httpError(400, "Start from must be a whole number from 1 to 1,000,000,000,000.");
  if (enableZero && String(startFrom + count - 1).length > noOfZeroRequired) {
    throw httpError(400, `${noOfZeroRequired} digit(s) can't hold number ${startFrom + count - 1} — the serial would grow a digit. Increase the digits (before the first generation) or lower the count.`);
  }
  if (startFrom < floor) throw httpError(409, `Numbers up to ${floor - 1} are already used for this process — start from ${floor} or later.`);
  const fmt = { prefix, suffix, enableZero, noOfZeroRequired };
  const serials = Array.from({ length: count }, (_, i) => buildSerial(fmt, startFrom + i));
  if (new Set(serials).size !== serials.length) throw httpError(400, "The format produces duplicate serials — enable zero padding or change the digits.");
  const [accHits, devHits] = await Promise.all([
    AccessorySerial.find({ serialNo: { $in: serials } }).select("serialNo").limit(10).lean(),
    Device.find({ serialNo: { $in: serials } }).select("serialNo").limit(10).lean(),
  ]);
  if (accHits.length || devHits.length) {
    throw httpError(409, `These serials already exist: ${[...accHits.map((x) => x.serialNo), ...devHits.map((x) => `${x.serialNo} (device)`)].join(", ")}.`);
  }

  // Claim the format first (unique index makes a concurrent claim of the same prefix/suffix fail).
  let formatDoc;
  try {
    formatDoc = await ProcessAccessorySerialFormat.findOneAndUpdate(
      { processId, accessoryId },
      { $setOnInsert: { processId, accessoryId, poId: ctx.po._id, poNumber: ctx.po.poNumber, createdBy: user?._id || null, createdAt: new Date() },
        $set: { prefix, suffix, enableZero, noOfZeroRequired, updatedAt: new Date() } },
      { upsert: true, new: true }
    );
  } catch (e) {
    if (e?.code === 11000) throw httpError(409, `Prefix/suffix "${prefix}…${suffix}" is already used by another process.`);
    throw e;
  }

  // Reserve the number range atomically BEFORE touching stock: a concurrent
  // generation for this process gets a clear 409 instead of colliding.
  const end = startFrom + count - 1;
  const before = await ProcessAccessorySerialFormat.findOneAndUpdate(
    { _id: formatDoc._id, $or: [{ lastNumber: { $lt: startFrom } }, { lastNumber: null }] },
    { $set: { lastNumber: end, updatedAt: new Date() }, $inc: { generatedCount: count } },
    { new: false }
  ).lean();
  if (!before) throw httpError(409, "Those numbers were just used by another generation for this process — check the last serial and try again.");
  const unreserve = () =>
    Promise.all([
      ProcessAccessorySerialFormat.updateOne({ _id: formatDoc._id, lastNumber: end }, { $set: { lastNumber: before.lastNumber || 0 } }),
      ProcessAccessorySerialFormat.updateOne({ _id: formatDoc._id }, { $inc: { generatedCount: -count } }),
    ]).catch((e) => console.error(`per-process serial range release failed for ${ctx.po.poNumber}:`, e.message));

  // Units beyond those already issued come out of stock now (count-only issue).
  const extra = Math.max(0, count - ctx.unlabeled);
  const poAcc = require("./poAccessoryService");
  if (extra > 0) {
    try {
      await poAcc.issueForPo(ctx.po._id, [{ accessoryId, qty: extra }], { refNo: `${prefix}${suffix}`, remarks: `Issued with serial generation for ${ctx.po.poNumber}`, user });
    } catch (e) {
      await unreserve();
      throw e;
    }
  }

  const now = new Date();
  const docs = serials.map((serialNo) => ({
    serialNo, accessoryId, code: ctx.accessory.code, name: ctx.accessory.name, status: "ISSUED", source: "process",
    poId: ctx.po._id, poNumber: ctx.po.poNumber, processId,
    history: [{ action: "ISSUED", toStatus: "ISSUED", poNumber: ctx.po.poNumber, remarks: `Generated for process (${prefix}…${suffix})`, ...actor(user), at: now }],
    createdAt: now, updatedAt: now,
  }));
  // Undo everything this call did: its inserted serials, its stock issue, its number range.
  const undoBatch = async () => {
    await AccessorySerial.deleteMany({ serialNo: { $in: serials }, processId, source: "process", status: "ISSUED", createdAt: now })
      .catch((e) => console.error(`per-process serial cleanup failed for ${ctx.po.poNumber}:`, e.message));
    if (extra > 0) await returnWithRetry(poAcc, ctx, accessoryId, extra, user);
    await unreserve();
  };
  try {
    await AccessorySerial.insertMany(docs, { ordered: true });
  } catch (e) {
    await undoBatch();
    if (e?.code === 11000) throw httpError(409, "Some of these serials were just created elsewhere — nothing was generated. Check the last serial and try again.");
    throw e;
  }
  // Two generations labelling the same already-issued units at once: the
  // process can't end up with more live serials than the PO requires.
  const live = await AccessorySerial.countDocuments({ poId: ctx.po._id, accessoryId, status: { $in: LIVE } });
  if (live > (ctx.line.requiredQty || 0)) {
    await undoBatch();
    throw httpError(409, "Another generation for this process just used this capacity — nothing was generated. Refresh and try again.");
  }
  return { serials, issuedFromStock: extra, labelledExisting: count - extra };
}

/**
 * Returning per-process units to the store: units that never got a serial go
 * back first; beyond that, unlinked serials of this PO are VOIDED (their
 * labels belong to the process). Called by poAccessoryService.returnForPo.
 */
async function voidForReturn(accessoryId, po, qty, issuedNetBefore, { user, voided = null } = {}) {
  const live = await AccessorySerial.countDocuments({ poId: po._id, accessoryId, status: { $in: LIVE } });
  const unlabeled = Math.max(0, issuedNetBefore - live);
  const toVoid = Math.max(0, qty - unlabeled);
  if (!toVoid) return 0;
  const candidates = await AccessorySerial.find({ poId: po._id, accessoryId, status: "ISSUED", deviceId: null })
    .select("_id").sort({ createdAt: -1 }).limit(toVoid).lean();
  if (candidates.length < toVoid) {
    throw httpError(400, `Only ${unlabeled + candidates.length} unit(s) can be returned — the rest are packed on devices (remove them first).`);
  }
  await AccessorySerial.updateMany(
    { _id: { $in: candidates.map((c) => c._id) }, status: "ISSUED", deviceId: null },
    { $set: { status: "VOIDED", updatedAt: new Date() }, $push: { history: { action: "VOIDED", fromStatus: "ISSUED", toStatus: "VOIDED", poNumber: po.poNumber || "", remarks: "Returned to store unused", ...actor(user), at: new Date() } } }
  );
  if (Array.isArray(voided)) voided.push(...candidates.map((c) => c._id));
  return toVoid;
}

/** Undo voidForReturn (the return it belonged to failed): the serials are live again. */
async function unvoid(ids) {
  if (!ids || !ids.length) return;
  await AccessorySerial.updateMany(
    { _id: { $in: ids }, status: "VOIDED" },
    { $set: { status: "ISSUED", updatedAt: new Date() }, $pop: { history: 1 } }
  );
}

module.exports = { summary, generate, saveFormat, lastSerial, voidForReturn, unvoid, buildSerial, ensureIndexes, formatsOverlap, assertNoFormatOverlap };
