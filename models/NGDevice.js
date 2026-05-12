const mongoose = require("mongoose");

const NGDeviceSchema = new mongoose.Schema({
  processId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "process",
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  department: { type: String, required: true },
  serialNo: { type: String, required: true, trim: true },
  ngStage: { type: String, required: true, trim: true },
  notes: { type: String, default: "" },
  ngDescription: { type: String, default: "" },
  reason: { type: String, default: "" },
  logData: { type: mongoose.Schema.Types.Mixed, required: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

NGDeviceSchema.index({ serialNo: 1 });
NGDeviceSchema.index({ processId: 1, serialNo: 1 });

module.exports = mongoose.model("NGDevice", NGDeviceSchema);
