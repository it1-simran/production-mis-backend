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

  // The approved SKU this PO was raised against — frozen snapshot fields
  // (not re-derived per PO, same as configuration/esim below).
  skuCode: { type: String, default: "" },
  serialNumberFormat: { type: String, default: "" },
  cartonType: { type: String, enum: ["direct_master_carton", "unit_packaging", ""], default: "" },
  stickerFormat: {
    id: { type: String, default: null },
    name: { type: String, default: "" },
  },
  fgBomNumber: { type: String, default: "" },
  tranzactId: { type: String, default: "" },

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
    // Whose eSIM (from the SKU): "jsd" needs a recharge period, "customer"
    // doesn't, "" = the device category has no eSIM. Blank on older POs.
    provider: { type: String, default: "" },
    make: { type: String, default: "" },
    profile1: { type: String, default: "" },
    profile2: { type: String, default: "" },
  },
  // Who actually submitted it in GPSCPANEL (an admin raising it for a customer).
  raisedByActual: {
    cpanelUserId: { type: Number, default: null },
    name: { type: String, default: "" },
    role: { type: String, default: "" },
  },
  // Blank when the PO's Device Category has no eSIM at all (inherited from
  // its SKU) — otherwise 1_year/2_year for a JSD-managed eSIM.
  esimRechargePeriod: { type: String, enum: ["1_year", "2_year", ""], default: "" },
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

  // Who arranges delivery for this PO, and the details relevant to that choice.
  logistics: {
    managedBy: { type: String, enum: ["us", "customer"], default: "us" },
    // "us" branch — we deliver to the customer.
    deliveryAddress: { type: String, default: "" },
    contactName: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    deliveryMode: { type: String, default: "" }, // Road / Air / Rail / Courier
    insuranceRequired: { type: Boolean, default: false },
    // "customer" branch — customer arranges their own pickup.
    transporterName: { type: String, default: "" },
    transporterContact: { type: String, default: "" },
    vehicleNumber: { type: String, default: "" },
    pickupDateTime: { type: Date, default: null },
    pickupPersonName: { type: String, default: "" },
    // Common to both.
    ewayBillBy: { type: String, enum: ["us", "customer"], default: "us" },
    specialInstructions: { type: String, default: "" },
  },

  // Pending (Sales) -> PendingPpc (PPC sets dispatch date) -> PendingSalesConfirm
  // (Sales confirms the date) -> Approved. Rejected only happens at the Sales
  // gates (Pending or, per existing behaviour, even after Approved) — PPC
  // itself never rejects, only sets a dispatch date and hands it back.
  status: {
    type: String,
    enum: ["Pending", "PendingPpc", "PendingSalesConfirm", "Approved", "Rejected"],
    default: "Pending",
    index: true,
  },
  salesRemarks: { type: String, default: "" },
  // Sales decision (set when Rejected): may the customer edit & resubmit?
  resubmissionAllowed: { type: Boolean, default: false },
  // PPC's estimated dispatch date for this PO (must be a future date at the
  // time it's set) and who/when set it.
  ppcDispatchDate: { type: Date, default: null },
  ppcReviewedBy: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, default: "" },
  },
  ppcReviewedAt: { type: Date, default: null },
  // Order Confirmation number created by Accounts from this PO (link back).
  ocNumber: { type: String, default: "" },
  // Accounts fulfilment lifecycle (separate from Sales `status` so Sales tabs
  // stay intact). Short stock -> OC path; sufficient stock -> invoice + dispatch.
  fulfilment: {
    state: {
      type: String,
      // NEW: "production_pending" - engineering_approved now auto-creates a
      // Process and routes here for Production Manager to plan/schedule it,
      // instead of stopping at engineering_approved.
      enum: ["awaiting", "oc_raised", "engineering_pending", "engineering_hold", "engineering_approved", "production_pending", "invoiced", "dispatched"],
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
    // NEW: Process auto-created from this PO's product on Engineering approval.
    processId: { type: mongoose.Schema.Types.ObjectId, ref: "process", default: null },
    processName: { type: String, default: "" },
    // Short-lived claim so two users can't run the same fulfilment step
    // (OC link, invoice, engineering approval) at once and create duplicate
    // Products/Processes/invoices. Set atomically, cleared when the step ends;
    // a stale claim (crashed request) expires — see claimPoLock().
    lockedAt: { type: Date, default: null },
  },
  approvedBy: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, default: "" },
  },
  approvedAt: { type: Date, default: null },

  // Accessories required with this PO's devices — a frozen snapshot of the
  // Product Category mapping at PO creation (like the SKU fields), validated
  // server-side (services/poAccessoryService). reserved/issued/returned are
  // maintained only by services/accessoryStockService.
  accessories: {
    type: [
      {
        _id: false,
        accessoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Accessory", required: true },
        code: { type: String, default: "" },
        name: { type: String, default: "" },
        unit: { type: String, default: "pcs" },
        trackStock: { type: Boolean, default: true },
        mandatory: { type: Boolean, default: false },
        qtyMode: { type: String, enum: ["per_device", "per_po"], default: "per_device" },
        qtyPerUnit: { type: Number, default: 1 }, // per device (per_device) or total (per_po)
        requiredQty: { type: Number, default: 0 },
        reservedQty: { type: Number, default: 0 },
        issuedQty: { type: Number, default: 0 },
        returnedQty: { type: Number, default: 0 },
      },
    ],
    default: [],
  },
  // Short-lived claim so two store users can't issue/return this PO's
  // accessories at the same moment (see poAccessoryService.withPoLock).
  accessoriesLockedAt: { type: Date, default: null },
  accessoriesLockToken: { type: String, default: "" }, // who holds it — only the holder may release it

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

// Process → PO lookups (accessory checklist per device, planning view).
purchaseOrderSchema.index({ "fulfilment.processId": 1 });

module.exports = PurchaseOrder;
