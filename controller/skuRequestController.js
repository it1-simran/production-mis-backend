const SkuRequest = require("../models/SkuRequest");
const Sequence = require("../models/Sequence");

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

module.exports = {
  /**
   * POST /integrations/cpanel/skus  (service-key auth)
   * Raise a SKU request from CPanel.
   */
  createFromCpanel: async (req, res) => {
    try {
      const b = req.body || {};

      const esimRechargePeriod = String(b.esimRechargePeriod || "").trim();
      if (!VALID_RECHARGE.includes(esimRechargePeriod)) {
        return res.status(400).json({ status: 400, message: "esimRechargePeriod must be 1_year or 2_year." });
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
          make: b.esim?.make || "",
          profile1: b.esim?.profile1 || "",
          profile2: b.esim?.profile2 || "",
        },
        esimRechargePeriod,
        firmware: { id: b.firmware?.id ?? null, name: b.firmware?.name || "" },
        modelName: String(b.modelName || "").trim(),
        vendorId: b.vendorId || "",
        configuration: b.configuration && typeof b.configuration === "object" ? b.configuration : {},
        status: "Pending",
        statusHistory: [
          {
            fromStatus: null,
            toStatus: "Pending",
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
        message: "SKU request submitted and sent for NPD approval.",
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
   * NPD allowed resubmission. Updates fields and returns it to Pending.
   */
  resubmitFromCpanel: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id);
      if (!skuRequest) return res.status(404).json({ status: 404, message: "SKU request not found." });
      if (skuRequest.status !== "Rejected") {
        return res.status(409).json({ status: 409, message: `Only a rejected SKU request can be resubmitted (this one is ${skuRequest.status}).` });
      }
      if (!skuRequest.resubmissionAllowed) {
        return res.status(403).json({ status: 403, message: "NPD has not permitted resubmission of this SKU request." });
      }

      const b = req.body || {};
      if (b.deviceCategory) skuRequest.deviceCategory = { id: b.deviceCategory.id ?? null, name: b.deviceCategory.name || "" };
      if (b.esim) skuRequest.esim = { make: b.esim.make || "", profile1: b.esim.profile1 || "", profile2: b.esim.profile2 || "" };
      if (b.esimRechargePeriod && VALID_RECHARGE.includes(b.esimRechargePeriod)) skuRequest.esimRechargePeriod = b.esimRechargePeriod;
      if (b.firmware) skuRequest.firmware = { id: b.firmware.id ?? null, name: b.firmware.name || "" };
      if (typeof b.modelName === "string") skuRequest.modelName = b.modelName;
      if (typeof b.vendorId === "string") skuRequest.vendorId = b.vendorId;
      if (b.configuration && typeof b.configuration === "object") skuRequest.configuration = b.configuration;

      const prev = skuRequest.status;
      skuRequest.status = "Pending";
      skuRequest.resubmissionAllowed = false; // consumed
      skuRequest.approvedBy = { userId: null, name: "" };
      skuRequest.approvedAt = null;
      skuRequest.statusHistory.push({
        fromStatus: prev,
        toStatus: "Pending",
        actorType: "cpanel",
        changedByName: (skuRequest.raisedBy && skuRequest.raisedBy.name) || "",
        remarks: b.remarks || "Resubmitted after edit",
        changedAt: new Date(),
      });

      const saved = await skuRequest.save();
      return res.status(200).json({
        status: 200,
        message: "SKU request resubmitted for approval.",
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
   * Customer edits a SKU request that's still awaiting NPD review — updates
   * fields in place without touching status. Only while Pending; once NPD has
   * acted, edits go through resubmitFromCpanel instead.
   */
  updateFromCpanel: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id);
      if (!skuRequest) return res.status(404).json({ status: 404, message: "SKU request not found." });
      if (skuRequest.status !== "Pending") {
        return res.status(409).json({ status: 409, message: `Only a pending SKU request can be edited (this one is ${skuRequest.status}).` });
      }

      const b = req.body || {};
      if (b.deviceCategory) skuRequest.deviceCategory = { id: b.deviceCategory.id ?? null, name: b.deviceCategory.name || "" };
      if (b.esim) skuRequest.esim = { make: b.esim.make || "", profile1: b.esim.profile1 || "", profile2: b.esim.profile2 || "" };
      if (b.esimRechargePeriod && VALID_RECHARGE.includes(b.esimRechargePeriod)) skuRequest.esimRechargePeriod = b.esimRechargePeriod;
      if (b.firmware) skuRequest.firmware = { id: b.firmware.id ?? null, name: b.firmware.name || "" };
      if (typeof b.modelName === "string") skuRequest.modelName = b.modelName;
      if (typeof b.vendorId === "string") skuRequest.vendorId = b.vendorId;
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
   * Customer withdraws a SKU request that's still awaiting NPD review. Only
   * while Pending — once NPD has approved/rejected it, the decision stands
   * (an Approved SKU may already be referenced by a raised PO; a Rejected one
   * is closed unless resubmitted).
   */
  deleteFromCpanel: async (req, res) => {
    try {
      const skuRequest = await SkuRequest.findById(req.params.id);
      if (!skuRequest) return res.status(404).json({ status: 404, message: "SKU request not found." });
      if (skuRequest.status !== "Pending") {
        return res.status(409).json({ status: 409, message: `Only a pending SKU request can be deleted (this one is ${skuRequest.status}).` });
      }
      await skuRequest.deleteOne();
      return res.status(200).json({ status: 200, message: "SKU request deleted." });
    } catch (error) {
      console.error("deleteFromCpanel (sku) error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /npd/skus  (JWT + NPD_SKU_REQUESTS read)
   */
  list: async (req, res) => {
    try {
      const { search, status } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

      const filter = {};
      if (status) filter.status = status;
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
      return res.status(200).json({ status: 200, data: skuRequest });
    } catch (error) {
      console.error("skuRequest getOne error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /npd/skus/:id/approve  (JWT + NPD_SKU_REQUESTS update)
   */
  approve: async (req, res) => {
    return transition(req, res, "Approved");
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
};

/**
 * Shared approve/reject transition with history append.
 */
async function transition(req, res, toStatus) {
  try {
    const skuRequest = await SkuRequest.findById(req.params.id);
    if (!skuRequest) {
      return res.status(404).json({ status: 404, message: "SKU request not found." });
    }
    if (skuRequest.status !== "Pending") {
      return res.status(409).json({ status: 409, message: `SKU request is ${skuRequest.status}; this action is not allowed.` });
    }

    const remarks = String(req.body?.remarks || "").trim();
    const fromStatus = skuRequest.status;

    skuRequest.status = toStatus;
    skuRequest.npdRemarks = remarks;
    if (toStatus === "Rejected") {
      skuRequest.resubmissionAllowed = !!req.body?.resubmissionAllowed;
    }
    if (toStatus === "Approved") {
      skuRequest.approvedBy = { userId: req.user?._id || null, name: req.user?.name || req.user?.email || "" };
      skuRequest.approvedAt = new Date();
    }
    skuRequest.statusHistory.push({
      fromStatus,
      toStatus,
      actorType: "mes",
      changedBy: req.user?._id || null,
      changedByName: req.user?.name || req.user?.email || "",
      remarks,
      changedAt: new Date(),
    });

    const saved = await skuRequest.save();
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
