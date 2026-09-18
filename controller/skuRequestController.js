const SkuRequest = require("../models/SkuRequest");
const Sequence = require("../models/Sequence");
const { modelOptionsFor } = require("./rs232CommandMasterController");

/**
 * Customer identity (name/email/mobile) is Sales & Accounts information —
 * other roles (NPD, PPC, etc.) only need to know an SKU/PO exists and its
 * technical details, not who raised it. Redact in place for those views;
 * role and cpanelUserId are kept (not personally identifying by themselves,
 * and cpanelUserId is needed for GPSCPANEL model-lookup calls).
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

const VALID_RECHARGE = ["1_year", "2_year"];

/** Atomic, gap-free SKU code: SKU-YYYY-000123 */
async function nextSkuCode() {
  const year = new Date().getFullYear();
  const seq = await Sequence.findOneAndUpdate(
    { name: "sku_request" },
    { $inc: { value: 1 } },
    { new: true, upsert: true }
  );
  return `SKU-${year}-${String(seq.value).padStart(6, "0")}`;
}

/** POST to GPSCPANEL's MES-integration API using the shared key. */
async function cpanelPost(path, body) {
  const base = (process.env.CPANEL_API_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("CPANEL_API_URL not configured");
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.CPANEL_API_KEY || "" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`CPanel responded ${r.status}`);
  return r.json();
}

