const mongoose = require("mongoose");
const inventorySchema = new mongoose.Schema({
  productName: { type: String, required: true, default: "" },
  productType: { type: mongoose.Schema.Types.ObjectId, ref: "products", required: true },
  quantity: { type: Number, required: false, default: 0 },
  cartonQuantity: { type: Number, required: false, default: 0 },
  status: { type: String, enum: ["In Stock", "Out of Stock", "Reserved"], default: "Out of Stock" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
  },
  department: { type: String, required: false },
});

// One inventory row per product. Not built automatically (config/db.js runs with autoIndex:false): run
// scripts/create-product-inventory-indexes.js. Without it the code still avoids duplicates, but two requests at the very same
// moment can each insert a row (an upsert is not atomic across a missing unique key).
inventorySchema.index({ productType: 1 }, { unique: true });

const inventory = mongoose.model("inventory", inventorySchema);
module.exports = inventory;
