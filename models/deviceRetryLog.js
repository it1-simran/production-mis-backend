const mongoose = require("mongoose");

const deviceRetryLogSchema = new mongoose.Schema(
  {
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "devices", required: false },
    serialNo: { type: String, required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlaningAndScheduling", required: true },
    processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", required: true },
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    stageName: { type: String, required: false, default: "" },
    seatKey: { type: String, required: false, default: "" },
    attemptNumber: { type: Number, required: true, default: 1 },
    startTime: { type: Date, required: false },
    endTime: { type: Date, required: false },
    durationMs: { type: Number, required: false, default: 0 },
    failureReason: { type: String, required: false, default: "" },
  },
  { timestamps: true }
);

deviceRetryLogSchema.index({ processId: 1, serialNo: 1 });
deviceRetryLogSchema.index({ serialNo: 1, stageName: 1 });

const DeviceRetryLog = mongoose.model("device_retry_logs", deviceRetryLogSchema);

module.exports = DeviceRetryLog;
