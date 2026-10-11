const mongoose = require("mongoose");

/**
 * Pre-defined device serial number formats (master). Same shape MES uses to
 * generate device serials (deviceController.generateSerials):
 *   prefix + running number (optionally zero-padded to N digits) + suffix
 * GPSCPANEL offers the active ones on the SKU form; the SKU keeps the chosen
 * format's id/name and its sample serial (serialNumberFormat).
 */
const deviceSerialFormatSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  prefix: { type: String, required: true, trim: true },
  suffix: { type: String, default: "", trim: true },
  enableZero: { type: Boolean, default: true },
  noOfZeroRequired: { type: Number, default: 6 }, // digits of the running number when zero-padded
  description: { type: String, default: "", trim: true },
  activeStatus: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

deviceSerialFormatSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
deviceSerialFormatSchema.index({ prefix: 1, suffix: 1, enableZero: 1, noOfZeroRequired: 1 }, { unique: true });

/** First serial of the format, e.g. JSD-GB429-000001-A. */
deviceSerialFormatSchema.statics.sampleOf = (f, n = 1) =>
  `${f.prefix || ""}${f.enableZero ? String(n).padStart(Math.max(1, Number(f.noOfZeroRequired) || 1), "0") : String(n)}${f.suffix || ""}`;

module.exports = mongoose.model("DeviceSerialFormat", deviceSerialFormatSchema);
