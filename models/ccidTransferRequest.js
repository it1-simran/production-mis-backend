const mongoose = require("mongoose");

const ccidTransferRequestSchema = new mongoose.Schema(
  {
    fromProcessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "process",
      required: true,
    },
    toProcessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "process",
      required: false,
    },
    fromProcessName: { type: String, default: "" },
    toProcessName: { type: String, default: "" },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
    },
    productName: { type: String, default: "" },
    quantity: { type: Number, required: false },
    ccids: { type: [String], default: [] },
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
    department: { type: String, default: "" },
    removedDevices: {
      type: [
        {
          deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "devices" },
          serialNo: { type: String, default: "" },
          imeiNo: { type: String, default: "" },
          ccid: { type: String, default: "" },
          customFieldsRemoved: {
            type: [{ path: String, value: String, _id: false }],
            default: [],
          },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

ccidTransferRequestSchema.index({ status: 1, createdAt: -1 });
ccidTransferRequestSchema.index({ fromProcessId: 1, toProcessId: 1, createdAt: -1 });

module.exports = mongoose.model("ccidTransferRequests", ccidTransferRequestSchema);
