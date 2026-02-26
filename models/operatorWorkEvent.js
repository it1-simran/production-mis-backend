const mongoose = require("mongoose");

const operatorWorkEventSchema = new mongoose.Schema({
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "OperatorWorkSession",
    required: true,
  },
  operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlaningAndScheduling", required: false, default: null },

  occurredAt: { type: Date, required: true, default: Date.now }, // server time
  clientOccurredAt: { type: Date, required: false, default: null }, // client provided time (optional)

  actionType: { type: String, required: true }, // e.g. CLICK / SUBMIT / API / NAVIGATION
  actionName: { type: String, required: true }, // e.g. "STOP_CLICKED", "PACKAGING_SUBMIT"
  payload: { type: mongoose.Schema.Types.Mixed, required: false, default: {} },

  pageUrl: { type: String, required: false, default: "" },
  userAgent: { type: String, required: false, default: "" },
  ip: { type: String, required: false, default: "" },

  createdAt: { type: Date, default: Date.now },
});

operatorWorkEventSchema.index({ sessionId: 1, occurredAt: 1 });
operatorWorkEventSchema.index({ operatorId: 1, occurredAt: -1 });
operatorWorkEventSchema.index({ processId: 1, occurredAt: -1 });

const OperatorWorkEvent = mongoose.model("OperatorWorkEvent", operatorWorkEventSchema);

module.exports = OperatorWorkEvent;

