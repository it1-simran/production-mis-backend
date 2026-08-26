const mongoose = require("mongoose");

/**
 * Maps a slug token (used as ${slug} inside a Testing Plan command/value) to a
 * field path in the Purchase Order. At product-creation time the resolver reads
 * `source` against the PO to substitute the real value.
 *
 * `source` is a dot-path into the PurchaseOrder document, e.g.:
 *   - "vendorId"
 *   - "esim.make"
 *   - "esim.profile1"
 *   - "configuration.values.pip.value"   (config snapshot fields: pip/eip/gip_port…)
 */
const slugMappingSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, trim: true },
  label: { type: String, default: "" },
  source: { type: String, required: true, trim: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("SlugMapping", slugMappingSchema);
