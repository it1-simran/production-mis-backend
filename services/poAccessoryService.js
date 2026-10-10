/**
 * Purchase-Order side of Accessories Management:
 *  - which accessories a PO may carry (its Product Category mapping)
 *  - building/validating a PO's accessory lines from a customer selection
 *  - keeping requiredQty in step with the PO quantity
 *  - keeping stock reservations in step with the PO status
 *  - issuing / returning accessories against a PO
 * Stock itself only moves through services/accessoryStockService.
 */
const mongoose = require("mongoose");
const PurchaseOrder = require("../models/PurchaseOrder");
const Accessory = require("../models/Accessory");
const stock = require("./accessoryStockService");
const { resolveProductCategory } = require("./poProductService");

const { httpError } = stock;

// Lazily required: accessorySerialService requires accessoryStockService too.
const serialSvc = () => require("./accessorySerialService");
async function perProcessIdsFor(lines) {
  const ids = (lines || []).map((l) => l.accessoryId);
  if (!ids.length) return new Set();
  const docs = await Accessory.find({ _id: { $in: ids }, serialMode: "per_process" }).select("_id").lean();
  return new Set(docs.map((d) => String(d._id)));
}
/**
 * A PO line snapshots the accessory's trackStock when the PO is raised. If the
 * accessory was switched to/from stock-tracked since, lines with nothing issued
 * yet follow the current setting (units issued while untracked never left the
 * store's count, so those lines keep their old value). Mutates; caller saves.
 */
async function refreshTracking(po) {
  const lines = po.accessories || [];
  if (!lines.length) return false;
  const docs = await Accessory.find({ _id: { $in: lines.map((l) => l.accessoryId) } }).select("_id trackStock").lean();
  const live = new Map(docs.map((d) => [String(d._id), !!d.trackStock]));
  let changed = false;
  for (const l of lines) {
    const now = live.get(String(l.accessoryId));
    const outstanding = (l.issuedQty || 0) - (l.returnedQty || 0);
    if (now !== undefined && now !== !!l.trackStock && outstanding <= 0) {
      l.trackStock = now;
      changed = true;
    }
  }
  if (changed && po.markModified) po.markModified("accessories");
  return changed;
}

async function serializedIdsFor(lines) {
  const ids = (lines || []).map((l) => l.accessoryId);
  if (!ids.length) return new Set();
  const docs = await Accessory.find({ _id: { $in: ids }, serialized: true }).select("_id").lean();
  return new Set(docs.map((d) => String(d._id)));
}
const LOCK_TTL_MS = 2 * 60 * 1000;

/** Active accessories mapped to the Product Category a device category resolves to. */
async function mappedAccessoriesFor(deviceCategory) {
  const category = await resolveProductCategory({ deviceCategory });
  if (!category) return { category: null, items: [] };
  const ids = (category.accessories || []).map((m) => m.accessoryId);
  const docs = await Accessory.find({ _id: { $in: ids }, activeStatus: true }).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const items = (category.accessories || [])
    .map((m) => {
      const a = byId.get(String(m.accessoryId));
      if (!a) return null; // inactive / deleted accessory — not offered
      return {
        accessoryId: a._id,
        code: a.code,
        name: a.name,
        unit: a.unit,
        trackStock: a.trackStock,
        description: a.description || "",
        mandatory: !!m.mandatory,
        qtyMode: m.qtyMode || "per_device",
        defaultQty: m.defaultQty || 1,
        allowQtyChange: !!m.allowQtyChange,
      };
    })
    .filter(Boolean);
  return { category, items };
}

const requiredFor = (qtyMode, qtyPerUnit, poQty) =>
  qtyMode === "per_po" ? qtyPerUnit : qtyPerUnit * Math.max(0, Number(poQty) || 0);

/**
 * Build a PO's accessory lines from a selection [{ id|accessoryId, qty }].
 * The mapping is authoritative: unmapped ids are refused, mandatory ones are
 * always included, and qty can only differ from the default when allowed.
 * `qty` is per device (per_device) or the PO total (per_po).
 */
