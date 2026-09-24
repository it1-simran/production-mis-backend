const mongoose = require("mongoose");

/**
 * A SKU request raised by a customer in GPS CPanel (Manufacturer/Dealer/Admin)
 * and reviewed here in MES in two stages: Sales first (allots/confirms the
 * Model Name + Vendor ID for that customer+firmware), then NPD (final
 * technical approval). MES (this collection) is the system of record;
 * CPanel is a thin client that pushes/reads via the integration API —
 * mirrors PurchaseOrder.js's cpanel-integration shape exactly.
 */
const statusHistorySchema = new mongoose.Schema(
  {
    fromStatus: { type: String, default: null },
    toStatus: { type: String, required: true },
    // Who acted: "cpanel" (raise/edit) or "mes" (Sales/NPD approve/reject)
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
    // Whose eSIM inventory this SKU uses: "jsd" (make/profile1/2 come from
    // MES's own eSIM catalog) or "customer" (customer-supplied, free text).
    provider: { type: String, enum: ["jsd", "customer"], default: "jsd" },
    make: { type: String, default: "" },
    profile1: { type: String, default: "" },
    profile2: { type: String, default: "" },
  },
  // Not required when esim.provider is "customer" — a customer-supplied eSIM
  // isn't recharged through JSD (enforced in skuRequestController, not here).
  esimRechargePeriod: { type: String, enum: ["1_year", "2_year", ""], default: "" },
  firmware: {
    id: { type: Number, default: null },
    name: { type: String, default: "" },
  },
  modelName: { type: String, default: "" },
  vendorId: { type: String, default: "" },
  // Whether Sales found an existing Model+Vendor ID already allotted to this
  // customer+firmware in GPSCPANEL ("existing") or had to allot a new one
  // ("new") — set when Sales approves, empty until then.
  modelAllotmentSource: { type: String, enum: ["existing", "new", ""], default: "" },
  // A sample serial number pattern for this SKU's devices (e.g. "JSD-XXXX-000000").
  serialNumberFormat: { type: String, default: "" },
  // Packaging type: devices packed straight into one master carton, or each
  // unit individually boxed — and which MES sticker format is printed on it.
  cartonType: { type: String, enum: ["direct_master_carton", "unit_packaging", ""], default: "direct_master_carton" },
  stickerFormat: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: "StickerFormatMaster", default: null },
    name: { type: String, default: "" },
  },
  // NPD-owned reference numbers — not submitted by the customer; NPD adds/
  // edits these (independent of approve/reject) via a dedicated endpoint, at
  // any stage of review.
  fgBomNumber: { type: String, default: "" },
  tranzactId: { type: String, default: "" },

  // Frozen device-category configuration snapshot sent by CPanel:
  // { categoryId, firmwareId, snapshotAt, hash, values:{key:{id,value}}, schema:[...] }
  configuration: { type: mongoose.Schema.Types.Mixed, default: {} },

  // PendingSales -> PendingNpd -> Completed, or Rejected at either stage
  // (a resubmission after Rejected always re-enters at PendingSales, since
  // an edit could touch device category/firmware and invalidate Sales's
  // model allotment).
  status: {
    type: String,
    enum: ["PendingSales", "PendingNpd", "Completed", "Rejected"],
    default: "PendingSales",
    index: true,
  },
  // Which stage most recently rejected this request (null once resubmitted
  // or if never rejected) — lets CPanel show the right remarks/reviewer.
  rejectedAtStage: { type: String, enum: ["sales", "npd", ""], default: "" },
  salesRemarks: { type: String, default: "" },
  npdRemarks: { type: String, default: "" },
  // Set when Rejected (whichever stage rejected it): may the customer edit & resubmit?
  resubmissionAllowed: { type: Boolean, default: false },

  salesReviewedBy: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, default: "" },
  },
  salesReviewedAt: { type: Date, default: null },

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
