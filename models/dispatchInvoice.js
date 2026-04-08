const mongoose = require("mongoose");

const pricingSummarySchema = new mongoose.Schema(
  {
    currency: { type: String, default: "INR" },
    subtotal: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
  },
  { _id: false }
);

const logisticsDetailsSchema = new mongoose.Schema(
  {
    transporterName: { type: String, default: "" },
    transportMode: {
      type: String,
      enum: ["", "Road", "Air", "Rail", "Courier", "Hand Delivery"],
      default: "",
    },
    vehicleNumber: { type: String, default: "" },
    referenceNumber: { type: String, default: "" },
  },
  { _id: false }
);

const dispatchInvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, trim: true, unique: true },
    customerName: { type: String, required: true, trim: true },
    contactPerson: { type: String, default: "" },
    customerEmail: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    ewayBillNo: { type: String, default: "" },
    logisticsDetails: { type: logisticsDetailsSchema, default: () => ({}) },
    invoiceDate: { type: Date, required: true },
    dispatchDate: { type: Date, required: true },
    remarks: { type: String, default: "" },
    status: {
      type: String,
      enum: ["DRAFT", "CONFIRMED", "CANCELLED"],
      default: "DRAFT",
    },
    pricingSummary: { type: pricingSummarySchema, default: () => ({}) },
    selectedCartons: [
      {
        cartonId: { type: mongoose.Schema.Types.ObjectId, ref: "CartonManagement" },
        cartonSerial: { type: String, required: true },
        processId: { type: mongoose.Schema.Types.ObjectId, ref: "process" },
        processName: { type: String, default: "" },
        deviceCount: { type: Number, default: 0 },
      },
    ],
    selectedCartonCount: { type: Number, default: 0 },
    totalQuantity: { type: Number, default: 0 },
    gatePassNumber: { type: String, default: "" },
    reservedAt: { type: Date, default: null },
    reservationExpiresAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

dispatchInvoiceSchema.index({ status: 1, dispatchDate: -1 });
dispatchInvoiceSchema.index({ customerName: 1 });

module.exports = mongoose.model("DispatchInvoice", dispatchInvoiceSchema);