async function buildPoAccessories(deviceCategory, selection, poQty) {
  const { items } = await mappedAccessoriesFor(deviceCategory);
  const byId = new Map(items.map((i) => [String(i.accessoryId), i]));
  const picked = new Map();
  for (const s of Array.isArray(selection) ? selection : []) {
    const id = String(s?.accessoryId || s?.id || "");
    if (!id) continue;
    if (!byId.has(id)) throw httpError(400, "An accessory that isn't configured for this product category was selected.");
    picked.set(id, s);
  }
  const lines = [];
  for (const item of items) {
    const s = picked.get(String(item.accessoryId));
    if (!s && !item.mandatory) continue;
    let qtyPerUnit = item.defaultQty;
    if (s && item.allowQtyChange && s.qty != null && s.qty !== "") {
      const q = Number(s.qty);
      if (!Number.isInteger(q) || q < 1 || q > 100000) {
        throw httpError(400, `Quantity for accessory "${item.name}" must be a whole number of at least 1.`);
      }
      qtyPerUnit = q;
    }
    lines.push({
      accessoryId: item.accessoryId,
      code: item.code,
      name: item.name,
      unit: item.unit,
      trackStock: item.trackStock,
      mandatory: item.mandatory,
      qtyMode: item.qtyMode,
      qtyPerUnit,
      requiredQty: requiredFor(item.qtyMode, qtyPerUnit, poQty),
      reservedQty: 0,
      issuedQty: 0,
      returnedQty: 0,
    });
  }
  return lines;
}

/** Recompute requiredQty after the PO quantity changed (in-memory, caller saves). */
function recalcRequired(po) {
  (po.accessories || []).forEach((l) => {
    l.requiredQty = requiredFor(l.qtyMode, l.qtyPerUnit, po.requiredQuantity);
  });
  if (po.markModified) po.markModified("accessories");
}

async function withPoLock(poId, fn) {
  const stale = new Date(Date.now() - LOCK_TTL_MS);
  const token = new mongoose.Types.ObjectId().toString();
  const po = await PurchaseOrder.findOneAndUpdate(
    { _id: poId, $or: [{ accessoriesLockedAt: null }, { accessoriesLockedAt: { $lt: stale } }] },
    { $set: { accessoriesLockedAt: new Date(), accessoriesLockToken: token } },
    { new: true }
  );
  if (!po) {
    const exists = await PurchaseOrder.exists({ _id: poId });
    throw httpError(exists ? 409 : 404, exists ? "This PO's accessories are being updated by someone else — try again." : "Purchase Order not found.");
  }
  // A long batch (thousands of serial claims) keeps its lock alive, so it is
  // never treated as stale and taken over mid-way.
  const heartbeat = setInterval(() => {
    PurchaseOrder.updateOne({ _id: poId, accessoriesLockToken: token }, { $set: { accessoriesLockedAt: new Date() } }).catch(() => {});
  }, Math.floor(LOCK_TTL_MS / 3));
  if (heartbeat.unref) heartbeat.unref();
  try {
    return await fn(po);
  } finally {
    clearInterval(heartbeat);
    // Only release OUR lock — if it was taken over, the new holder keeps it.
    await PurchaseOrder.updateOne({ _id: poId, accessoriesLockToken: token }, { $set: { accessoriesLockedAt: null, accessoriesLockToken: "" } }).catch(() => {});
  }
}

const netNeed = (l) => Math.max(0, (l.requiredQty || 0) - ((l.issuedQty || 0) - (l.returnedQty || 0)));

/**
 * Check every requested line up front (known line, whole qty, listed once,
 * within its limit) so a bad line is refused before ANY stock moves.
 */
function planItems(po, items, label, check) {
  const seen = new Set();
  return items.map((it) => {
    const l = findLine(po, it.accessoryId);
    const key = String(l.accessoryId);
    if (seen.has(key)) throw httpError(400, `"${l.name}" is listed twice — combine it into one line.`);
    seen.add(key);
    const q = stock.positiveInt(it.qty, `${label} quantity for "${l.name}"`);
    check(l, q);
    return { it, l, q };
  });
}

/**
 * Stock/serial moves are separate writes (no transaction), so a request that
 * fails part-way runs the undo steps of what it already did, newest first.
 */
async function rollback(undo, what, po) {
  for (const step of undo.reverse()) {
    try {
      await step();
    } catch (e) {
      console.error(`accessory ${what} rollback step failed for ${po.poNumber || po._id} — stock may need an adjustment:`, e.message);
    }
  }
}

