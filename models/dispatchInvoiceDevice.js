const mongoose = require("mongoose");

const dispatchInvoiceDeviceSchema = new mongoose.Schema(
  {
    dispatchInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DispatchInvoice",
      required: true,
      index: true,
    },
    dispatchCartonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DispatchInvoiceCarton",
      required: true,
    },
    deviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "devices",
      required: true,
      unique: true,
    },
    serialNo: { type: String, required: true, trim: true, index: true },
    imeiNo: { type: String, default: "", index: true },
    modelName: { type: String, default: "", trim: true },
    cartonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CartonManagement",
      required: true,
    },
    cartonSerial: { type: String, required: true, trim: true },
    customerName: { type: String, required: true, trim: true },
    invoiceNumber: { type: String, required: true, trim: true },
    dispatchDate: { type: Date, required: true },
    warrantyStartDate: { type: Date, default: null },
    warrantyEndDate: { type: Date, default: null, index: true },
    warrantyMonths: { type: Number, default: 12 },
    status: {
      type: String,
      enum: ["DISPATCHED", "RETURNED", "RMA_HOLD"],
      default: "DISPATCHED",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DispatchInvoiceDevice", dispatchInvoiceDeviceSchema);
