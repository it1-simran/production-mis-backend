const PurchaseOrder = require("../models/PurchaseOrder");
const SkuRequest = require("../models/SkuRequest");

/**
 * Customer identity (name/email/mobile) is Sales & Accounts information — PPC
 * only needs to know a PO exists and its dispatch-relevant details, not who
 * raised it. Redact in place for PPC's views; role and cpanelUserId are kept.
 */
function redactCustomer(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  list.forEach((row) => {
    if (row && row.raisedBy) {
      row.raisedBy.name = "";
      row.raisedBy.email = "";
      row.raisedBy.mobile = "";
    }
  });
  return rows;
}
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
const ProcessModel = require("../models/process");

/**
 * The testing plan to preview/apply for a PO, with ${slug} tokens resolved
 * against this PO's own data using whatever SlugMapping docs are active RIGHT
 * NOW (not frozen at product-creation time - see poProductService.js). Prefers
 * the product's own stages (its category's plan at creation), falling back to
 * re-resolving the category's current plan if the product has none yet.
 */
async function resolvedPlanForPo(po, product) {
  let rawStages = product && Array.isArray(product.stages) && product.stages.length ? product.stages : null;
  if (!rawStages) {
    const cat = await resolveProductCategory(po);
    if (cat && Array.isArray(cat.testingPlan) && cat.testingPlan.length) {
      rawStages = cat.testingPlan;
    }
  }
  if (!rawStages || !rawStages.length) return [];
  const slugMaps = await SlugMapping.find({ isActive: true }).lean();
  const poObj = typeof po.toObject === "function" ? po.toObject() : po;
  return resolveTestingPlan(rawStages, poObj, slugMaps);
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

/**
 * Atomic, gap-free Process ID: PRC-YYYY-000123. processID is otherwise a
 * free-typed field with no consistent format across existing records (see
 * process.js) - this generator is only used for POs auto-creating their
 * Process on Engineering approval, so it's a clean new namespace that can't
 * collide with any manually-typed processID.
 */
async function nextProcessId() {
  const year = new Date().getFullYear();
  const seq = await Sequence.findOneAndUpdate(
    { name: "auto_process_id" },
    { $inc: { value: 1 } },
    { new: true, upsert: true }
  );
  return `PRC-${year}-${String(seq.value).padStart(6, "0")}`;
}

/**
 * Auto-create the Process for a just-activated product, copying its stages/
 * commonStages/autoNgEnabled verbatim (same data a human would copy manually
 * via the Add Process form). Returns the saved Process, or null if one
 * couldn't be created (caller decides how to handle that without blocking the
 * approval itself).
 */
async function createProcessForApprovedPo(po, product, user = {}) {
  const processID = await nextProcessId();
  const name = `${product.name} - ${po.poNumber}`.trim();
  const process = await new ProcessModel({
    name,
    selectedProduct: product._id,
    orderConfirmationNo: po.ocNumber || po.poNumber || "",
    processID,
    quantity: String(po.requiredQuantity ?? ""),
    stages: product.stages || [],
    commonStages: product.commonStages || [],
    autoNgEnabled: !!product.autoNgEnabled,
    createdBy: user.id || user._id || null,
    department: user.department || "",
  }).save();
  return process;
}

const VALID_RECHARGE = ["1_year", "2_year"];
const VALID_LOGISTICS_PARTY = ["us", "customer"];

/**
 * Validate + normalize the logistics block CPanel sends. Returns
 * { logistics, error } — error is a user-facing message when invalid.
 */
function buildLogistics(input) {
  const l = input && typeof input === "object" ? input : {};
  const managedBy = VALID_LOGISTICS_PARTY.includes(l.managedBy) ? l.managedBy : "us";
  const ewayBillBy = VALID_LOGISTICS_PARTY.includes(l.ewayBillBy) ? l.ewayBillBy : "us";

  const logistics = {
    managedBy,
    deliveryAddress: String(l.deliveryAddress || "").trim(),
    contactName: String(l.contactName || "").trim(),
    contactPhone: String(l.contactPhone || "").trim(),
    deliveryMode: String(l.deliveryMode || "").trim(),
    insuranceRequired: !!l.insuranceRequired,
    transporterName: String(l.transporterName || "").trim(),
    transporterContact: String(l.transporterContact || "").trim(),
    vehicleNumber: String(l.vehicleNumber || "").trim(),
    pickupDateTime: l.pickupDateTime ? new Date(l.pickupDateTime) : null,
    pickupPersonName: String(l.pickupPersonName || "").trim(),
    ewayBillBy,
    specialInstructions: String(l.specialInstructions || "").trim(),
  };

  if (managedBy === "us") {
    if (!logistics.deliveryAddress || !logistics.contactName || !logistics.contactPhone) {
      return { logistics: null, error: "Delivery address, contact name and contact phone are required when we manage logistics." };
    }
  } else {
    if (!logistics.transporterName || !logistics.transporterContact || !logistics.vehicleNumber || !logistics.pickupDateTime) {
      return { logistics: null, error: "Transporter name, transporter contact, vehicle number and pickup date/time are required when the customer manages logistics." };
    }
  }

  return { logistics, error: null };
}

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

/**
 * POs raised before skuCode/serialNumberFormat/cartonType/stickerFormat/
 * fgBomNumber/tranzactId were captured at PO-creation time have none of them
 * stored. Best-effort fill for DISPLAY ONLY (mutates the given lean objects,
 * never persisted) by matching each one back to the approved SKU it was
 * almost certainly raised against — one batched query for the whole list.
 */
async function fillMissingSkuSnapshot(pos) {
  const missing = (pos || []).filter((po) => !po.skuCode && !po.fgBomNumber && !po.serialNumberFormat);
  if (!missing.length) return;

  const orClauses = missing
    .filter((po) => po.raisedBy?.cpanelUserId && po.deviceCategory?.id && po.firmware?.id)
    .map((po) => ({
      "raisedBy.cpanelUserId": po.raisedBy.cpanelUserId,
      "deviceCategory.id": po.deviceCategory.id,
      "firmware.id": po.firmware.id,
      modelName: po.modelName || "",
      vendorId: po.vendorId || "",
      status: "Completed",
    }));
  if (!orClauses.length) return;

  const skus = await SkuRequest.find({ $or: orClauses })
    .select("raisedBy.cpanelUserId deviceCategory.id firmware.id modelName vendorId skuCode serialNumberFormat cartonType stickerFormat fgBomNumber tranzactId createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const keyOf = (o) => [o.raisedBy?.cpanelUserId, o.deviceCategory?.id, o.firmware?.id, o.modelName || "", o.vendorId || ""].join("|");
  const byKey = {};
  skus.forEach((s) => { const k = keyOf(s); if (!byKey[k]) byKey[k] = s; }); // first = most recent (sorted desc)

  missing.forEach((po) => {
    const sku = byKey[keyOf(po)];
    if (!sku) return;
    po.skuCode = sku.skuCode || "";
    po.serialNumberFormat = sku.serialNumberFormat || "";
    po.cartonType = sku.cartonType || "";
    po.stickerFormat = sku.stickerFormat || { id: null, name: "" };
    po.fgBomNumber = sku.fgBomNumber || "";
    po.tranzactId = sku.tranzactId || "";
  });
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

      // Defense-in-depth: CPanel already gates PO creation on KYC approval,
      // but MES re-checks so the integration endpoint can't be used to bypass it.
      if (b.kycApproved !== true) {
        return res.status(403).json({ status: 403, message: "Customer KYC is not approved. Cannot raise a Purchase Order." });
      }

      // A PO inherits its eSIM fields straight from the SKU it's raised
      // against — a Device Category with no eSIM at all has none of them set
      // (make/profile1/profile2/rechargePeriod all blank), so a recharge
      // period is only required when there's actually eSIM data to go with it.
      const hasEsimData = Boolean(
        String(b.esim?.make || "").trim() ||
        String(b.esim?.profile1 || "").trim() ||
        String(b.esim?.profile2 || "").trim() ||
        esimRechargePeriod
      );
      // modelName is optional — a PO can be raised without a configured model.
      if (hasEsimData && !VALID_RECHARGE.includes(esimRechargePeriod)) {
        return res.status(400).json({ status: 400, message: "esimRechargePeriod must be 1_year or 2_year." });
      }
      if (!Number.isInteger(requiredQuantity) || requiredQuantity < 1) {
        return res.status(400).json({ status: 400, message: "requiredQuantity must be a positive integer." });
      }

      const { logistics, error: logisticsError } = buildLogistics(b.logistics);
      if (logisticsError) {
        return res.status(400).json({ status: 400, message: logisticsError });
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
        skuCode: b.skuCode || "",
        serialNumberFormat: b.serialNumberFormat || "",
        cartonType: b.cartonType || "",
        stickerFormat: { id: b.stickerFormat?.id ?? null, name: b.stickerFormat?.name || "" },
        fgBomNumber: b.fgBomNumber || "",
        tranzactId: b.tranzactId || "",
        configuration: b.configuration && typeof b.configuration === "object" ? b.configuration : {},
        expectedDeliveryDate: b.expectedDeliveryDate ? new Date(b.expectedDeliveryDate) : null,
        requiredQuantity,
        logistics,
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
      await fillMissingSkuSnapshot(data);

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
      await fillMissingSkuSnapshot([po]);
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
   * Dynamic "PO Field (source)" suggestions for Slug Management, derived from
   * the actual configuration.schema snapshots already stored on Purchase Orders
   * - each device category defines its own custom fields in GPSCPANEL (frozen
   * onto the PO at creation time as configuration.schema/configuration.values),
   * so there's no single fixed schema MES owns to hardcode; this aggregates the
   * distinct field keys that have genuinely appeared across real POs instead.
   */
  configurationFieldHints: async (req, res) => {
    try {
      const docs = await PurchaseOrder.find({ "configuration.schema.0": { $exists: true } })
        .select("configuration.schema")
        .lean();

      const normalizeKey = (key) =>
        String(key || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "_");

      const byValue = new Map();
      docs.forEach((po) => {
        (po.configuration?.schema || []).forEach((field) => {
          const norm = normalizeKey(field?.key);
          if (!norm) return;
          const value = `configuration.values.${norm}.value`;
          if (!byValue.has(value)) {
            byValue.set(value, { label: `Config: ${field.key}`, value });
          }
        });
      });

      const hints = Array.from(byValue.values()).sort((a, b) => a.label.localeCompare(b.label));
      return res.status(200).json({ status: 200, hints });
    } catch (error) {
      console.error("configurationFieldHints error:", error);
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
      const view = req.query.view === "ocCreated" ? "ocCreated" : "pendingOc";
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      // Both tabs are Approved POs — the split is purely on whether an OC
      // number has been linked yet, not on PO status. Cancelled (Rejected)
      // POs are no longer surfaced here at all.
      // A handful of legacy POs predate the ocNumber field entirely (missing,
      // not just empty) — treat "missing" the same as "" on both sides.
      const filter = { status: "Approved" };
      const andClauses = [
        view === "ocCreated"
          ? { ocNumber: { $exists: true, $ne: "" } }
          : { $or: [{ ocNumber: { $exists: false } }, { ocNumber: "" }] },
      ];
      if (search) {
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        andClauses.push({ $or: [{ poNumber: rx }, { modelName: rx }, { vendorId: rx }, { "raisedBy.name": rx }] });
      }
      filter.$and = andClauses;

      const total = await PurchaseOrder.countDocuments(filter);
      const data = await PurchaseOrder.find(filter)
        .sort({ approvedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      // Attach available finished-goods stock per model (one carton fetch for the page).
      if (view === "pendingOc" && data.length) {
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

      // A PO already carrying an OC number (i.e. this is Accounts correcting a
      // typo, not the initial link) must NOT re-run product auto-creation —
      // doing so would spawn a second Product/Process and orphan the first,
      // regardless of how far fulfilment has already progressed.
      const isRename = !!po.ocNumber;

      po.ocNumber = oc;
      po.fulfilment = po.fulfilment || {};
      if (!isRename) {
        po.fulfilment.decidedAt = new Date();
      }
      po.statusHistory.push({
        fromStatus: po.status,
        toStatus: po.status,
        actorType: "mes",
        changedBy: req.user?._id || null,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: isRename ? `OC number corrected to ${oc}` : `OC number ${oc} linked by Accounts`,
        changedAt: new Date(),
      });

      // OC raised → auto-create the Product from the PO and move to Engineering.
      // Product creation must not break OC linking, so fall back to oc_raised on error.
      let productNote = "";
      if (!isRename) {
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
      }

      const saved = await po.save();
      return res.status(200).json({ status: 200, message: isRename ? "OC number updated." : "OC number linked to Purchase Order." + productNote, data: saved });
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
      const view =
        req.query.view === "approved"
          ? "engineering_approved"
          : req.query.view === "hold"
          ? "engineering_hold"
          : "engineering_pending";
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      const filter = { "fulfilment.state": view };
      if (search) {
        // No customer-name search — Engineering shouldn't be able to search
        // by (or infer) customer identity, which is Sales & Accounts information.
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ poNumber: rx }, { modelName: rx }, { "fulfilment.productName": rx }];
      }

      const total = await PurchaseOrder.countDocuments(filter);
      const data = await PurchaseOrder.find(filter)
        .sort({ "fulfilment.decidedAt": -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();
      await fillMissingSkuSnapshot(data);
      redactCustomer(data);

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("engineeringList error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * Production Manager queue: POs whose Process was auto-created on Engineering
   * approval and is waiting to be planned/scheduled. fulfilment.processId/
   * processName/productName are already denormalized onto the PO (see
   * engineeringApprove), so this list needs no extra joins.
   */
  productionQueueList: async (req, res) => {
    try {
      const { search } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      const filter = { "fulfilment.state": "production_pending" };
      if (search) {
        // No customer-name search — Production Manager shouldn't be able to
        // search by (or infer) customer identity, which is Sales & Accounts
        // information.
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [
          { poNumber: rx },
          { modelName: rx },
          { "fulfilment.productName": rx },
          { "fulfilment.processName": rx },
        ];
      }

      const total = await PurchaseOrder.countDocuments(filter);
      const data = await PurchaseOrder.find(filter)
        .sort({ "fulfilment.decidedAt": -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({ path: "fulfilment.processId", select: "processID name quantity status" })
        .lean();
      redactCustomer(data);

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("productionQueueList error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * Production Manager sets the real PID (Process ID) on the auto-created
   * Process before it can be planned/scheduled. The Process is auto-created
   * with a system-generated placeholder (PRC-YYYY-NNNNNN, see nextProcessId)
   * so it satisfies the schema's required processID immediately - this lets
   * Production Manager overwrite it with their own real identifier.
   */
  productionQueueSetPid: async (req, res) => {
    try {
      const processID = String(req.body?.processID || "").trim();
      if (!processID) {
        return res.status(400).json({ status: 400, message: "PID is required." });
      }
      const po = await PurchaseOrder.findById(req.params.id).lean();
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      const processId = po.fulfilment?.processId;
      if (!processId) {
        return res.status(409).json({ status: 409, message: "No Process linked to this PO." });
      }

      const duplicate = await ProcessModel.findOne({ processID, _id: { $ne: processId } }).select("_id").lean();
      if (duplicate) {
        return res.status(409).json({ status: 409, message: `PID "${processID}" is already used by another process.` });
      }

      const updatedProcess = await ProcessModel.findByIdAndUpdate(
        processId,
        { processID },
        { new: true, runValidators: true }
      ).lean();
      if (!updatedProcess) {
        return res.status(404).json({ status: 404, message: "Linked process not found." });
      }

      return res.status(200).json({ status: 200, message: "PID updated.", data: { process: updatedProcess } });
    } catch (error) {
      console.error("productionQueueSetPid error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /** Full detail for the engineering queue: the PO + its auto-created product. */
  engineeringDetail: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id).lean();
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      await fillMissingSkuSnapshot([po]);
      redactCustomer(po);
      let product = null;
      if (po.fulfilment?.productId) {
        product = await Product.findById(po.fulfilment.productId).lean();
      }
      // Show the effective plan, always LIVE-resolved against current
      // SlugMapping docs (product.stages stores the raw ${slug} template, not a
      // frozen snapshot - see poProductService.js) so this preview reflects any
      // slug correction made after the product was created, not just at
      // creation time. Falls back to the category's plan if the product has
      // none yet (e.g. category plan was added after product creation).
      const productHadPlan = !!(product && Array.isArray(product.stages) && product.stages.length);
      const plan = await resolvedPlanForPo(po, product);
      if (product) product = { ...product, stages: plan };
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
      if (po.fulfilment?.state !== "engineering_pending" && po.fulfilment?.state !== "engineering_hold") {
        return res.status(409).json({ status: 409, message: `PO is not pending engineering approval (state: ${po.fulfilment?.state}).` });
      }
      const productId = po.fulfilment?.productId;
      if (!productId) return res.status(409).json({ status: 409, message: "No product linked to this PO." });

      const product = await Product.findById(productId);
      if (!product) return res.status(404).json({ status: 404, message: "Linked product not found." });

      // If the product has no testing plan (e.g. the category plan was added after
      // the product was auto-created), backfill it with the category's RAW plan -
      // NOT the resolved one. This is a save path: persisting resolvedPlanForPo's
      // output here would bake ${slug} tokens into literal values and freeze this
      // product exactly like the old behavior, defeating live resolution for it
      // going forward. Raw ${slug} tokens are harmless if a category has none.
      if (!Array.isArray(product.stages) || !product.stages.length) {
        const backfillCat = await resolveProductCategory(po);
        if (backfillCat && Array.isArray(backfillCat.testingPlan) && backfillCat.testingPlan.length) {
          product.stages = backfillCat.testingPlan;
        }
      }
      // Refuse to activate a product with zero testing stages - that would put a
      // device into production with nothing to validate it against. Engineering
      // must configure the category's testing plan first, or explicitly override.
      if ((!Array.isArray(product.stages) || !product.stages.length) && !req.body?.force) {
        return res.status(409).json({
          status: 409,
          message:
            "This product has no testing plan (0 stages) — configure a testing plan for its category before approving, or pass force to override.",
          code: "NO_TESTING_PLAN",
        });
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

      // NEW: Auto-create the Process from the now-active product and route the
      // PO on to Production Manager, instead of stopping at engineering_approved.
      // Process creation failure must NOT block the approval itself (the
      // product is already activated with inventory by this point) - it just
      // falls back to the old resting state so nothing is lost, and the
      // remark makes the gap visible for a manual Process creation instead.
      let createdProcess = null;
      let processCreationError = "";
      try {
        createdProcess = await createProcessForApprovedPo(po, product, req.user || {});
      } catch (procErr) {
        console.error("createProcessForApprovedPo error:", procErr);
        processCreationError = procErr.message || String(procErr);
      }

      if (createdProcess) {
        po.fulfilment.processId = createdProcess._id;
        po.fulfilment.processName = createdProcess.name;
      }
      po.fulfilment.state = createdProcess ? "production_pending" : "engineering_approved";
      po.statusHistory.push({
        fromStatus: po.status,
        toStatus: po.status,
        actorType: "mes",
        changedBy: req.user?._id || null,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: `Engineering approved product "${product.name}"${categoryName ? ` under category "${categoryName}"` : ""} — activated with inventory${
          !product.stages?.length ? " (approved with 0 testing stages, forced)" : ""
        }${
          createdProcess
            ? `. Process "${createdProcess.processID}" auto-created — routed to Production Manager for planning/scheduling.`
            : `. Process auto-creation failed (${processCreationError || "unknown error"}) — create it manually.`
        }`,
        changedAt: new Date(),
      });
      await po.save();
      redactCustomer(po);

      return res.status(200).json({
        status: 200,
        message: createdProcess
          ? "Product approved, activated with inventory, and Process created — routed to Production Manager."
          : "Product approved and activated with inventory. Process auto-creation failed - create it manually.",
        data: { po, product, process: createdProcess },
      });
    } catch (error) {
      console.error("engineeringApprove error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /** Engineering sends the PO back for rework instead of approving it. */
  engineeringHold: async (req, res) => {
    try {
      const remarks = String(req.body?.remarks || "").trim();
      if (!remarks) {
        return res.status(400).json({ status: 400, message: "Remarks are required to put a PO on hold." });
      }
      const po = await PurchaseOrder.findById(req.params.id);
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      if (po.fulfilment?.state !== "engineering_pending") {
        return res.status(409).json({ status: 409, message: `PO is not pending engineering approval (state: ${po.fulfilment?.state}).` });
      }

      po.fulfilment.state = "engineering_hold";
      po.statusHistory.push({
        fromStatus: po.status,
        toStatus: po.status,
        actorType: "mes",
        changedBy: req.user?._id || null,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: `Engineering put on hold: ${remarks}`,
        changedAt: new Date(),
      });
      await po.save();
      redactCustomer(po);

      return res.status(200).json({ status: 200, message: "PO put on hold.", data: { po } });
    } catch (error) {
      console.error("engineeringHold error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /** Move a held PO back to the pending queue for re-review (e.g. after the testing plan is fixed). */
  engineeringResumeFromHold: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id);
      if (!po) return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      if (po.fulfilment?.state !== "engineering_hold") {
        return res.status(409).json({ status: 409, message: `PO is not on hold (state: ${po.fulfilment?.state}).` });
      }

      po.fulfilment.state = "engineering_pending";
      po.statusHistory.push({
        fromStatus: po.status,
        toStatus: po.status,
        actorType: "mes",
        changedBy: req.user?._id || null,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: `Moved back to pending from hold${req.body?.remarks ? `: ${String(req.body.remarks).trim()}` : ""}`,
        changedAt: new Date(),
      });
      await po.save();
      redactCustomer(po);

      return res.status(200).json({ status: 200, message: "PO moved back to pending.", data: { po } });
    } catch (error) {
      console.error("engineeringResumeFromHold error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  list: async (req, res) => {
    try {
      const { search, status } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      // Sales's "Pending" tab covers both gates it acts on: the initial
      // approval (Pending) and the final dispatch-date confirmation
      // (PendingSalesConfirm) — PendingPpc (with PPC) also surfaces here,
      // read-only, so Sales can see where each PO currently sits.
      const filter = {};
      if (status === "Pending") {
        filter.status = { $in: ["Pending", "PendingPpc", "PendingSalesConfirm"] };
      } else if (status) {
        filter.status = status;
      }
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

      await fillMissingSkuSnapshot(data);

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

      await fillMissingSkuSnapshot([po]);

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
   * Sales's first-gate approval — sends the PO to PPC for a dispatch date,
   * not straight to Approved.
   */
  approve: async (req, res) => {
    return transition(req, res, "PendingPpc");
  },

  /**
   * PUT /purchase-orders/:id/reject  (JWT + PURCHASE_ORDER update)
   * Requires remarks.
   */
  reject: async (req, res) => {
    if (!String(req.body?.remarks || "").trim()) {
      return res.status(400).json({ status: 400, message: "Remarks are required when rejecting a PO." });
    }
    // Cancellation stays available even after approval (PO may already be with
    // Accounts) AND while it's mid-flight between Sales and PPC — otherwise a
    // PO with PPC or awaiting Sales' final confirm has no way out at all.
    return transition(req, res, "Rejected", ["Pending", "PendingPpc", "PendingSalesConfirm", "Approved"]);
  },

  /**
   * PUT /purchase-orders/:id/confirm-dispatch  (JWT + PURCHASE_ORDER update)
   * Sales's second gate: confirms the dispatch date PPC set and finalizes
   * the PO — same terminal "Approved" state Accounts already watches.
   */
  confirmDispatch: async (req, res) => {
    return transition(req, res, "Approved", ["PendingSalesConfirm"]);
  },

  // ============================== PPC stage ===============================

  /**
   * GET /ppc/purchase-orders  (JWT + PPC_PURCHASE_ORDERS read)
   * `view=pending` (default) -> awaiting a dispatch date; `view=done` -> PPC
   * has already set one (regardless of what Sales/Accounts did since).
   */
  ppcList: async (req, res) => {
    try {
      const { search, view } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      const filter = view === "done" ? { ppcReviewedAt: { $ne: null } } : { status: "PendingPpc" };
      if (search) {
        // No customer-name search here — PPC shouldn't be able to search by
        // (or infer) customer identity, which is Sales & Accounts information.
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ poNumber: rx }, { modelName: rx }, { vendorId: rx }];
      }

      const total = await PurchaseOrder.countDocuments(filter);
      const data = await PurchaseOrder.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();
      redactCustomer(data);

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("purchaseOrder ppcList error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /ppc/purchase-orders/:id  (JWT + PPC_PURCHASE_ORDERS read)
   */
  ppcGetOne: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id).lean();
      if (!po) {
        return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      }
      redactCustomer(po);
      return res.status(200).json({ status: 200, data: po });
    } catch (error) {
      console.error("purchaseOrder ppcGetOne error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /ppc/purchase-orders/:id/set-dispatch-date  (JWT + PPC_PURCHASE_ORDERS update)
   * Body: { dispatchDate }. PPC never rejects — this is the only action it
   * can take, and it always hands the PO back to Sales for final confirmation.
   */
  ppcSetDispatchDate: async (req, res) => {
    try {
      const po = await PurchaseOrder.findById(req.params.id);
      if (!po) {
        return res.status(404).json({ status: 404, message: "Purchase Order not found." });
      }
      if (po.status !== "PendingPpc") {
        return res.status(409).json({ status: 409, message: `PO is ${po.status}; this action is not allowed.` });
      }

      // Parse as calendar-date components (not `new Date(string)`, which
      // treats a bare "YYYY-MM-DD" as UTC midnight) and compare against
      // "today" built the same way — both sides now live in the SAME frame
      // (the server's local calendar), so no UTC-vs-local mismatch can make
      // a genuinely upcoming date look like today/yesterday or vice versa.
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(req.body?.dispatchDate || ""));
      if (!m) {
        return res.status(400).json({ status: 400, message: "A valid dispatchDate (YYYY-MM-DD) is required." });
      }
      const dispatchDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (Number.isNaN(dispatchDate.getTime())) {
        return res.status(400).json({ status: 400, message: "A valid dispatchDate is required." });
      }
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (dispatchDate.getTime() <= startOfToday.getTime()) {
        return res.status(400).json({ status: 400, message: "Dispatch date must be an upcoming date." });
      }

      po.ppcDispatchDate = dispatchDate;
      po.ppcReviewedBy = { userId: req.user?._id || null, name: req.user?.name || req.user?.email || "" };
      po.ppcReviewedAt = new Date();
      po.status = "PendingSalesConfirm";
      po.statusHistory.push({
        fromStatus: "PendingPpc",
        toStatus: "PendingSalesConfirm",
        actorType: "mes",
        changedBy: req.user?._id || null,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: `Estimated dispatch date set: ${m[1]}-${m[2]}-${m[3]}`,
        changedAt: new Date(),
      });

      const saved = await po.save();
      redactCustomer(saved);
      return res.status(200).json({ status: 200, message: "Dispatch date set and sent back to Sales.", data: saved });
    } catch (error) {
      console.error("purchaseOrder ppcSetDispatchDate error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },
};

// Once fulfilment has reached any of these, a Product and/or Process may
// already exist (or inventory/invoicing may be underway) — cancelling the PO
// at this point would orphan that work rather than undo it, so it's blocked.
const FULFILMENT_LOCKED_STATES = [
  "engineering_pending",
  "engineering_hold",
  "engineering_approved",
  "production_pending",
  "invoiced",
  "dispatched",
];

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
    if (toStatus === "Rejected" && FULFILMENT_LOCKED_STATES.includes(po.fulfilment?.state)) {
      return res.status(409).json({
        status: 409,
        message: `This PO's fulfilment has already progressed (${po.fulfilment.state}) — it can no longer be cancelled here. Manage it through Accounts/Engineering instead.`,
      });
    }

    const remarks = String(req.body?.remarks || "").trim();
    const fromStatus = po.status;

    po.status = toStatus;
    // Only overwrite salesRemarks when new remarks were actually given — an
    // approval/confirm with a blank remarks field shouldn't erase a prior
    // rejection reason that's otherwise only visible in statusHistory.
    if (remarks) {
      po.salesRemarks = remarks;
    }
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
