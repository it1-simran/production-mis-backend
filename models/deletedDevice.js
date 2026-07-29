const mongoose = require("mongoose");

const deletedDeviceSchema = new mongoose.Schema({
  originalDevice: { type: mongoose.Schema.Types.Mixed, required: true },
  imeiNo: { type: String, default: "" },
  serialNo: { type: String, default: "" },
  ccid: { type: String, default: "" },
  productType: { type: mongoose.Schema.Types.ObjectId, ref: "products", default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  deletedByName: { type: String, default: "" },
  deletedAt: { type: Date, default: Date.now },
  reason: { type: String, default: "" },
  // Groups every row from the same bulk-delete upload for later reference.
  batchId: { type: mongoose.Schema.Types.ObjectId, required: true },
});

deletedDeviceSchema.index({ imeiNo: 1 });
deletedDeviceSchema.index({ serialNo: 1 });
deletedDeviceSchema.index({ batchId: 1 });
deletedDeviceSchema.index({ deletedAt: -1 });

module.exports = mongoose.model("DeletedDevice", deletedDeviceSchema, "deletedDevices");
