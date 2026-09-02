const mongoose = require("mongoose");

/**
 * A SKU request raised by a customer in GPS CPanel (Manufacturer/Dealer/Admin)
 * and approved by NPD here in MES. MES (this collection) is the system of
 * record; CPanel is a thin client that pushes/reads via the integration API —
 * mirrors PurchaseOrder.js's cpanel-integration shape exactly.
 */
const statusHistorySchema = new mongoose.Schema(
  {
    fromStatus: { type: String, default: null },
    toStatus: { type: String, required: true },
    // Who acted: "cpanel" (raise/edit) or "mes" (NPD approve/reject)
    actorType: { type: String, enum: ["cpanel", "mes"], required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    changedByName: { type: String, default: "" },
    remarks: { type: String, default: "" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const skuRequestSchema = new mongoose.Schema({
  skuCode: { type: String, unique: true, sparse: true },
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

  // Frozen device-category configuration snapshot sent by CPanel:
  // { categoryId, firmwareId, snapshotAt, hash, values:{key:{id,value}}, schema:[...] }
  configuration: { type: mongoose.Schema.Types.Mixed, default: {} },

  status: {
    type: String,
    enum: ["Pending", "Approved", "Rejected"],
    default: "Pending",
    index: true,
  },
  npdRemarks: { type: String, default: "" },
  // NPD decision (set when Rejected): may the customer edit & resubmit?
  resubmissionAllowed: { type: Boolean, default: false },

  approvedBy: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, default: "" },
  },
  approvedAt: { type: Date, default: null },

  statusHistory: { type: [statusHistorySchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

skuRequestSchema.index({ "raisedBy.cpanelUserId": 1, status: 1 });

skuRequestSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

const SkuRequest = mongoose.model("skuRequests", skuRequestSchema);

module.exports = SkuRequest;