module.exports = {
  /**
   * POST /integrations/cpanel/skus  (service-key auth)
   * Raise a SKU request from CPanel — enters at the Sales review stage.
   */
  createFromCpanel: async (req, res) => {
    try {
      const b = req.body || {};

      // Recharge period only applies to JSD-managed eSIMs; a customer-supplied
      // eSIM isn't recharged through JSD, and a Device Category with no eSIM
      // at all sends no provider whatsoever — both are optional in that case.
      const esimProviderRaw = String(b.esim?.provider || "").trim();
      const hasEsim = esimProviderRaw === "jsd" || esimProviderRaw === "customer";
      const esimProviderIn = esimProviderRaw === "customer" ? "customer" : "jsd";
      const esimRechargePeriod = String(b.esimRechargePeriod || "").trim();
      if (hasEsim && esimProviderIn === "jsd" && !VALID_RECHARGE.includes(esimRechargePeriod)) {
        return res.status(400).json({ status: 400, message: "esimRechargePeriod must be 1_year or 2_year." });
      }
      if (hasEsim && esimProviderIn === "customer" && esimRechargePeriod && !VALID_RECHARGE.includes(esimRechargePeriod)) {
        return res.status(400).json({ status: 400, message: "esimRechargePeriod must be 1_year or 2_year." });
      }

      if (!String(b.serialNumberFormat || "").trim()) {
        return res.status(400).json({ status: 400, message: "serialNumberFormat is required." });
      }
      if (!["direct_master_carton", "unit_packaging"].includes(b.cartonType)) {
        return res.status(400).json({ status: 400, message: "cartonType must be direct_master_carton or unit_packaging." });
      }
      if (!b.stickerFormat?.id) {
        return res.status(400).json({ status: 400, message: "stickerFormat is required." });
      }

      // Defense-in-depth: CPanel already gates SKU creation on KYC approval,
      // but MES re-checks so the integration endpoint can't be used to bypass it.
      if (b.kycApproved !== true) {
        return res.status(403).json({ status: 403, message: "Customer KYC is not approved. Cannot create a SKU." });
      }

      const skuCode = await nextSkuCode();
      const raisedBy = b.raisedBy || {};

      const skuRequest = new SkuRequest({
        skuCode,
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
          provider: b.esim?.provider === "customer" ? "customer" : "jsd",
          make: b.esim?.make || "",
          profile1: b.esim?.profile1 || "",
          profile2: b.esim?.profile2 || "",
        },
        esimRechargePeriod,
        firmware: { id: b.firmware?.id ?? null, name: b.firmware?.name || "" },
        modelName: String(b.modelName || "").trim(),
        vendorId: b.vendorId || "",
        serialNumberFormat: String(b.serialNumberFormat || "").trim(),
        cartonType: ["direct_master_carton", "unit_packaging"].includes(b.cartonType) ? b.cartonType : "",
        stickerFormat: { id: b.stickerFormat?.id || null, name: b.stickerFormat?.name || "" },
        configuration: b.configuration && typeof b.configuration === "object" ? b.configuration : {},
        status: "PendingSales",
        statusHistory: [
          {
            fromStatus: null,
            toStatus: "PendingSales",
            actorType: "cpanel",
            changedByName: raisedBy.name || "",
            remarks: "SKU request raised from GPS CPanel",
            changedAt: new Date(),
          },
        ],
      });

      const saved = await skuRequest.save();
      return res.status(200).json({
        status: 200,
        message: "SKU request submitted and sent for Sales review.",
        sku_code: saved.skuCode,
        id: saved._id,
        data: saved,
      });
    } catch (error) {
      console.error("createFromCpanel (sku) error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /integrations/cpanel/skus  (service-key auth)
   * List SKU requests for the CPanel "My SKUs" view. Non-admin callers pass
   * raisedBy to scope to their own requests; Admin (or no raisedBy) sees all.
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
          { skuCode: rx },
          { modelName: rx },
          { "deviceCategory.name": rx },
          { "raisedBy.name": rx },
        ];
      }

      const total = await SkuRequest.countDocuments(filter);
      const data = await SkuRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("listForCpanel (sku) error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /integrations/cpanel/skus/:id  (service-key auth)
   * Single SKU request for CPanel to prefill the edit/resubmit form.
   */
  getForCpanel: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id).lean();
      if (!skuRequest) return res.status(404).json({ status: 404, message: "SKU request not found." });
      return res.status(200).json({ status: 200, data: skuRequest });
    } catch (error) {
      console.error("getForCpanel (sku) error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /integrations/cpanel/skus/:id/resubmit  (service-key auth)
   * Customer edits & resubmits a rejected SKU request — only when Rejected AND
   * the rejecting stage allowed resubmission. Always re-enters at Sales, since
   * an edit could touch device category/firmware and invalidate the model
   * allotment.
   */
  resubmitFromCpanel: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id);
      if (!skuRequest) return res.status(404).json({ status: 404, message: "SKU request not found." });
      if (skuRequest.status !== "Rejected") {
        return res.status(409).json({ status: 409, message: `Only a rejected SKU request can be resubmitted (this one is ${skuRequest.status}).` });
      }
      if (!skuRequest.resubmissionAllowed) {
        return res.status(403).json({ status: 403, message: "Resubmission of this SKU request has not been permitted." });
      }

      const b = req.body || {};
      if (b.deviceCategory) skuRequest.deviceCategory = { id: b.deviceCategory.id ?? null, name: b.deviceCategory.name || "" };
      if (b.esim) skuRequest.esim = { provider: b.esim.provider === "customer" ? "customer" : "jsd", make: b.esim.make || "", profile1: b.esim.profile1 || "", profile2: b.esim.profile2 || "" };
      if (skuRequest.esim.provider === "customer") {
        skuRequest.esimRechargePeriod = "";
      } else if (b.esimRechargePeriod && VALID_RECHARGE.includes(b.esimRechargePeriod)) {
        skuRequest.esimRechargePeriod = b.esimRechargePeriod;
      }
      if (b.firmware) skuRequest.firmware = { id: b.firmware.id ?? null, name: b.firmware.name || "" };
      if (typeof b.modelName === "string") skuRequest.modelName = b.modelName;
      if (typeof b.vendorId === "string") skuRequest.vendorId = b.vendorId;
      if (typeof b.serialNumberFormat === "string") skuRequest.serialNumberFormat = b.serialNumberFormat;
      if (["direct_master_carton", "unit_packaging"].includes(b.cartonType)) skuRequest.cartonType = b.cartonType;
      if (b.stickerFormat) skuRequest.stickerFormat = { id: b.stickerFormat.id || null, name: b.stickerFormat.name || "" };
      if (b.configuration && typeof b.configuration === "object") skuRequest.configuration = b.configuration;

      const prev = skuRequest.status;
      skuRequest.status = "PendingSales";
      skuRequest.rejectedAtStage = "";
      skuRequest.resubmissionAllowed = false; // consumed
      skuRequest.modelAllotmentSource = "";
      skuRequest.salesReviewedBy = { userId: null, name: "" };
      skuRequest.salesReviewedAt = null;
      skuRequest.approvedBy = { userId: null, name: "" };
      skuRequest.approvedAt = null;
      skuRequest.statusHistory.push({
        fromStatus: prev,
        toStatus: "PendingSales",
        actorType: "cpanel",
        changedByName: (skuRequest.raisedBy && skuRequest.raisedBy.name) || "",
        remarks: b.remarks || "Resubmitted after edit",
        changedAt: new Date(),
      });

      const saved = await skuRequest.save();
      return res.status(200).json({
        status: 200,
        message: "SKU request resubmitted for review.",
        sku_code: saved.skuCode,
        id: saved._id,
        data: saved,
      });
    } catch (error) {
      console.error("resubmitFromCpanel (sku) error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /integrations/cpanel/skus/:id  (service-key auth)
   * Customer edits a SKU request that's still awaiting Sales review — updates
   * fields in place without touching status. Only while PendingSales; once
   * Sales has acted, edits go through resubmitFromCpanel instead.
   */
  updateFromCpanel: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id);
      if (!skuRequest) return res.status(404).json({ status: 404, message: "SKU request not found." });
      if (skuRequest.status !== "PendingSales") {
        return res.status(409).json({ status: 409, message: `Only a SKU request pending Sales review can be edited (this one is ${skuRequest.status}).` });
      }

      const b = req.body || {};
      if (b.deviceCategory) skuRequest.deviceCategory = { id: b.deviceCategory.id ?? null, name: b.deviceCategory.name || "" };
      if (b.esim) skuRequest.esim = { provider: b.esim.provider === "customer" ? "customer" : "jsd", make: b.esim.make || "", profile1: b.esim.profile1 || "", profile2: b.esim.profile2 || "" };
      if (skuRequest.esim.provider === "customer") {
        skuRequest.esimRechargePeriod = "";
      } else if (b.esimRechargePeriod && VALID_RECHARGE.includes(b.esimRechargePeriod)) {
        skuRequest.esimRechargePeriod = b.esimRechargePeriod;
      }
      if (b.firmware) skuRequest.firmware = { id: b.firmware.id ?? null, name: b.firmware.name || "" };
      if (typeof b.modelName === "string") skuRequest.modelName = b.modelName;
      if (typeof b.vendorId === "string") skuRequest.vendorId = b.vendorId;
      if (typeof b.serialNumberFormat === "string") skuRequest.serialNumberFormat = b.serialNumberFormat;
      if (["direct_master_carton", "unit_packaging"].includes(b.cartonType)) skuRequest.cartonType = b.cartonType;
      if (b.stickerFormat) skuRequest.stickerFormat = { id: b.stickerFormat.id || null, name: b.stickerFormat.name || "" };
      if (b.configuration && typeof b.configuration === "object") skuRequest.configuration = b.configuration;

      skuRequest.statusHistory.push({
        fromStatus: skuRequest.status,
        toStatus: skuRequest.status,
        actorType: "cpanel",
        changedByName: (skuRequest.raisedBy && skuRequest.raisedBy.name) || "",
        remarks: b.remarks || "Edited by customer while pending review",
        changedAt: new Date(),
      });

      const saved = await skuRequest.save();
      return res.status(200).json({
        status: 200,
        message: "SKU request updated.",
        sku_code: saved.skuCode,
        id: saved._id,
        data: saved,
      });
    } catch (error) {
      console.error("updateFromCpanel (sku) error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * DELETE /integrations/cpanel/skus/:id  (service-key auth)
   * Customer withdraws a SKU request that's still awaiting Sales review. Only
   * while PendingSales — once Sales/NPD have acted, the decision stands.
   */
  deleteFromCpanel: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id);
      if (!skuRequest) return res.status(404).json({ status: 404, message: "SKU request not found." });
      if (skuRequest.status !== "PendingSales") {
        return res.status(409).json({ status: 409, message: `Only a SKU request pending Sales review can be deleted (this one is ${skuRequest.status}).` });
      }
      await skuRequest.deleteOne();
      return res.status(200).json({ status: 200, message: "SKU request deleted." });
    } catch (error) {
      console.error("deleteFromCpanel (sku) error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  // ============================= Sales stage =============================

  /**
   * GET /sales/skus  (JWT + SALES_SKU_REQUESTS read)
   * `view` groups by Sales's own outcome rather than the raw current status,
   * since a request Sales approved keeps moving (PendingNpd -> Completed, or
   * Rejected by NPD later) but should still show under Sales's "Approved" tab:
   *   view=pending  -> currently awaiting Sales (status=PendingSales)
   *   view=approved -> Sales has approved it, regardless of what happened since
   *   view=rejected -> Sales itself rejected it
   */
  salesList: async (req, res) => {
    try {
      const { search, view } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      const filter = {};
      if (view === "approved") {
        filter.salesReviewedAt = { $ne: null };
      } else if (view === "rejected") {
        filter.status = "Rejected";
        filter.rejectedAtStage = "sales";
      } else {
        filter.status = "PendingSales";
      }
      if (search) {
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ skuCode: rx }, { modelName: rx }, { "deviceCategory.name": rx }, { "raisedBy.name": rx }];
      }

      const total = await SkuRequest.countDocuments(filter);
      const data = await SkuRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("skuRequest salesList error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /sales/skus/:id  (JWT + SALES_SKU_REQUESTS read)
   * Also resolves whether a Model+Vendor ID is already allotted to this
   * customer+firmware in GPSCPANEL, so the review UI knows whether to show
   * it read-only or ask Sales to allot one.
   */
  salesGetOne: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id).lean();
      if (!skuRequest) {
        return res.status(404).json({ status: 404, message: "SKU request not found." });
      }

      // `error: true` is distinct from a genuine "not found" — a transient
      // CPanel outage or misconfiguration must NOT look identical to "no
      // model allotted yet", or Sales could re-allot a new model over an
      // existing one just because the lookup itself failed to answer.
      let modelLookup = { found: false, model_name: "", vendor_id: "", error: false };
      let modelOptions = [];
      try {
        const base = (process.env.CPANEL_API_URL || "").replace(/\/$/, "");
        if (!base) {
          modelLookup.error = true;
        } else if (skuRequest.raisedBy?.cpanelUserId && skuRequest.firmware?.id) {
          const url = new URL(base + "/api/integrations/mes/model-lookup");
          url.searchParams.set("user_id", skuRequest.raisedBy.cpanelUserId);
          url.searchParams.set("firmware_id", skuRequest.firmware.id);
          const r = await fetch(url, { headers: { "x-api-key": process.env.CPANEL_API_KEY || "" } });
          if (r.ok) {
            modelLookup = { ...(await r.json()), error: false };
          } else {
            modelLookup.error = true;
          }
        }
      } catch (e) {
        console.error("salesGetOne model-lookup error:", e);
        modelLookup.error = true;
      }

      // Master pick-list: Model/Vendor ID combos from MES's own RS232 Command
      // Master, so Sales can reuse a known combo when this customer has no
      // GPSCPANEL allotment yet, instead of typing blind. Non-fatal on failure.
      if (!modelLookup.found) {
        try {
          modelOptions = await modelOptionsFor(skuRequest.raisedBy?.name);
        } catch (e) {
          console.error("salesGetOne rs232 model-options error:", e);
        }
      }

      return res.status(200).json({ status: 200, data: skuRequest, modelLookup, modelOptions });
    } catch (error) {
      console.error("skuRequest salesGetOne error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /sales/skus/:id/approve  (JWT + SALES_SKU_REQUESTS update)
   * Body: { modelName, vendorId, source: "existing"|"new", remarks? }
   * Confirms/allots the Model + Vendor ID, forwards to NPD. When newly
   * allotted, also pushes the record into GPSCPANEL's Modal table so future
   * Purchase Orders for this customer+firmware find it automatically.
   */
  salesApprove: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id);
      if (!skuRequest) {
        return res.status(404).json({ status: 404, message: "SKU request not found." });
      }
      if (skuRequest.status !== "PendingSales") {
        return res.status(409).json({ status: 409, message: `SKU request is ${skuRequest.status}; this action is not allowed.` });
      }

      const modelName = String(req.body?.modelName || "").trim();
      const vendorId = String(req.body?.vendorId || "").trim();
      const source = req.body?.source === "existing" ? "existing" : "new";
      if (!modelName || !vendorId) {
        return res.status(400).json({ status: 400, message: "modelName and vendorId are required to approve a SKU request." });
      }

      if (source === "new") {
        try {
          await cpanelPost("/api/integrations/mes/models", {
            user_id: skuRequest.raisedBy?.cpanelUserId,
            firmware_id: skuRequest.firmware?.id,
            model_name: modelName,
            vendor_id: vendorId,
          });
        } catch (e) {
          console.error("salesApprove: failed to sync new model to CPanel:", e);
          return res.status(502).json({ status: 502, message: "Could not save the new model allotment to CPanel. Please retry.", error: e.message });
        }
      }

      const remarks = String(req.body?.remarks || "").trim();
      // Atomic, status-guarded update — the read above is only to build the
      // CPanel model-sync payload; a concurrent action (double-click, second
      // reviewer tab) between that read and here is caught by requiring
      // status still be "PendingSales" here, instead of blindly overwriting
      // whatever the other request just wrote via a plain findById+save.
      const saved = await SkuRequest.findOneAndUpdate(
        { _id: req.params.id, status: "PendingSales" },
        {
          $set: {
            modelName,
            vendorId,
            modelAllotmentSource: source,
            salesReviewedBy: { userId: req.user?._id || null, name: req.user?.name || req.user?.email || "" },
            salesReviewedAt: new Date(),
            status: "PendingNpd",
          },
          $push: {
            statusHistory: {
              fromStatus: "PendingSales",
              toStatus: "PendingNpd",
              actorType: "mes",
              changedBy: req.user?._id || null,
              changedByName: req.user?.name || req.user?.email || "",
              remarks: remarks || `Model ${source === "existing" ? "confirmed" : "allotted"}: ${modelName} / ${vendorId}`,
              changedAt: new Date(),
            },
          },
        },
        { new: true }
      );
      if (!saved) {
        return res.status(409).json({ status: 409, message: "This SKU request was already acted on by someone else." });
      }
      return res.status(200).json({ status: 200, message: "SKU request approved by Sales and sent to NPD.", data: saved });
    } catch (error) {
      console.error("skuRequest salesApprove error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /sales/skus/:id/reject  (JWT + SALES_SKU_REQUESTS update)
   * Requires remarks.
   */
  salesReject: async (req, res) => {
    try {
      const remarks = String(req.body?.remarks || "").trim();
      if (!remarks) {
        return res.status(400).json({ status: 400, message: "Remarks are required when rejecting a SKU request." });
      }

      const saved = await SkuRequest.findOneAndUpdate(
        { _id: req.params.id, status: "PendingSales" },
        {
          $set: {
            status: "Rejected",
            rejectedAtStage: "sales",
            salesRemarks: remarks,
            resubmissionAllowed: !!req.body?.resubmissionAllowed,
          },
          $push: {
            statusHistory: {
              fromStatus: "PendingSales",
              toStatus: "Rejected",
              actorType: "mes",
              changedBy: req.user?._id || null,
              changedByName: req.user?.name || req.user?.email || "",
              remarks,
              changedAt: new Date(),
            },
          },
        },
        { new: true }
      );
      if (!saved) {
        const existing = await SkuRequest.findById(req.params.id).select("status").lean();
        if (!existing) {
          return res.status(404).json({ status: 404, message: "SKU request not found." });
        }
        return res.status(409).json({ status: 409, message: `SKU request is ${existing.status}; this action is not allowed.` });
      }
      return res.status(200).json({ status: 200, message: "SKU request rejected.", data: saved });
    } catch (error) {
      console.error("skuRequest salesReject error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  // ============================== NPD stage ===============================

  /**
   * GET /npd/skus  (JWT + NPD_SKU_REQUESTS read)
   */
  list: async (req, res) => {
    try {
      const { search, status } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      // NPD never sees PendingSales requests; when it filters on "Rejected" it
      // only means requests NPD itself rejected (Sales-rejected ones never
      // reached NPD and shouldn't appear in its queue). Enforced here, not
      // just by the frontend always sending a status — an omitted/unknown
      // status still falls back to the NPD-relevant set instead of leaking
      // every status (including PendingSales) to any other caller.
      const filter = {};
      const andClauses = [];
      if (status === "Rejected") {
        filter.status = "Rejected";
        filter.rejectedAtStage = "npd";
      } else if (["PendingNpd", "Completed"].includes(status)) {
        filter.status = status;
      } else {
        andClauses.push({
          $or: [
            { status: "PendingNpd" },
            { status: "Completed" },
            { status: "Rejected", rejectedAtStage: "npd" },
          ],
        });
      }
      if (search) {
        // No customer-name search here — NPD shouldn't be able to search by
        // (or infer) customer identity, which is Sales & Accounts information.
        const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        andClauses.push({ $or: [{ skuCode: rx }, { modelName: rx }, { "deviceCategory.name": rx }] });
      }
      if (andClauses.length) {
        filter.$and = andClauses;
      }

      const total = await SkuRequest.countDocuments(filter);
      const data = await SkuRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();
      redactCustomer(data);

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("skuRequest list error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /npd/skus/:id  (JWT + NPD_SKU_REQUESTS read)
   */
  getOne: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id).lean();
      if (!skuRequest) {
        return res.status(404).json({ status: 404, message: "SKU request not found." });
      }
      redactCustomer(skuRequest);
      return res.status(200).json({ status: 200, data: skuRequest });
    } catch (error) {
      console.error("skuRequest getOne error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /npd/skus/:id/approve  (JWT + NPD_SKU_REQUESTS update)
   * Final approval — the SKU is now Completed and can be used to raise a PO.
   */
  approve: async (req, res) => {
    return transition(req, res, "Completed");
  },

  /**
   * PUT /npd/skus/:id/reject  (JWT + NPD_SKU_REQUESTS update)
   * Requires remarks.
   */
  reject: async (req, res) => {
    if (!String(req.body?.remarks || "").trim()) {
      return res.status(400).json({ status: 400, message: "Remarks are required when rejecting a SKU request." });
    }
    return transition(req, res, "Rejected");
  },

  /**
   * PUT /npd/skus/:id/config  (JWT + NPD_SKU_REQUESTS update)
   * Body: { fgBomNumber?, tranzactId? }. NPD-owned reference numbers — not
   * submitted by the customer, not gated by status (editable at any stage,
   * including after the SKU is Completed, unlike model/vendor allotment).
   */
  updateNpdConfig: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id);
      if (!skuRequest) {
        return res.status(404).json({ status: 404, message: "SKU request not found." });
      }

      const changed = [];
      if (typeof req.body?.fgBomNumber === "string") {
        skuRequest.fgBomNumber = req.body.fgBomNumber.trim();
        changed.push("fgBomNumber");
      }
      if (typeof req.body?.tranzactId === "string") {
        skuRequest.tranzactId = req.body.tranzactId.trim();
        changed.push("tranzactId");
      }
      if (changed.length === 0) {
        return res.status(400).json({ status: 400, message: "Nothing to update — provide fgBomNumber and/or tranzactId." });
      }

      skuRequest.statusHistory.push({
        fromStatus: skuRequest.status,
        toStatus: skuRequest.status,
        actorType: "mes",
        changedBy: req.user?._id || null,
        changedByName: req.user?.name || req.user?.email || "",
        remarks: `NPD updated: ${changed.join(", ")}`,
        changedAt: new Date(),
      });

      const saved = await skuRequest.save();
      return res.status(200).json({ status: 200, message: "Updated.", data: saved });
    } catch (error) {
      console.error("skuRequest updateNpdConfig error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },
};

/**
 * Shared NPD approve/reject transition with history append. Only valid from
 * PendingNpd (i.e. after Sales has confirmed/allotted the model).
 */
async function transition(req, res, toStatus) {
  try {
    const remarks = String(req.body?.remarks || "").trim();
    const fromStatus = "PendingNpd";

    const set = { status: toStatus, npdRemarks: remarks };
    if (toStatus === "Rejected") {
      set.rejectedAtStage = "npd";
      set.resubmissionAllowed = !!req.body?.resubmissionAllowed;
    }
    if (toStatus === "Completed") {
      set.approvedBy = { userId: req.user?._id || null, name: req.user?.name || req.user?.email || "" };
      set.approvedAt = new Date();
    }

    // Atomic, status-guarded update — avoids a TOCTOU race where two
    // concurrent requests (double-click, two reviewer tabs) both pass a
    // separate findById status check before either write lands.
    const saved = await SkuRequest.findOneAndUpdate(
      { _id: req.params.id, status: fromStatus },
      {
        $set: set,
        $push: {
          statusHistory: {
            fromStatus,
            toStatus,
            actorType: "mes",
            changedBy: req.user?._id || null,
            changedByName: req.user?.name || req.user?.email || "",
            remarks,
            changedAt: new Date(),
          },
        },
      },
      { new: true }
    );
    if (!saved) {
      const existing = await SkuRequest.findById(req.params.id).select("status").lean();
      if (!existing) {
        return res.status(404).json({ status: 404, message: "SKU request not found." });
      }
      return res.status(409).json({ status: 409, message: `SKU request is ${existing.status}; this action is not allowed.` });
    }
    return res.status(200).json({
      status: 200,
      message: `SKU request ${toStatus.toLowerCase()} successfully.`,
      data: saved,
    });
  } catch (error) {
    console.error("skuRequest transition error:", error);
    return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
  }
}
