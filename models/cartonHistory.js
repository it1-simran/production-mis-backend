const mongoose = require("mongoose");

const cartonHistorySchema = new mongoose.Schema(
  {
    cartonSerial: { type: String, required: true, index: true },
    cartonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CartonManagement",
      required: true,
      index: true,
    },
    processId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "processes",
      required: true,
      index: true,
    },
    eventType: { type: String, required: true },
    fromCartonStatus: { type: String, default: "" },
    toCartonStatus: { type: String, default: "" },
    fromDeviceStage: { type: String, default: "" },
    toDeviceStage: { type: String, default: "" },
    reasonCode: { type: String, default: "" },
    reasonText: { type: String, default: "" },
    notes: { type: String, default: "" },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cycleNo: { type: Number, default: 0 },
    weightAtEvent: { type: String, default: "" },
    stickerPrintedState: { type: Boolean, default: false },
    stickerVerifiedState: { type: Boolean, default: false },
    extra: { type: mongoose.Schema.Types.Mixed, default: null },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CartonHistory", cartonHistorySchema);
