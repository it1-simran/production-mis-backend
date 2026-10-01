const mongoose = require("mongoose");

/**
 * Accessory master — everything that can ship/pack alongside devices
 * (cables, adapters, manuals, mounting kits…). Mapped per Product Category
 * (productCategory.accessories) and selected per Purchase Order
 * (purchaseOrders.accessories). Never hard-deleted: deactivating hides it from
 * new mappings/POs while keeping every PO and stock record that references it.
 */
const accessorySchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true }, // ACC-0001
  name: { type: String, required: true, trim: true },
  description: { type: String, default: "" },
  unit: { type: String, enum: ["pcs", "set", "m", "kg", "other"], default: "pcs" },
  // false = recorded on POs for information only; no stock checks / reservation.
  trackStock: { type: Boolean, default: true },
  // Serialized: every unit carries its own serial (accessoryserials) and is
  // linked to a device at packaging. Implies trackStock.
  serialized: { type: Boolean, default: false },
  // How units get serials:
  //   none        count only
  //   global      one format for the accessory, serials created at receipt (serialized:true)
  //   per_process like device serials: each Process sets its own prefix/suffix and
  //               generates serials for the units issued to it; stock stays count-only
  serialMode: { type: String, enum: ["none", "global", "per_process"], default: "none" },
  // generated = MES creates + prints the labels; supplier = the unit's own
  // manufacturer serial, imported/scanned in at receipt.
  serialSource: { type: String, enum: ["generated", "supplier"], default: "generated" },
  // generated serial = prefix + date token + zero-padded running number + suffix
  // e.g. CHG + 2609 + 000123 -> CHG2609000123. The prefix must be unique per
  // accessory so a scanned serial identifies its accessory type.
  serialFormat: {
    prefix: { type: String, default: "", trim: true },
    dateToken: { type: String, enum: ["none", "YYMM", "YYYYMM"], default: "YYMM" },
    padding: { type: Number, default: 6, min: 3, max: 10 },
    suffix: { type: String, default: "", trim: true },
  },
  activeStatus: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

accessorySchema.index({ name: 1 });
accessorySchema.index({ activeStatus: 1 });

accessorySchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Accessory", accessorySchema);
