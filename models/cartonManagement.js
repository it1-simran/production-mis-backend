const mongoose = require("mongoose");

const cartonManagementSchema = new mongoose.Schema(
  {
    cartonSerial: { type: String, required: true },
    processId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "processes",
      required: true,
    },
    devices: [{ type: mongoose.Schema.Types.ObjectId, ref: "devices" }],
    packagingData: {
      packagingType: { type: String, required: false, default: "" },
      cartonWidth: { type: Number, required: false, default: 0 },
      cartonHeight: { type: Number, required: false, default: 0 },
      cartonDepth: { type: Number, required: false, default: 0 },
      maxCapacity: { type: Number, required: false, default: 0 },
      cartonWeight: { type: Number, required: false, default: 0 },
      cartonWeightTolerance: { type: Number, required: false, default: 0 },
    },
    cartonSize: {
      width: { type: String, required: false, default: "" },
      height: { type: String, required: false, default: "" },
      depth: { type: String, required: false, default: "" },
    },
    maxCapacity: { type: String, required: false, default: "" },
    status: { type: String, required: false, default: "" },
    isStickerVerified: { type: Boolean, required: false, default: false },
    isStickerPrinted: { type: Boolean, required: false, default: false },
    isWeightVerified: { type: Boolean, required: false, default: false },
    cartonStatus: { type: String, required: false, default: "" },
    weightCarton: { type: String, required: false, default: "" },
    isLooseCarton: { type: Boolean, required: false, default: false },
    looseCartonAction: { type: String, required: false, default: "" },
    sourceCartonSerial: { type: String, required: false, default: "" },
    reassignedCartonSerial: { type: String, required: false, default: "" },
    reassignedQuantity: { type: Number, required: false, default: 0 },
    looseCartonClosedAt: { type: Date, required: false, default: null },
    previousCartonStatus: { type: String, required: false, default: "" },
    previousDeviceStage: { type: String, required: false, default: "" },
    isReturnedFromPdi: { type: Boolean, required: false, default: false },
    returnedFromPdiAt: { type: Date, required: false, default: null },
    lastSentToPdiAt: { type: Date, required: false, default: null },
    cartonReworkCount: { type: Number, required: false, default: 0 },
    lastPdiNgReasonCode: { type: String, required: false, default: "" },
    lastPdiNgReasonText: { type: String, required: false, default: "" },
    lastPdiNgNotes: { type: String, required: false, default: "" },
  },
  { timestamps: true }
);

const CartonManagement = mongoose.model(
  "CartonManagement",
  cartonManagementSchema
);
module.exports = CartonManagement;

