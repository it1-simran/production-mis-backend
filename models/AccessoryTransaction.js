const mongoose = require("mongoose");

/**
 * Accessory stock ledger — one row for EVERY movement, in and out:
 *   RECEIVE  stock in (GRN)            onHand +
 *   ADJUST   manual correction (±)     onHand ±   (reason required)
 *   RESERVE  held for an approved PO   reserved +
 *   RELEASE  PO rejected/cancelled     reserved -
 *   ISSUE    handed out against a PO   onHand -, reserved - (its share)
 *   RETURN   unused returned from PO   onHand +
 * onHandAfter/reservedAfter snapshot the bucket right after the movement.
 */
const accessoryTransactionSchema = new mongoose.Schema({
  accessoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Accessory", required: true },
  type: { type: String, enum: ["RECEIVE", "ADJUST", "RESERVE", "RELEASE", "ISSUE", "RETURN", "ISSUE_REVERSED", "RETURN_REVERSED"], required: true },
  qty: { type: Number, required: true }, // signed for ADJUST, positive otherwise
  onHandAfter: { type: Number, default: 0 },
  reservedAfter: { type: Number, default: 0 },
  poId: { type: mongoose.Schema.Types.ObjectId, ref: "purchaseOrders", default: null },
  poNumber: { type: String, default: "" },
  processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", default: null },
  refNo: { type: String, default: "" },
  remarks: { type: String, default: "" },
  by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  byName: { type: String, default: "" },
  at: { type: Date, default: Date.now },
});

accessoryTransactionSchema.index({ accessoryId: 1, at: -1 });
accessoryTransactionSchema.index({ poId: 1, at: -1 });

module.exports = mongoose.model("AccessoryTransaction", accessoryTransactionSchema);
