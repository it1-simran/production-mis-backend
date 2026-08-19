const mongoose = require("mongoose");

/**
 * Purchase Order raised by a customer in GPS CPanel (Manufacturer/Dealer/Admin)
 * and approved by Sales here in MES. MES (this collection) is the system of
 * record; CPanel is a thin client that pushes/reads via the integration API.
 */
const statusHistorySchema = new mongoose.Schema(
  {
    fromStatus: { type: String, default: null },
    toStatus: { type: String, required: true },
    // Who acted: "cpanel" (raise/edit) or "mes" (sales approve/reject)
    actorType: { type: String, enum: ["cpanel", "mes"], required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    changedByName: { type: String, default: "" },
    remarks: { type: String, default: "" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema({
  poNumber: { type: String, unique: true, sparse: true },
  source: { type: String, default: "gpscpanel" },

  raisedBy: {
    cpanelUserId: { type: Number, default: null },
    name: { type: String, default: "" },
    role: { type: String, default: "" }, // Reseller / User / Admin
    email: { type: String, default: "" },
    mobile: { type: String, default: "" },
  },

  deviceCategory: {
    id: { type: Number, default: null },
    name: { type: String, default: "" },
  },
  // eSIM make + its two profiles (mirrors EsimMaster: esimMake / profile1 / profile2)
  esim: {
    make: { type: String, default: "" },
    profile1: { type: String, default: "" },
    profile2: { type: String, default: "" },
  },
  esimRechargePeriod: { type: String, enum: ["1_year", "2_year"], required: true },
  firmware: {
    id: { type: Number, default: null },
    name: { type: String, default: "" },
  },
  modelName: { type: String, default: "" },
  vendorId: { type: String, default: "" },
  expectedDeliveryDate: { type: Date, default: null },
  requiredQuantity: { type: Number, required: true, min: 1 },

  // Frozen device-category configuration snapshot sent by CPanel:
  // { categoryId, firmwareId, snapshotAt, hash, values:{key:{id,value}}, schema:[...] }
  configuration: { type: mongoose.Schema.Types.Mixed, default: {} },

  status: {
    type: String,
    enum: ["Pending", "Approved", "Rejected"],
    default: "Pending",
    index: true,
  },
  salesRemarks: { type: String, default: "" },
  // Sales decision (set when Rejected): may the customer edit & resubmit?
  resubmissionAllowed: { type: Boolean, default: false },
  // Order Confirmation number created by Accounts from this PO (link back).
  ocNumber: { type: String, default: "" },
  // Accounts fulfilment lifecycle (separate from Sales `status` so Sales tabs
  // stay intact). Short stock -> OC path; sufficient stock -> invoice + dispatch.
  fulfilment: {
    state: {
      type: String,
      enum: ["awaiting", "oc_raised", "engineering_pending", "engineering_approved", "invoiced", "dispatched"],
      default: "awaiting",
    },
    availableAtCheck: { type: Number, default: null }, // stock seen at last decision
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "DispatchInvoice", default: null },
    invoiceNumber: { type: String, default: "" },
    ewayBillNo: { type: String, default: "" },
    decidedAt: { type: Date, default: null },
    // Product auto-created from this PO (Engineering approval activates it).
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "products", default: null },
    productName: { type: String, default: "" },
  },
  approvedBy: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, default: "" },
  },
  approvedAt: { type: Date, default: null },

  statusHistory: { type: [statusHistorySchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

purchaseOrderSchema.index({ "raisedBy.cpanelUserId": 1, status: 1 });

purchaseOrderSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

const PurchaseOrder = mongoose.model("purchaseOrders", purchaseOrderSchema);

module.exports = PurchaseOrder;
