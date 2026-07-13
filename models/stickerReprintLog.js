const mongoose = require("mongoose");

// Audit trail for device-sticker reprints done outside the normal FQC print
// step (e.g. from the Device History modal). Duplicate labels on the floor are
// a traceability risk, so every reprint records who printed what and when.
const stickerReprintLogSchema = new mongoose.Schema(
  {
    serialNo: { type: String, required: true, trim: true },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "devices", default: null },
    processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", default: null },
    stageName: { type: String, default: "" },
    templateNames: { type: [String], default: [] },
    copies: { type: Number, default: 1 },
    printedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    source: { type: String, default: "device-history" },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

stickerReprintLogSchema.index({ serialNo: 1, createdAt: -1 });
stickerReprintLogSchema.index({ processId: 1, createdAt: -1 });

const StickerReprintLog = mongoose.model("StickerReprintLog", stickerReprintLogSchema);

module.exports = StickerReprintLog;
