const PurchaseOrder = require("../models/PurchaseOrder");
const Sequence = require("../models/Sequence");
const EsimMake = require("../models/EsimMake");
const EsimProfile = require("../models/EsimProfile");
const DispatchService = require("../services/dispatchService");
const Product = require("../models/Products");
const ProductCategory = require("../models/productCategory");
const SlugMapping = require("../models/slugMapping");
const { createProductFromPO, resolveProductCategory } = require("../services/poProductService");
const { resolveTestingPlan } = require("../services/slugResolver");
const { createInventoryForProduct } = require("../services/inventoryService");

/**
 * The testing plan to apply for a PO: the product's own stages if it already has
 * them, else the mapped category's testing plan resolved against the PO (${slug}).
 */
async function resolvedPlanForPo(po, product) {
  if (product && Array.isArray(product.stages) && product.stages.length) return product.stages;
  const cat = await resolveProductCategory(po);
  if (cat && Array.isArray(cat.testingPlan) && cat.testingPlan.length) {
    const slugMaps = await SlugMapping.find({ isActive: true }).lean();
    const poObj = typeof po.toObject === "function" ? po.toObject() : po;
    return resolveTestingPlan(cat.testingPlan, poObj, slugMaps);
  }
  return [];
}

const dispatchService = new DispatchService();

/**
 * Finished-goods stock available for a model, from the same source the dispatch
 * screen uses (READY cartons in STOCKED state). Returns the total unit count and
 * the matching cartons (serial + count) so a dispatch draft can reserve them.
 */
async function modelStock(modelName) {
  const target = String(modelName || "").trim().toLowerCase();
  if (!target) return { available: 0, cartons: [] };
  const readyCartons = await dispatchService.getReadyCartons();
  const cartons = readyCartons
    .filter((c) => String(c.modelName || "").trim().toLowerCase() === target)
    .map((c) => ({ serial: c.cartonSerial, count: Number(c.deviceCount || 0) }));
  const available = cartons.reduce((sum, c) => sum + c.count, 0);
  return { available, cartons };
}

/** Greedily pick cartons (whole units) until their device count covers `need`. */
function selectCartonsForQuantity(cartons, need) {
  const picked = [];
  let sum = 0;
  for (const c of cartons) {
    if (sum >= need) break;
    picked.push(c);
    sum += c.count;
  }
  return { serials: picked.map((c) => c.serial), covered: sum };
}

/** Atomic, gap-free PO number: PO-YYYY-000123 */
async function nextPoNumber() {
  const year = new Date().getFullYear();
  const seq = await Sequence.findOneAndUpdate(
    { name: "purchase_order" },
    { $inc: { value: 1 } },
    { new: true, upsert: true }
  );
  return `PO-${year}-${String(seq.value).padStart(6, "0")}`;
}

const VALID_RECHARGE = ["1_year", "2_year"];

