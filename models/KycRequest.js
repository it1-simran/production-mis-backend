const mongoose = require("mongoose");

/**
 * Customer KYC (organization/GST/PAN details) submitted from GPS CPanel and
 * reviewed by MES's Accounts team. MES is the system of record for the
 * decision — CPanel is a thin client that pushes/reads via the integration
 * API, mirroring SkuRequest.js's cpanel-integration shape exactly.
 */
const statusHistorySchema = new mongoose.Schema(
  {
    fromStatus: { type: String, default: null },
    toStatus: { type: String, required: true },
    // Who acted: "cpanel" (submit/resubmit) or "mes" (Accounts approve/reject)
    actorType: { type: String, enum: ["cpanel", "mes"], required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    changedByName: { type: String, default: "" },
    remarks: { type: String, default: "" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const kycRequestSchema = new mongoose.Schema({
  source: { type: String, default: "gpscpanel" },

  raisedBy: {
    cpanelUserId: { type: Number, default: null, index: true },
    name: { type: String, default: "" },
    role: { type: String, default: "" }, // Reseller / User / Admin
    email: { type: String, default: "" },
    mobile: { type: String, default: "" },
  },

  organizationName: { type: String, default: "" },
  gstin: { type: String, default: "" },
  panNumber: { type: String, default: "" },
  organizationAddress: { type: String, default: "" },
  // CPanel still hosts the actual file — MES never stores it or a URL to it,
  // only whether one exists, so the review UI knows to show a "View
  // Document" button. The button fetches the file on demand via a proxy
  // route keyed on raisedBy.cpanelUserId (see kycController.js getDocument).
  hasDocument: { type: Boolean, default: false },

  status: {
    type: String,
    enum: ["Pending", "Approved", "Rejected"],
    default: "Pending",
    index: true,
  },
  remarks: { type: String, default: "" },
  // Accounts decision (set when Rejected): may the customer edit & resubmit?
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

kycRequestSchema.index({ "raisedBy.cpanelUserId": 1, status: 1 });

kycRequestSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

const KycRequest = mongoose.model("kycRequests", kycRequestSchema);

module.exports = KycRequest;
