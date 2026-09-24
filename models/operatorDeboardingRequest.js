const mongoose = require("mongoose");

const vacatedAssignmentSchema = new mongoose.Schema(
  {
    processId: { type: mongoose.Schema.Types.ObjectId, ref: "process" },
    processName: { type: String, default: "" },
    roomName: { type: mongoose.Schema.Types.ObjectId, ref: "roomplans" },
    seatDetails: {
      rowNumber: { type: String, default: "" },
      seatNumber: { type: String, default: "" },
    },
    stageType: { type: String, default: "" },
    requiredSkill: { type: String, default: "" },
    replacementOperatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    replacementOperatorName: { type: String, default: "" },
    replacementAssignedAt: { type: Date, default: null },
  },
  { _id: false },
);

const operatorDeboardingRequestSchema = new mongoose.Schema(
  {
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    operatorName: { type: String, default: "" },
    employeeCode: { type: String, default: "" },
    skills: { type: [String], default: [] },
    reason: { type: String, required: true },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
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
      default: null,
    },
    approverName: { type: String, default: "" },
    rejectionReason: { type: String, default: "" },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    vacatedAssignments: { type: [vacatedAssignmentSchema], default: [] },
  },
  { timestamps: true },
);

operatorDeboardingRequestSchema.index({ status: 1, createdAt: -1 });
operatorDeboardingRequestSchema.index({ operatorId: 1, status: 1 });

module.exports = mongoose.model(
  "operatorDeboardingRequest",
  operatorDeboardingRequestSchema,
);
