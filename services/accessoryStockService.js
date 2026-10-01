/**
 * The ONLY code that changes accessory stock. Each movement is a single
 * atomic, condition-guarded findOneAndUpdate on the AccessoryStock bucket
 * (so concurrent requests can't oversell or go negative), followed by an
 * AccessoryTransaction ledger row snapshotting the bucket after the move.
 * (The kit flow's gaps this avoids: outbound-only ledger, direct quantity
 * overwrites, returns/adjustments with no record.)
 */
const AccessoryStock = require("../models/AccessoryStock");
const AccessoryTransaction = require("../models/AccessoryTransaction");

const httpError = (status, message) => Object.assign(new Error(message), { status });

const positiveInt = (n, label = "Quantity") => {
  const q = Number(n);
  if (!Number.isInteger(q) || q < 1) throw httpError(400, `${label} must be a whole number of at least 1.`);
  return q;
};

async function ensureBucket(accessoryId) {
  await AccessoryStock.updateOne(
    { accessoryId },
    { $setOnInsert: { accessoryId, onHand: 0, reserved: 0 } },
    { upsert: true }
  );
}

// The stock move has already committed when this runs, so a ledger failure is
// logged, never thrown — throwing would make callers "undo" a move that stuck.
async function ledger(bucket, type, qty, meta = {}) {
  try {
    await writeLedger(bucket, type, qty, meta);
  } catch (e) {
    console.error(`accessory ledger write failed (${type} ${qty} for ${bucket.accessoryId}):`, e.message);
  }
}

async function writeLedger(bucket, type, qty, meta = {}) {
  await AccessoryTransaction.create({
    accessoryId: bucket.accessoryId,
    type,
    qty,
    onHandAfter: bucket.onHand,
    reservedAfter: bucket.reserved,
    poId: meta.poId || null,
    poNumber: meta.poNumber || "",
    processId: meta.processId || null,
    refNo: meta.refNo || "",
    remarks: meta.remarks || "",
    by: meta.user?._id || null,
    byName: meta.user?.name || meta.user?.email || "",
  });
}

async function move(accessoryId, filterExpr, inc, type, ledgerQty, meta, failMessage) {
  await ensureBucket(accessoryId);
  const bucket = await AccessoryStock.findOneAndUpdate(
    { accessoryId, ...(filterExpr ? { $expr: filterExpr } : {}) },
    { $inc: inc, $set: { updatedAt: new Date() } },
    { new: true }
  ).lean();
  if (!bucket) throw httpError(409, failMessage);
  await ledger(bucket, type, ledgerQty, meta);
  return bucket;
}

/** Stock in (GRN). */
async function receive(accessoryId, qty, meta) {
  const q = positiveInt(qty);
  return move(accessoryId, null, { onHand: q }, "RECEIVE", q, meta, "Could not receive stock.");
}

/** Manual correction; delta may be negative but can't take onHand below what's reserved. */
async function adjust(accessoryId, delta, meta) {
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) throw httpError(400, "Adjustment must be a non-zero whole number.");
  if (!String(meta?.remarks || "").trim()) throw httpError(400, "A reason is required for a stock adjustment.");
  const guard = d < 0 ? { $gte: [{ $add: ["$onHand", d] }, "$reserved"] } : null;
  return move(accessoryId, guard, { onHand: d }, "ADJUST", d, meta,
    "Adjustment would take stock below what is already reserved for approved POs.");
}

/**
 * Reserve UP TO qty (whatever is free). Returns how many were reserved.
 * Retries a few times because "take min(qty, free)" is read-then-write.
 */
async function reserve(accessoryId, qty, meta) {
  const want = Number(qty);
  if (!Number.isInteger(want) || want < 1) return 0;
  await ensureBucket(accessoryId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const b = await AccessoryStock.findOne({ accessoryId }).lean();
    const take = Math.min(want, Math.max(0, (b?.onHand || 0) - (b?.reserved || 0)));
    if (take < 1) return 0;
    const bucket = await AccessoryStock.findOneAndUpdate(
      { accessoryId, $expr: { $gte: [{ $subtract: ["$onHand", "$reserved"] }, take] } },
      { $inc: { reserved: take }, $set: { updatedAt: new Date() } },
      { new: true }
    ).lean();
    if (bucket) {
      await ledger(bucket, "RESERVE", take, meta);
      return take;
    }
  }
  return 0;
}

/** Give back qty of a reservation. */
async function release(accessoryId, qty, meta) {
  const q = positiveInt(qty);
  return move(accessoryId, { $gte: ["$reserved", q] }, { reserved: -q }, "RELEASE", q, meta, "Reservation already released.");
}

/**
 * Issue qty out of the store; fromReserved of it comes out of this PO's own
 * reservation, the rest must be FREE stock (never another PO's reservation).
 */
async function issue(accessoryId, qty, fromReserved, meta) {
  const q = positiveInt(qty);
  const r = Math.max(0, Math.min(Number(fromReserved) || 0, q));
  const guard = {
    $and: [
      { $gte: ["$onHand", q] },
      { $gte: ["$reserved", r] },
      // what's left on hand must still cover everyone else's reservations
      { $gte: [{ $subtract: ["$onHand", q] }, { $subtract: ["$reserved", r] }] },
    ],
  };
  return move(accessoryId, guard, { onHand: -q, reserved: -r }, "ISSUE", q, meta,
    "Not enough free stock to issue this quantity.");
}

/** Unused accessories back into the store. */
async function returnStock(accessoryId, qty, meta) {
  const q = positiveInt(qty);
  return move(accessoryId, null, { onHand: q }, "RETURN", q, meta, "Could not return stock.");
}

/** Undo an issue() that belongs to a request which then failed. */
async function reverseIssue(accessoryId, qty, fromReserved, meta) {
  const q = positiveInt(qty);
  const r = Math.max(0, Math.min(Number(fromReserved) || 0, q));
  return move(accessoryId, null, { onHand: q, reserved: r }, "ISSUE_REVERSED", q, meta, "Could not reverse the issue.");
}

/** Undo a returnStock() that belongs to a request which then failed. */
async function reverseReturn(accessoryId, qty, meta) {
  const q = positiveInt(qty);
  return move(accessoryId, { $gte: ["$onHand", q] }, { onHand: -q }, "RETURN_REVERSED", q, meta, "Could not reverse the return.");
}

/** Release up to qty — if the bucket holds less (drifted), release what it has. Returns the amount released. */
async function releaseUpTo(accessoryId, qty, meta) {
  const q = positiveInt(qty);
  try {
    await release(accessoryId, q, meta);
    return q;
  } catch (e) {
    if (e.status !== 409) throw e;
    const b = await AccessoryStock.findOne({ accessoryId }).lean();
    const have = Math.min(q, Math.max(0, b?.reserved || 0));
    if (have > 0) await release(accessoryId, have, meta);
    return have;
  }
}

module.exports = { receive, adjust, reserve, release, releaseUpTo, issue, returnStock, reverseIssue, reverseReturn, ensureBucket, httpError, positiveInt };
