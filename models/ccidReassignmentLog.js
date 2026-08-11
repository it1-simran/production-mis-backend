const mongoose = require("mongoose");

const ccidReassignmentLogSchema = new mongoose.Schema(
  {
    ccid: { type: String, required: true },
    fromSerialNo: { type: String, required: true },
    toSerialNo: { type: String, required: true },
    fromProcessId: { type: mongoose.Schema.Types.ObjectId, ref: "process", required: false },
    toProcessId: { type: mongoose.Schema.Types.ObjectId, ref: "process", required: false },
    stageName: { type: String, required: false },
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlaningAndScheduling", required: false },
  },
  { timestamps: true },
);

ccidReassignmentLogSchema.index({ ccid: 1, createdAt: -1 });
ccidReassignmentLogSchema.index({ fromSerialNo: 1 });
ccidReassignmentLogSchema.index({ toSerialNo: 1 });

module.exports = mongoose.model("ccidReassignmentLogs", ccidReassignmentLogSchema);
