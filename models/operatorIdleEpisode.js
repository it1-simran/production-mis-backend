const mongoose = require("mongoose");

// Tracks idle-popup state at the OPERATOR ACCOUNT level (not per device/process),
// so that if the same account is logged in on multiple devices simultaneously,
// resolving the idle popup on one device can be detected by the others and
// auto-dismiss their own popup instead of requiring a second response.
// One "pending" episode should exist per operator at a time; resolved episodes
// are kept as history (mirrors how OperatorIdleLog already accumulates history).
const operatorIdleEpisodeSchema = new mongoose.Schema({
  operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  idleStartTime: { type: Date, required: true },
  status: {
    type: String,
    enum: ["pending", "resolved"],
    default: "pending",
    required: true,
  },
  resolvedAt: { type: Date, required: false, default: null },
  resolvedReasonCode: { type: String, required: false, default: null },
  createdAt: { type: Date, default: Date.now },
});

operatorIdleEpisodeSchema.index({ operatorId: 1, status: 1, createdAt: -1 });

const OperatorIdleEpisode = mongoose.model("OperatorIdleEpisode", operatorIdleEpisodeSchema);

module.exports = OperatorIdleEpisode;
