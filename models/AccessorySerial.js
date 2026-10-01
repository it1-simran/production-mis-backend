const mongoose = require("mongoose");

/**
 * One physical unit of a serialized accessory — the source of truth for
 * "which device has this charger". Lifecycle:
 *   IN_STOCK  received (generated or supplier serial)
 *   ISSUED    issued from the store to a PO/process
 *   LINKED    scanned onto a device at packaging (deviceId set)
 *   DISPATCHED shipped with its device
 *   SCRAPPED  damaged/lost (out of stock, with reason)
 * The carton is NOT stored here: it is always the linked device's
 * cartonSerial, so carton edits/repackaging never leave it stale.
 */
const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true }, // RECEIVED, ISSUED, RETURNED, LINKED, UNLINKED, DISPATCHED, SCRAPPED, RELEASED
    fromStatus: { type: String, default: "" },
    toStatus: { type: String, default: "" },
    poNumber: { type: String, default: "" },
    deviceSerial: { type: String, default: "" },
    remarks: { type: String, default: "" },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const accessorySerialSchema = new mongoose.Schema({
  serialNo: { type: String, required: true, trim: true },
  accessoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Accessory", required: true },
  code: { type: String, default: "" },
  name: { type: String, default: "" },
  // VOIDED: a per-process serial whose unit went back to the store unused (its
  // label belongs to that process, so it is retired rather than reused).
  status: { type: String, enum: ["IN_STOCK", "ISSUED", "LINKED", "DISPATCHED", "SCRAPPED", "VOIDED"], default: "IN_STOCK" },
  source: { type: String, enum: ["generated", "supplier", "process"], default: "generated" },
  grnRef: { type: String, default: "" },
  poId: { type: mongoose.Schema.Types.ObjectId, ref: "purchaseOrders", default: null },
  poNumber: { type: String, default: "" },
  processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", default: null },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "devices", default: null },
  deviceSerial: { type: String, default: "" },
  dispatchedCartonSerial: { type: String, default: "" }, // snapshot at dispatch only
  history: { type: [historySchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Global uniqueness: a serial identifies exactly one unit across all accessories.
accessorySerialSchema.index({ serialNo: 1 }, { unique: true });
accessorySerialSchema.index({ accessoryId: 1, status: 1, createdAt: 1 });
accessorySerialSchema.index({ deviceId: 1 });
accessorySerialSchema.index({ deviceSerial: 1 }); // device history views look accessories up by device serial
accessorySerialSchema.index({ poId: 1, status: 1 });

module.exports = mongoose.model("AccessorySerial", accessorySerialSchema);
