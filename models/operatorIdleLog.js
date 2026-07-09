const mongoose = require("mongoose");

const IDLE_REASONS = {
  LUNCH_BREAK: "Lunch Break",
  TEA_BREAK: "Tea Break",
  WASHROOM_BREAK: "Washroom Break",
  MATERIAL_WAITING: "Material Waiting",
  SUPERVISOR_DISCUSSION: "Supervisor Discussion",
  MACHINE_BREAKDOWN: "Machine Breakdown",
  SYSTEM_ISSUE: "System Issue",
  OTHER: "Other",
};

const operatorIdleLogSchema = new mongoose.Schema(
  {
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlaningAndScheduling", required: false, default: null },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "OperatorWorkSession", required: false, default: null },

    idleStartTime: { type: Date, required: true },
    idleEndTime: { type: Date, required: true },
    durationMs: { type: Number, required: true, default: 0 },

    reasonCode: {
      type: String,
      enum: Object.keys(IDLE_REASONS),
      required: true,
    },
    reasonLabel: { type: String, required: true },
    remarks: { type: String, required: false, default: "" },

    stageName: { type: String, required: false, default: "" },
  },
  { timestamps: true }
);

operatorIdleLogSchema.index({ operatorId: 1, idleStartTime: -1 });
operatorIdleLogSchema.index({ processId: 1, idleStartTime: -1 });

const OperatorIdleLog = mongoose.model("OperatorIdleLog", operatorIdleLogSchema);

module.exports = OperatorIdleLog;
module.exports.IDLE_REASONS = IDLE_REASONS;
