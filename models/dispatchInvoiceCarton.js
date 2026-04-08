const mongoose = require("mongoose");

const dispatchInvoiceCartonSchema = new mongoose.Schema(
  {
    dispatchInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DispatchInvoice",
      required: true,
      index: true,
    },
    cartonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CartonManagement",
      required: true,
      unique: true,
    },
    cartonSerial: { type: String, required: true, trim: true },
    processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", default: null },
    processName: { type: String, default: "" },
    modelName: { type: String, default: "", trim: true },
    deviceCount: { type: Number, default: 0 },
    statusAtDispatch: { type: String, default: "" },
    dispatchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

dispatchInvoiceCartonSchema.index({ cartonSerial: 1 });

module.exports = mongoose.model("DispatchInvoiceCarton", dispatchInvoiceCartonSchema);