/**
 * Make each tracked line's reservation match the PO state: an Approved PO
 * holds up to what it still needs (what's free — a shortfall is fine and shows
 * on the requirements page); any other status holds nothing. Never throws on a
 * stock shortfall. Returns a short summary for history remarks.
 */
async function syncReservations(poId, user) {
  return withPoLock(poId, async (po) => {
    if (await refreshTracking(po)) await po.save();
    const notes = [];
    const meta = { poId: po._id, poNumber: po.poNumber, user, remarks: `PO ${po.poNumber || ""} ${po.status}` };
    // Each line is recorded on the PO as soon as its stock moved, so one bad
    // line can't leave another line's reservation held with no PO owning it.
    for (const l of po.accessories || []) {
      if (!l.trackStock) continue;
      const target = po.status === "Approved" ? netNeed(l) : 0;
      const have = l.reservedQty || 0;
      if (target === have) continue;
      try {
        if (target > have) {
          const got = await stock.reserve(l.accessoryId, target - have, meta);
          if (got < target - have) notes.push(`${l.name}: short ${target - have - got}`);
          if (!got) continue;
          l.reservedQty = have + got;
          po.markModified("accessories");
          try {
            await po.save();
          } catch (e) {
            await stock.release(l.accessoryId, got, meta).catch(() => {});
            throw e;
          }
        } else {
          // If the bucket holds less than this PO thinks (drift), release what it has.
          const released = await stock.releaseUpTo(l.accessoryId, have - target, meta);
          if (released < have - target) notes.push(`${l.name}: store held only ${released} of ${have - target} to release`);
          l.reservedQty = target;
          po.markModified("accessories");
          await po.save();
        }
      } catch (e) {
        console.error(`syncReservations ${po.poNumber || po._id} / ${l.name}:`, e.message);
        notes.push(`${l.name}: ${e.message}`);
      }
    }
    return notes;
  });
}

function findLine(po, accessoryId) {
  const l = (po.accessories || []).find((x) => String(x.accessoryId) === String(accessoryId));
  if (!l) throw httpError(400, "That accessory isn't on this PO.");
  return l;
}

/**
 * The PO quantity changed: recompute each line's requiredQty under the PO lock,
 * on a fresh copy, so an issue/return running at the same time isn't
 * overwritten by a stale edit. Retries briefly if the lock is busy.
 */
