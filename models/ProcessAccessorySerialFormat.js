const mongoose = require("mongoose");

/**
 * Per-process accessory serial format (serialMode "per_process") — the
 * accessory equivalent of a Process's device serial range: prefix + optional
 * zero-padded running number + suffix, e.g. CHG-PRC11-00001-A. One per
 * (process, accessory). The prefix+suffix pair is unique across ALL processes
 * and accessories, so every process's accessory serials are distinguishable.
 */
const processAccessorySerialFormatSchema = new mongoose.Schema({
  processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", required: true },
  accessoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Accessory", required: true },
  poId: { type: mongoose.Schema.Types.ObjectId, ref: "purchaseOrders", default: null },
  poNumber: { type: String, default: "" },
  prefix: { type: String, default: "" },
  suffix: { type: String, default: "" },
  enableZero: { type: Boolean, default: true },
  noOfZeroRequired: { type: Number, default: 5 },
  lastNumber: { type: Number, default: 0 },
  generatedCount: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

processAccessorySerialFormatSchema.index({ processId: 1, accessoryId: 1 }, { unique: true });
processAccessorySerialFormatSchema.index({ prefix: 1, suffix: 1 }, { unique: true });

module.exports = mongoose.model("ProcessAccessorySerialFormat", processAccessorySerialFormatSchema);