/** GET from GPSCPANEL's MES-integration API using the shared key. */
async function cpanelGet(path, params) {
  const base = (process.env.CPANEL_API_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("CPANEL_API_URL not configured");
  const url = new URL(base + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const r = await fetch(url, { headers: { "x-api-key": process.env.CPANEL_API_KEY || "" } });
  if (!r.ok) throw new Error(`CPanel responded ${r.status}`);
  return r.json();
}

module.exports = {
  /**
   * POST /integrations/cpanel/purchase-orders  (service-key auth)
   * Raise a PO from CPanel.
   */
  createFromCpanel: async (req, res) => {
    try {
      const b = req.body || {};

      const modelName = String(b.modelName || "").trim();
      const requiredQuantity = parseInt(b.requiredQuantity, 10);
      const esimRechargePeriod = String(b.esimRechargePeriod || "").trim();

      // modelName is optional — a PO can be raised without a configured model.
      if (!VALID_RECHARGE.includes(esimRechargePeriod)) {
        return res.status(400).json({ status: 400, message: "esimRechargePeriod must be 1_year or 2_year." });
      }
      if (!Number.isInteger(requiredQuantity) || requiredQuantity < 1) {
        return res.status(400).json({ status: 400, message: "requiredQuantity must be a positive integer." });
      }

      const poNumber = await nextPoNumber();
      const raisedBy = b.raisedBy || {};

      const po = new PurchaseOrder({
        poNumber,
        source: b.source || "gpscpanel",
        raisedBy: {
          cpanelUserId: raisedBy.cpanelUserId ?? null,
          name: raisedBy.name || "",
          role: raisedBy.role || "",
          email: raisedBy.email || "",
          mobile: raisedBy.mobile || "",
        },
        deviceCategory: { id: b.deviceCategory?.id ?? null, name: b.deviceCategory?.name || "" },
        esim: {
          make: b.esim?.make || "",
          profile1: b.esim?.profile1 || "",
          profile2: b.esim?.profile2 || "",
        },
        esimRechargePeriod,
        firmware: { id: b.firmware?.id ?? null, name: b.firmware?.name || "" },
        modelName,
        vendorId: b.vendorId || "",
        configuration: b.configuration && typeof b.configuration === "object" ? b.configuration : {},
        expectedDeliveryDate: b.expectedDeliveryDate ? new Date(b.expectedDeliveryDate) : null,
        requiredQuantity,
        status: "Pending",
        statusHistory: [
          {
            fromStatus: null,
            toStatus: "Pending",
            actorType: "cpanel",
            changedByName: raisedBy.name || "",
            remarks: "PO raised from GPS CPanel",
            changedAt: new Date(),
          },
        ],
      });

      const saved = await po.save();
      return res.status(200).json({
        status: 200,
        message: "Purchase Order raised successfully and sent for approval.",
        po_number: saved.poNumber,
        id: saved._id,
        data: saved,
      });
    } catch (error) {
      console.error("createFromCpanel error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /integrations/cpanel/purchase-orders  (service-key auth)
   * List POs for the CPanel tracking view. Non-admin callers pass raisedBy to
   * scope to their own POs; Admin (or no raisedBy) sees everything.
   */
  listForCpanel: async (req, res) => {
    try {
      const { raisedBy, role, search, status } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      const filter = {};
      if (raisedBy && String(role).toLowerCase() !== "admin") {
        filter["raisedBy.cpanelUserId"] = parseInt(raisedBy, 10);
      }
      if (status) filter.status = status;
      if (search) {
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [
          { poNumber: rx },
          { modelName: rx },
          { vendorId: rx },
          { "deviceCategory.name": rx },
          { "raisedBy.name": rx },
        ];
      }

      const total = await PurchaseOrder.countDocuments(filter);
      const data = await PurchaseOrder.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("listForCpanel error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /integrations/cpanel/purchase-orders/:id  (service-key auth)
   * Single PO for CPanel to prefill the edit/resubmit form.
   */
  getForCpanel: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id).lean();
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      return res.status(200).json({ status: 200, data: po });
    } catch (error) {
      console.error("getForCpanel error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /integrations/cpanel/purchase-orders/:id/resubmit  (service-key auth)
   * Customer edits & resubmits a rejected PO — only when the PO is Rejected AND
   * Sales allowed resubmission. Updates fields and returns it to Pending.
   */
  resubmitFromCpanel: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id);
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      if (po.status !== "Rejected") {
        return res.status(409).json({ status: 409, message: `Only a rejected PO can be resubmitted (this one is ${po.status}).` });
      }
      if (!po.resubmissionAllowed) {
        return res.status(403).json({ status: 403, message: "Sales has not permitted resubmission of this PO." });
      }

      const b = req.body || {};
      if (b.deviceCategory) po.deviceCategory = { id: b.deviceCategory.id ?? null, name: b.deviceCategory.name || "" };
      if (b.esim) po.esim = { make: b.esim.make || "", profile1: b.esim.profile1 || "", profile2: b.esim.profile2 || "" };
      if (b.esimRechargePeriod && VALID_RECHARGE.includes(b.esimRechargePeriod)) po.esimRechargePeriod = b.esimRechargePeriod;
      if (b.firmware) po.firmware = { id: b.firmware.id ?? null, name: b.firmware.name || "" };
      if (typeof b.modelName === "string") po.modelName = b.modelName;
      if (typeof b.vendorId === "string") po.vendorId = b.vendorId;
      if (b.expectedDeliveryDate) po.expectedDeliveryDate = new Date(b.expectedDeliveryDate);
      if (b.requiredQuantity != null) {
        const q = parseInt(b.requiredQuantity, 10);
        if (Number.isInteger(q) && q >= 1) po.requiredQuantity = q;
      }
      if (b.configuration && typeof b.configuration === "object") po.configuration = b.configuration;

      const prev = po.status;
      po.status = "Pending";
      po.resubmissionAllowed = false; // consumed
      po.approvedBy = { userId: null, name: "" };
      po.approvedAt = null;
      po.statusHistory.push({
        fromStatus: prev,
        toStatus: "Pending",
        actorType: "cpanel",
        changedByName: (po.raisedBy && po.raisedBy.name) || "",
        remarks: b.remarks || "Resubmitted after edit",
        changedAt: new Date(),
      });

      const saved = await po.save();
      return res.status(200).json({ status: 200, message: "Purchase Order resubmitted for approval.", po_number: saved.poNumber, id: saved._id, data: saved });
    } catch (error) {
      console.error("resubmitFromCpanel error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /integrations/cpanel/esim-options  (service-key auth)
   * eSIM makes + profiles for the CPanel PO form (make + its two profiles).
   */
  esimOptions: async (req, res) => {
    try {
      const [makes, profiles] = await Promise.all([
        EsimMake.find({ activeStatus: true, showInCpanel: true }).select("_id simId name").sort({ name: 1 }).lean(),
        EsimProfile.find({ activeStatus: true }).select("_id profileId name").sort({ name: 1 }).lean(),
      ]);
      // Profile name is stored as an array — flatten to a readable label.
      const flatProfiles = profiles.map((p) => ({
        profileId: p.profileId,
        name: Array.isArray(p.name) ? p.name.join(" / ") : String(p.name || ""),
      }));
      return res.status(200).json({ status: 200, makes, profiles: flatProfiles });
    } catch (error) {
      console.error("esimOptions error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * Master-data proxies for the Sales edit form — fetch GPSCPANEL catalogs
   * (device categories, firmware, model lookup). JWT + PURCHASE_ORDER read.
   */
  masterCategories: async (req, res) => {
    try {
      const d = await cpanelGet("/api/integrations/mes/device-categories");
      return res.status(200).json(d);
    } catch (e) {
      return res.status(502).json({ status: 502, message: "Could not reach CPanel", error: e.message });
    }
  },
  masterFirmware: async (req, res) => {
    try {
      const d = await cpanelGet("/api/integrations/mes/firmware", { category_id: req.query.category_id });
      return res.status(200).json(d);
    } catch (e) {
      return res.status(502).json({ status: 502, message: "Could not reach CPanel", error: e.message });
    }
  },
  masterModelLookup: async (req, res) => {
    try {
      const d = await cpanelGet("/api/integrations/mes/model-lookup", {
        user_id: req.query.user_id,
        firmware_id: req.query.firmware_id,
      });
      return res.status(200).json(d);
    } catch (e) {
      return res.status(502).json({ status: 502, message: "Could not reach CPanel", error: e.message });
    }
  },

  /**
   * GET /purchase-orders  (JWT + PURCHASE_ORDER read)
   * Sales view — all POs, optional status filter.
   */
  /**
   * Accounts Portal list. Approved POs are forwarded here automatically (same
   * collection). view=cancelled surfaces POs cancelled in MES *after* they were
   * approved, so a cancellation stays visible to Accounts.
   */
  listForAccounts: async (req, res) => {
    try {
      const { search } = req.query;
      const view = req.query.view === "cancelled" ? "cancelled" : "approved";
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      const filter = view === "cancelled"
        ? { status: "Rejected", "statusHistory.toStatus": "Approved" }
        : { status: "Approved" };
      if (search) {
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ poNumber: rx }, { modelName: rx }, { vendorId: rx }, { "raisedBy.name": rx }];
      }

      const total = await PurchaseOrder.countDocuments(filter);
      const data = await PurchaseOrder.find(filter)
        .sort({ approvedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      // Attach available finished-goods stock per model (one carton fetch for the page).
      if (view === "approved" && data.length) {
        try {
          const readyCartons = await dispatchService.getReadyCartons();
          const stockByModel = new Map();
          for (const c of readyCartons) {
            const key = String(c.modelName || "").trim().toLowerCase();
            if (!key) continue;
            stockByModel.set(key, (stockByModel.get(key) || 0) + Number(c.deviceCount || 0));
          }
          for (const po of data) {
            po.availableStock = stockByModel.get(String(po.modelName || "").trim().toLowerCase()) || 0;
          }
        } catch (stockErr) {
          console.warn("listForAccounts stock enrichment skipped:", stockErr.message);
        }
      }

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("purchaseOrder listForAccounts error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * Record the Order Confirmation (OC) number created by Accounts against a PO.
   * The OC itself is created via the OC Management endpoint; this only links it
   * back so the Accounts view can show which OC each approved PO produced.
   */
  setOcNumber: async (req, res) => {
    try {
      const oc = String(req.body?.ocNumber || "").trim();
      if (!oc) {
        return res.status(400).json({ status: 400, message: "OC number is required." });
      }
      const po = await PurchaseOrder.findById(req.params.id);
      if (!po) {
        return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      }
      if (po.status !== "Approved") {
        return res.status(409).json({ status: 409, message: `An OC number can only be linked to an Approved PO (this one is ${po.status}).` });
      }
      po.ocNumber = oc;
      po.fulfilment = po.fulfilment || {};
      po.fulfilment.decidedAt = new Date();
      po.statusHistory.push({
        fromStatus: po.status,
        toStatus: po.status,
        actorType: "mes",
        changedBy: req.user?._id || null,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: `OC number ${oc} linked by Accounts`,
        changedAt: new Date(),
      });

      // OC raised → auto-create the Product from the PO and move to Engineering.
      // Product creation must not break OC linking, so fall back to oc_raised on error.
      let productNote = "";
      try {
        const product = await createProductFromPO(po, req.user || {});
        productNote = ` Product "${po.fulfilment.productName}" created (draft) → Engineering pending.`;
        po.statusHistory.push({
          fromStatus: po.status,
          toStatus: po.status,
          actorType: "mes",
          changedByName: req.user?.name || req.user?.email || "system",
          remarks: `Auto-created product "${product.name}" from PO → Engineering pending approval`,
          changedAt: new Date(),
        });
      } catch (prodErr) {
        console.error("createProductFromPO failed:", prodErr.message);
        po.fulfilment.state = "oc_raised";
        productNote = " (product auto-creation skipped: " + prodErr.message + ")";
      }

      const saved = await po.save();
      return res.status(200).json({ status: 200, message: "OC number linked to Purchase Order." + productNote, data: saved });
    } catch (error) {
      console.error("purchaseOrder setOcNumber error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /** Stock check for an approved PO: available units of its model vs required. */
  stockForAccounts: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id).lean();
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      const { available } = await modelStock(po.modelName);
      const required = Number(po.requiredQuantity || 0);
      return res.status(200).json({
        status: 200,
        data: { modelName: po.modelName, required, available, sufficient: available >= required && required > 0 },
      });
    } catch (error) {
      console.error("purchaseOrder stockForAccounts error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * Sufficient-stock path: create a dispatch invoice (+ e-way bill) against the
   * PO's model by reserving READY cartons, then link it back to the PO and mark
   * it invoiced (it now appears in the Store/dispatch queue).
   */
  createInvoiceForAccounts: async (req, res) => {
    try {
      const b = req.body || {};
      const invoiceNumber = String(b.invoiceNumber || "").trim();
      if (!invoiceNumber) return res.status(400).json({ status: 400, message: "Invoice number is required." });
      if (!b.dispatchDate) return res.status(400).json({ status: 400, message: "Dispatch date is required." });

      const po = await PurchaseOrder.findById(req.params.id);
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      if (po.status !== "Approved") {
        return res.status(409).json({ status: 409, message: `An invoice can only be raised for an Approved PO (this one is ${po.status}).` });
      }
      if (po.fulfilment?.state === "invoiced" || po.fulfilment?.state === "dispatched") {
        return res.status(409).json({ status: 409, message: "This PO has already been invoiced." });
      }

      const required = Number(po.requiredQuantity || 0);
      const { available, cartons } = await modelStock(po.modelName);
      if (available < required || required <= 0) {
        return res.status(409).json({ status: 409, message: `Insufficient stock (${available} available, ${required} required). Raise an OC number instead.` });
      }

      const { serials, covered } = selectCartonsForQuantity(cartons, required);
      if (!serials.length || covered < required) {
        return res.status(409).json({ status: 409, message: "Could not reserve enough cartons for the required quantity." });
      }

      const userId = req.user?.id || req.user?._id || null;
      const invoice = await dispatchService.createDraft({
        invoiceNumber,
        customerName: String(b.customerName || po.raisedBy?.name || "").trim(),
        contactPerson: String(b.contactPerson || "").trim(),
        customerEmail: String(b.customerEmail || po.raisedBy?.email || "").trim(),
        customerPhone: String(b.customerPhone || po.raisedBy?.mobile || "").trim(),
        ewayBillNo: String(b.ewayBillNo || "").trim(),
        dispatchDate: b.dispatchDate,
        invoiceDate: b.invoiceDate || b.dispatchDate,
        remarks: `Raised from ${po.poNumber} by Accounts`,
        cartonSerials: serials,
      }, userId);

      po.fulfilment = po.fulfilment || {};
      po.fulfilment.state = "invoiced";
      po.fulfilment.availableAtCheck = available;
      po.fulfilment.invoiceId = invoice?._id || null;
      po.fulfilment.invoiceNumber = invoiceNumber;
      po.fulfilment.ewayBillNo = String(b.ewayBillNo || "").trim();
      po.fulfilment.decidedAt = new Date();
      po.statusHistory.push({
        fromStatus: po.status,
        toStatus: po.status,
        actorType: "mes",
        changedBy: userId,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: `Invoice ${invoiceNumber} raised & moved to store (reserved ${serials.length} carton(s))`,
        changedAt: new Date(),
      });
      await po.save();

      return res.status(200).json({ status: 200, message: "Invoice created and order moved to the store for dispatch.", data: { invoice, po } });
    } catch (error) {
      const code = error.status || 500;
      console.error("purchaseOrder createInvoiceForAccounts error:", error);
      return res.status(code).json({ status: code, message: error.message || "Internal server error" });
    }
  },

  /** Engineering queue: POs whose auto-created product awaits approval. */
  engineeringList: async (req, res) => {
    try {
      const { search } = req.query;
      const view = req.query.view === "approved" ? "engineering_approved" : "engineering_pending";
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      const filter = { "fulfilment.state": view };
      if (search) {
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ poNumber: rx }, { modelName: rx }, { "fulfilment.productName": rx }, { "raisedBy.name": rx }];
      }

      const total = await PurchaseOrder.countDocuments(filter);
      const data = await PurchaseOrder.find(filter)
        .sort({ "fulfilment.decidedAt": -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("engineeringList error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /** Full detail for the engineering queue: the PO + its auto-created product. */
  engineeringDetail: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id).lean();
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      let product = null;
      if (po.fulfilment?.productId) {
        product = await Product.findById(po.fulfilment.productId).lean();
      }
      // Show the effective plan: product's own, else the category plan resolved
      // against the PO (so a plan added after product creation is previewed).
      const productHadPlan = !!(product && Array.isArray(product.stages) && product.stages.length);
      const plan = await resolvedPlanForPo(po, product);
      if (product && !productHadPlan) product = { ...product, stages: plan };
      return res.status(200).json({ status: 200, data: { po, product, planFromCategory: !productHadPlan && plan.length > 0 } });
    } catch (error) {
      console.error("engineeringDetail error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /** Engineering approves the auto-created product → activate it + create inventory. */
  engineeringApprove: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id);
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      if (po.fulfilment?.state !== "engineering_pending") {
        return res.status(409).json({ status: 409, message: `PO is not pending engineering approval (state: ${po.fulfilment?.state}).` });
      }
      const productId = po.fulfilment?.productId;
      if (!productId) return res.status(409).json({ status: 409, message: "No product linked to this PO." });

      const product = await Product.findById(productId);
      if (!product) return res.status(404).json({ status: 404, message: "Linked product not found." });

      // If the product has no testing plan (e.g. the category plan was added after
      // the product was auto-created), apply the resolved category plan now.
      if (!Array.isArray(product.stages) || !product.stages.length) {
        const plan = await resolvedPlanForPo(po, product);
        if (plan.length) product.stages = plan;
      }
      if (String(product.status || "").toLowerCase() !== "active") {
        product.status = "active";
      }
      await product.save();

      // Assign the product to the Product Category mapped to the PO's device category.
      let categoryName = "";
      const cat = await resolveProductCategory(po);
      if (cat) {
        categoryName = cat.name;
        await ProductCategory.updateOne({ _id: cat._id }, { $addToSet: { products: product._id } });
      }

      // Reuse the existing product→inventory logic.
      await createInventoryForProduct(product, req.user || {});

      po.fulfilment.state = "engineering_approved";
      po.statusHistory.push({
        fromStatus: po.status,
        toStatus: po.status,
        actorType: "mes",
        changedBy: req.user?._id || null,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: `Engineering approved product "${product.name}"${categoryName ? ` under category "${categoryName}"` : ""} — activated with inventory`,
        changedAt: new Date(),
      });
      await po.save();

      return res.status(200).json({ status: 200, message: "Product approved and activated with inventory.", data: { po, product } });
    } catch (error) {
      console.error("engineeringApprove error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  list: async (req, res) => {
    try {
      const { search, status } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      const filter = {};
      if (status) filter.status = status;
      if (search) {
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ poNumber: rx }, { modelName: rx }, { vendorId: rx }, { "raisedBy.name": rx }];
      }

      const total = await PurchaseOrder.countDocuments(filter);
      const data = await PurchaseOrder.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("purchaseOrder list error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /purchase-orders/:id  (JWT + PURCHASE_ORDER read)
   * Single PO (full detail incl. configuration snapshot + status history).
   */
  getOne: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id).lean();
      if (!po) {
        return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      }
      return res.status(200).json({ status: 200, data: po });
    } catch (error) {
      console.error("purchaseOrder getOne error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /purchase-orders/:id  (JWT + PURCHASE_ORDER update)
   * Sales edit of a Pending PO — updates any provided fields and records an
   * "Edited" entry in the status history.
   */
  update: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id);
      if (!po) {
        return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      }
      // Editable while Pending or after approval (edits sync straight to Accounts,
      // which reads the same collection). A cancelled PO is closed.
      if (!["Pending", "Approved"].includes(po.status)) {
        return res.status(409).json({ status: 409, message: `A ${po.status} PO cannot be edited.` });
      }

      const b = req.body || {};
      if (b.deviceCategory) {
        po.deviceCategory = { id: b.deviceCategory.id ?? po.deviceCategory?.id ?? null, name: b.deviceCategory.name || "" };
      }
      if (b.esim) {
        po.esim = { make: b.esim.make || "", profile1: b.esim.profile1 || "", profile2: b.esim.profile2 || "" };
      }
      if (b.esimRechargePeriod && VALID_RECHARGE.includes(b.esimRechargePeriod)) {
        po.esimRechargePeriod = b.esimRechargePeriod;
      }
      if (b.firmware) {
        po.firmware = { id: b.firmware.id ?? null, name: b.firmware.name || "" };
      }
      if (typeof b.modelName === "string") po.modelName = b.modelName;
      if (typeof b.vendorId === "string") po.vendorId = b.vendorId;
      if (b.expectedDeliveryDate) po.expectedDeliveryDate = new Date(b.expectedDeliveryDate);
      if (b.requiredQuantity != null) {
        const q = parseInt(b.requiredQuantity, 10);
        if (Number.isInteger(q) && q >= 1) po.requiredQuantity = q;
      }
      if (b.configuration && typeof b.configuration === "object") po.configuration = b.configuration;

      po.statusHistory.push({
        fromStatus: po.status,
        toStatus: po.status,
        actorType: "mes",
        changedBy: req.user?._id || null,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: b.remarks || "PO edited by Sales",
        changedAt: new Date(),
      });

      const saved = await po.save();
      return res.status(200).json({ status: 200, message: "Purchase Order updated.", data: saved });
    } catch (error) {
      console.error("purchaseOrder update error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /purchase-orders/:id/approve  (JWT + PURCHASE_ORDER update)
   */
  approve: async (req, res) => {
    return transition(req, res, "Approved");
  },

  /**
   * PUT /purchase-orders/:id/reject  (JWT + PURCHASE_ORDER update)
   * Requires remarks.
   */
  reject: async (req, res) => {
    if (!String(req.body?.remarks || "").trim()) {
      return res.status(400).json({ status: 400, message: "Remarks are required when rejecting a PO." });
    }
    // Cancellation stays available even after approval (PO may already be with Accounts).
    return transition(req, res, "Rejected", ["Pending", "Approved"]);
  },
};

/**
 * Shared approve/reject transition with history append.
 * @param {string[]} allowedFrom - statuses the PO may transition from.
 */
async function transition(req, res, toStatus, allowedFrom = ["Pending"]) {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) {
      return res.status(404).json({ status: 404, message: "Purchase Order not found." });
    }
    if (!allowedFrom.includes(po.status)) {
      return res.status(409).json({ status: 409, message: `PO is ${po.status}; this action is not allowed.` });
    }

    const remarks = String(req.body?.remarks || "").trim();
    const fromStatus = po.status;

    po.status = toStatus;
    po.salesRemarks = remarks;
    // On rejection, capture whether the customer may edit & resubmit.
    if (toStatus === "Rejected") {
      po.resubmissionAllowed = !!req.body?.resubmissionAllowed;
    }
    // Only stamp approval metadata on an actual approval — preserve the original
    // approver/timestamp when an already-approved PO is later cancelled.
    if (toStatus === "Approved") {
      po.approvedBy = { userId: req.user?._id || null, name: req.user?.name || req.user?.email || "" };
      po.approvedAt = new Date();
    }
    po.statusHistory.push({
      fromStatus,
      toStatus,
      actorType: "mes",
      changedBy: req.user?._id || null,
      changedByName: req.user?.name || req.user?.email || "",
      remarks,
      changedAt: new Date(),
    });

    const saved = await po.save();
    return res.status(200).json({
      status: 200,
      message: `Purchase Order ${toStatus.toLowerCase()} successfully.`,
      data: saved,
    });
  } catch (error) {
    console.error("purchaseOrder transition error:", error);
    return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
  }
}
