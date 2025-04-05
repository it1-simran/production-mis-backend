const mongoose = require("mongoose");
const inventorySchema = new mongoose.Schema({
  productName: { type: String, required: true, default: "" },
  productType: {type: mongoose.Schema.Types.ObjectId,ref: "ProductType",required: true},
  quantity: { type: Number, required: false, default: 0 },
  cartonQuantity : { type: Number, required: false, default: 0},
  status: { type: String, enum: ["In Stock", "Out of Stock", "Reserved"], default: "Out of Stock"},
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const inventory = mongoose.model("inventory", inventorySchema);
module.exports = inventory;