async function applyRequiredQty(poId) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withPoLock(poId, async (po) => {
        recalcRequired(po);
        return po.save();
      });
    } catch (e) {
      if (e.status !== 409 || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

/** Issue accessories against a PO: items [{ accessoryId, qty }]. */
async function issueForPo(poId, items, { processId = null, refNo = "", remarks = "", user } = {}) {
  if (!Array.isArray(items) || !items.length) throw httpError(400, "Nothing to issue.");
  return withPoLock(poId, async (po) => {
    if (po.status !== "Approved") throw httpError(409, `Accessories can only be issued for an Approved PO (this one is ${po.status}).`);
    await refreshTracking(po);
    const meta = { poId: po._id, poNumber: po.poNumber, processId: processId || po.fulfilment?.processId || null, refNo, remarks, user };
    const serialized = await serializedIdsFor(po.accessories);
    const plan = planItems(po, items, "Issue", (l, q) => {
      if (q > netNeed(l)) throw httpError(400, `"${l.name}": only ${netNeed(l)} more can be issued for this PO.`);
    });
    const undo = [];
    try {
      for (const { it, l, q } of plan) {
        if (l.trackStock) {
          const fromReserved = Math.min(q, l.reservedQty || 0);
          // Serialized: claim the actual units first (oldest first, or the scanned ones), then move the count.
          const claimed = serialized.has(String(l.accessoryId))
            ? await serialSvc().claimForIssue(l.accessoryId, po, q, { serials: it.serials, user })
            : [];
          if (claimed.length) undo.push(() => serialSvc().putBack(claimed, user));
          await stock.issue(l.accessoryId, q, fromReserved, meta);
          undo.push(() => stock.reverseIssue(l.accessoryId, q, fromReserved, { ...meta, remarks: "Issue rolled back (request failed)" }));
          l.reservedQty = (l.reservedQty || 0) - fromReserved;
        }
        l.issuedQty = (l.issuedQty || 0) + q;
      }
      po.statusHistory.push({
        fromStatus: po.status, toStatus: po.status, actorType: "mes",
        changedBy: user?._id || null, changedByName: user?.name || user?.email || "",
        remarks: `Accessories issued${refNo ? ` (${refNo})` : ""}: ${plan.map((p) => `${p.l.name} × ${p.q}`).join(", ")}`,
        changedAt: new Date(),
      });
      po.markModified("accessories");
      return await po.save();
    } catch (e) {
      await rollback(undo, "issue", po);
      throw e;
    }
  });
}

/** Return unused accessories from a PO back to the store. */
async function returnForPo(poId, items, { refNo = "", remarks = "", user } = {}) {
  if (!Array.isArray(items) || !items.length) throw httpError(400, "Nothing to return.");
  return withPoLock(poId, async (po) => {
    const meta = { poId: po._id, poNumber: po.poNumber, refNo, remarks, user };
    const serialized = await serializedIdsFor(po.accessories);
    const perProcess = await perProcessIdsFor(po.accessories);
    const plan = planItems(po, items, "Return", (l, q) => {
      const out = (l.issuedQty || 0) - (l.returnedQty || 0);
      if (q > out) throw httpError(400, `"${l.name}": only ${out} issued unit(s) can be returned.`);
    });
    const pps = require("./processAccessorySerialService");
    const undo = [];
    try {
      for (const { l, q } of plan) {
        const out = (l.issuedQty || 0) - (l.returnedQty || 0);
        // Serialized: only units not yet packed onto a device can come back.
        // Units issued count-only (before the accessory became serialized) have
        // no serials, so those come back as a count.
        if (serialized.has(String(l.accessoryId)) && l.trackStock) {
          const AccessorySerial = require("../models/AccessorySerial");
          const [liveSerials, unlinked] = await Promise.all([
            AccessorySerial.countDocuments({ accessoryId: l.accessoryId, poId: po._id, status: { $in: ["ISSUED", "LINKED", "DISPATCHED"] } }),
            AccessorySerial.countDocuments({ accessoryId: l.accessoryId, poId: po._id, status: "ISSUED", deviceId: null }),
          ]);
          const countOnlyOut = Math.max(0, out - liveSerials);
          const bySerial = Math.min(q, unlinked);
          if (q - bySerial > countOnlyOut) {
            throw httpError(400, `"${l.name}": only ${unlinked + countOnlyOut} unit(s) can be returned — the rest are packed on devices (remove them first).`);
          }
          if (bySerial > 0) {
            const done = await serialSvc().returnFromPo(l.accessoryId, po, bySerial, { user });
            undo.push(() => serialSvc().undoReturnFromPo(done, po));
          }
        }
        // Per-process serials: unlabeled units first, then unused serials are voided.
        if (perProcess.has(String(l.accessoryId))) {
          const voided = [];
          await pps.voidForReturn(l.accessoryId, po, q, out, { user, voided });
          undo.push(() => pps.unvoid(voided));
        }
        if (l.trackStock) {
          await stock.returnStock(l.accessoryId, q, meta);
          undo.push(() => stock.reverseReturn(l.accessoryId, q, { ...meta, remarks: "Return rolled back (request failed)" }));
        }
        l.returnedQty = (l.returnedQty || 0) + q;
      }
      po.statusHistory.push({
        fromStatus: po.status, toStatus: po.status, actorType: "mes",
        changedBy: user?._id || null, changedByName: user?.name || user?.email || "",
        remarks: `Accessories returned${refNo ? ` (${refNo})` : ""}: ${plan.map((p) => `${p.l.name} × ${p.q}`).join(", ")}`,
        changedAt: new Date(),
      });
      po.markModified("accessories");
      return await po.save();
    } catch (e) {
      await rollback(undo, "return", po);
      throw e;
    }
  });
}

/** Tracked lines that aren't fully issued or reserved (for shortage warnings). */
function shortageOf(po) {
  return (po.accessories || [])
    .filter((l) => l.trackStock)
    .map((l) => ({ name: l.name, short: Math.max(0, netNeed(l) - (l.reservedQty || 0)) }))
    .filter((x) => x.short > 0);
}

module.exports = {
  mappedAccessoriesFor,
  buildPoAccessories,
  recalcRequired,
  applyRequiredQty,
  syncReservations,
  issueForPo,
  returnForPo,
  shortageOf,
  netNeed,
};
