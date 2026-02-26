const mongoose = require("mongoose");

const breakSchema = new mongoose.Schema(
  {
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: false, default: null },
    reason: { type: String, required: false, default: "" },
  },
  { _id: false }
);

const operatorWorkSessionSchema = new mongoose.Schema({
  operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlaningAndScheduling", required: false, default: null },

  taskUrl: { type: String, required: false, default: "" },

  status: {
    type: String,
    enum: ["active", "stopped", "completed"],
    default: "active",
    required: true,
  },

  startedAt: { type: Date, required: true, default: Date.now },
  endedAt: { type: Date, required: false, default: null },

  stopReason: { type: String, required: false, default: "" },

  scheduledShift: {
    type: {
      formattedShiftDate: { type: String, required: false, default: null },
      startTime: { type: String, required: false, default: null },
      endTime: { type: String, required: false, default: null },
      shiftStartAt: { type: Date, required: false, default: null },
      shiftEndAt: { type: Date, required: false, default: null },
    },
    required: false,
    default: {},
  },

  breaks: { type: [breakSchema], required: false, default: [] },
  breakTotalMs: { type: Number, required: false, default: 0 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

operatorWorkSessionSchema.index({ operatorId: 1, processId: 1, status: 1 });
operatorWorkSessionSchema.index({ operatorId: 1, startedAt: -1 });

const OperatorWorkSession = mongoose.model("OperatorWorkSession", operatorWorkSessionSchema);

module.exports = OperatorWorkSession;

