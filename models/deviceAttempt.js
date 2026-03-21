const mongoose = require("mongoose");

const deviceAttemptSchema = new mongoose.Schema(
  {
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "devices", required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlaningAndScheduling", required: true },
    processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", required: true },
    stageName: { type: String, required: false, default: "" },
    stageAttempts: { type: Map, of: Number, default: {} },
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    attemptCount: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

deviceAttemptSchema.index({ deviceId: 1, planId: 1, processId: 1 }, { unique: true });

const DeviceAttempt = mongoose.model("device_attempts", deviceAttemptSchema);

module.exports = DeviceAttempt;
