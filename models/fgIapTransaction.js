const mongoose = require("mongoose");

// One row per Kit Allocation (IAP) transaction — created empty (no FG IAP
// Number yet) the moment the IAP transaction is created, purely to hold the
// approved-quantity cap and track cumulative receipts. The FG IAP Number
// itself is typed by the FG Store operator on the *first* carton received
// against this row (see cartonController.keepInStore) and then locks for
// every later carton in the same batch. Auto-closes once fully received —
// a closed row must never accept further receipts, and the next allocation
// transaction always starts its own fresh (empty) row.
const fgIapTransactionSchema = new mongoose.Schema(
  {
    allocationTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KitAllocationTransaction",
      required: true,
      unique: true,
      index: true,
    },
    processId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "process",
      required: true,
      index: true,
    },
    iapNo: { type: String, required: true },
    // Absent (not even an empty string) until the operator types it — a
    // sparse unique index lets any number of rows sit in this "not yet
    // entered" state without colliding on uniqueness.
    fgIapNo: { type: String, unique: true, sparse: true, index: true },
    approvedQuantity: { type: Number, required: true },
    receivedQuantity: { type: Number, default: 0 },
    status: { type: String, enum: ["Open", "Closed"], default: "Open", index: true },
  },
  { timestamps: true }
);

// The hot query on every carton receipt: "oldest still-open transaction for
// this process" — findOne({processId, status:"Open"}).sort({createdAt:1, _id:1}).
// Without this compound index Mongo can only use one of the single-field
// indexes above and has to filter/sort the rest in memory.
fgIapTransactionSchema.index({ processId: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model("FgIapTransaction", fgIapTransactionSchema);
