const mongoose = require("mongoose");

const productCategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: "products" }],
  status: { type: String, required: true, default: "1" },
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
