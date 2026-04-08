const mongoose = require("mongoose");

const gatePassSchema = new mongoose.Schema(
  {
    gatePassNumber: { type: String, required: true, trim: true, unique: true },
    dispatchInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DispatchInvoice",
      required: true,
      index: true,
    },
    invoiceNumber: { type: String, required: true, trim: true },
    customerName: { type: String, required: true, trim: true },
    dispatchDate: { type: Date, required: true },
    cartonCount: { type: Number, default: 0 },
    totalQuantity: { type: Number, default: 0 },
    includeImeiList: { type: Boolean, default: false },
    generatedHtml: { type: String, default: "" },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    printedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("GatePass", gatePassSchema);
