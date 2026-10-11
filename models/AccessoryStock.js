const mongoose = require("mongoose");

/**
 * One stock bucket per accessory. Only services/accessoryStockService changes
 * it — every change is an atomic, condition-guarded update paired with an
 * AccessoryTransaction ledger row, so stock can't go negative or drift
 * without a trace. available = onHand - reserved (computed, not stored).
 */
const accessoryStockSchema = new mongoose.Schema({
  accessoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Accessory", required: true, unique: true },
  onHand: { type: Number, default: 0, min: 0 },
  reserved: { type: Number, default: 0, min: 0 },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("AccessoryStock", accessoryStockSchema);
