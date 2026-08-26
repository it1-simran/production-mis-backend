const mongoose = require("mongoose");

const productCategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: "products" }],
  status: { type: String, required: true, default: "1" },
  // Category-level Testing Plan template (same shape as products.stages).
  // Copied onto a product when it is auto-created from a PO, with ${slug}
  // tokens resolved against the PO. Managed via the category testing-plan editor.
  testingPlan: { type: mongoose.Schema.Types.Mixed, default: [] },
  // Optional link to a GPSCPANEL device category id, so PO device categories map here.
  deviceCategoryId: { type: Number, default: null },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

productCategorySchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

const ProductCategory = mongoose.model("productCategory", productCategorySchema);

module.exports = ProductCategory;
