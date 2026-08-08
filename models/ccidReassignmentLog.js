const mongoose = require("mongoose");

const ccidReassignmentLogSchema = new mongoose.Schema({
  ccid: { type: String, required: true },
  // Device that previously held the CCID — cleared automatically
  fromDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: "devices", default: null },
  fromSerialNo: { type: String, default: "" },
  fromProcessId: { type: mongoose.Schema.Types.ObjectId, ref: "process", default: null },
  // Device on the jig that triggered the reassignment
  toDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: "devices", default: null },
  toSerialNo: { type: String, default: "" },
  toProcessId: { type: mongoose.Schema.Types.ObjectId, ref: "process", default: null },
  stageName: { type: String, default: "" },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlaningAndScheduling", default: null },
  operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now },
});

ccidReassignmentLogSchema.index({ ccid: 1 });
ccidReassignmentLogSchema.index({ fromSerialNo: 1 });
ccidReassignmentLogSchema.index({ toSerialNo: 1 });
ccidReassignmentLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("CcidReassignmentLog", ccidReassignmentLogSchema, "ccidReassignmentLogs");
