const mongoose = require("mongoose");

const kitTransferRequestSchema = new mongoose.Schema(
  {
    fromProcessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "process",
      required: true,
    },
    toProcessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "process",
      required: true,
    },
    fromProcessName: { type: String, default: "" },
    toProcessName: { type: String, default: "" },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
    },
    productName: { type: String, default: "" },
    quantity: { type: Number, required: true },
    serials: { type: [String], default: [] },
    targetStage: { type: String, default: "" },
    remarks: { type: String, default: "" },
    rejectionReason: { type: String, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
      default: "PENDING",
    },
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    requesterName: { type: String, default: "" },
    approverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      default: null,
    },
    approverName: { type: String, default: "" },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

kitTransferRequestSchema.index({ status: 1, createdAt: -1 });
kitTransferRequestSchema.index({ fromProcessId: 1, toProcessId: 1, createdAt: -1 });

module.exports = mongoose.model("kitTransferRequests", kitTransferRequestSchema);
