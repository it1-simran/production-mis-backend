const mongoose = require("mongoose");

const kitAllocationTransactionSchema = new mongoose.Schema(
  {
    processId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "process",
      required: true,
      index: true,
    },
    inventoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "inventory",
      default: null,
    },
    iapNo: { type: String, required: true, index: true },
    quantity: { type: Number, required: true },
    cartonQuantity: { type: Number, default: 0 },
    allocatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    allocatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("KitAllocationTransaction", kitAllocationTransactionSchema);
