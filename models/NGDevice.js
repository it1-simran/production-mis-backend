const mongoose = require("mongoose");

const NGDeviceSchema = new mongoose.Schema({
  processId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "processes",
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "users",
    required: true,
  },
  department: { type: String, enum: ["QC", "TRC"], required: true },
  serialNo: { type: String, required: true, trim: true },
  ngStage: { type: String, required: true, trim: true },
  notes: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// index for faster lookups by serial number
// NGDeviceSchema.index({ serialNo: 1 });

module.exports = mongoose.model("NGDevice", NGDeviceSchema);
