const KycRequest = require("../models/KycRequest");

module.exports = {
  /**
   * POST /integrations/cpanel/kyc  (service-key auth)
   * Submit (or resubmit, if the previous request was Rejected with
   * resubmissionAllowed) a KYC request from CPanel.
   */
  createFromCpanel: async (req, res) => {
    try {
      const b = req.body || {};
      const raisedBy = b.raisedBy || {};
      if (!raisedBy.cpanelUserId) {
        return res.status(400).json({ status: 400, message: "raisedBy.cpanelUserId is required." });
      }
      if (!String(b.organizationName || "").trim() || !String(b.gstin || "").trim()) {
        return res.status(400).json({ status: 400, message: "organizationName and gstin are required." });
      }

      // Resubmission: if there's an existing Rejected request that allows it,
      // reuse that document (update in place + back to Pending) instead of
      // creating a duplicate — mirrors SkuRequest's resubmit semantics.
      const existing = await KycRequest.findOne({ "raisedBy.cpanelUserId": raisedBy.cpanelUserId }).sort({ createdAt: -1 });

      const fields = {
        organizationName: String(b.organizationName || "").trim(),
        gstin: String(b.gstin || "").trim().toUpperCase(),
        panNumber: String(b.panNumber || "").trim().toUpperCase(),
        organizationAddress: String(b.organizationAddress || "").trim(),
        hasDocument: !!b.hasDocument,
      };

      if (existing && existing.status === "Rejected" && existing.resubmissionAllowed) {
        Object.assign(existing, fields);
        existing.status = "Pending";
        existing.resubmissionAllowed = false;
        existing.remarks = "";
        existing.approvedBy = { userId: null, name: "" };
        existing.approvedAt = null;
        existing.statusHistory.push({
          fromStatus: "Rejected",
          toStatus: "Pending",
          actorType: "cpanel",
          changedByName: raisedBy.name || "",
          remarks: "Resubmitted after edit",
          changedAt: new Date(),
        });
        const saved = await existing.save();
        return res.status(200).json({ status: 200, message: "KYC resubmitted for review.", id: saved._id, data: saved });
      }

      if (existing && (existing.status === "Pending" || existing.status === "Approved")) {
        return res.status(409).json({
          status: 409,
          message: `A KYC request already exists for this account (${existing.status}).`,
          id: existing._id,
        });
      }

      const kycRequest = new KycRequest({
        source: b.source || "gpscpanel",
        raisedBy: {
          cpanelUserId: raisedBy.cpanelUserId,
          name: raisedBy.name || "",
          role: raisedBy.role || "",
          email: raisedBy.email || "",
          mobile: raisedBy.mobile || "",
        },
        ...fields,
        status: "Pending",
        statusHistory: [
          {
            fromStatus: null,
            toStatus: "Pending",
            actorType: "cpanel",
            changedByName: raisedBy.name || "",
            remarks: "KYC submitted from GPS CPanel",
            changedAt: new Date(),
          },
        ],
      });

      const saved = await kycRequest.save();
      return res.status(200).json({ status: 200, message: "KYC submitted for review.", id: saved._id, data: saved });
    } catch (error) {
      console.error("createFromCpanel (kyc) error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /integrations/cpanel/kyc/:cpanelUserId  (service-key auth)
   * Current KYC status for one account — CPanel calls this before allowing
   * SKU/PO creation, instead of trusting its own local kyc_status column.
   */
  getStatusForCpanel: async (req, res) => {
    try {
      const cpanelUserId = parseInt(req.params.cpanelUserId, 10);
      if (!cpanelUserId) {
        return res.status(400).json({ status: 400, message: "Invalid cpanelUserId." });
      }
      const kycRequest = await KycRequest.findOne({ "raisedBy.cpanelUserId": cpanelUserId }).sort({ createdAt: -1 }).lean();
      if (!kycRequest) {
        return res.status(200).json({ status: 200, data: { status: "NotSubmitted" } });
      }
      return res.status(200).json({
        status: 200,
        data: {
          status: kycRequest.status,
          remarks: kycRequest.remarks,
          resubmissionAllowed: kycRequest.resubmissionAllowed,
          id: kycRequest._id,
        },
      });
    } catch (error) {
      console.error("getStatusForCpanel (kyc) error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /accounts/kyc  (JWT + ACCOUNTS_KYC read)
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
        filter.$or = [{ organizationName: rx }, { gstin: rx }, { "raisedBy.name": rx }];
      }

      const total = await KycRequest.countDocuments(filter);
      const data = await KycRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      return res.status(200).json({ status: 200, data, total, page, limit });
    } catch (error) {
      console.error("kycRequest list error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /accounts/kyc/:id  (JWT + ACCOUNTS_KYC read)
   */
  getOne: async (req, res) => {
    try {
      const kycRequest = await KycRequest.findById(req.params.id).lean();
      if (!kycRequest) {
        return res.status(404).json({ status: 404, message: "KYC request not found." });
      }
      return res.status(200).json({ status: 200, data: kycRequest });
    } catch (error) {
      console.error("kycRequest getOne error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * GET /accounts/kyc/:id/document  (JWT + ACCOUNTS_KYC read)
   * Pure proxy — the reviewer's own JWT+permission is checked by the route
   * middleware before this even runs; GPSCPANEL's shared secret is only used
   * server-to-server here and never reaches the browser.
   */
  getDocument: async (req, res) => {
    try {
      const kycRequest = await KycRequest.findById(req.params.id).lean();
      if (!kycRequest) {
        return res.status(404).json({ status: 404, message: "KYC request not found." });
      }
      if (!kycRequest.hasDocument || !kycRequest.raisedBy?.cpanelUserId) {
        return res.status(404).json({ status: 404, message: "No document was submitted with this KYC request." });
      }

      const base = (process.env.CPANEL_API_URL || "").replace(/\/$/, "");
      if (!base) {
        return res.status(502).json({ status: 502, message: "CPANEL_API_URL not configured." });
      }
      const upstream = await fetch(`${base}/api/integrations/mes/kyc-document/${kycRequest.raisedBy.cpanelUserId}`, {
        headers: { "x-api-key": process.env.CPANEL_API_KEY || "" },
      });
      if (!upstream.ok) {
        return res.status(upstream.status === 404 ? 404 : 502).json({ status: upstream.status, message: "Could not fetch the document from CPanel." });
      }

      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", "inline");
      return res.status(200).send(buffer);
    } catch (error) {
      console.error("kycRequest getDocument error:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  /**
   * PUT /accounts/kyc/:id/approve  (JWT + ACCOUNTS_KYC update)
   */
  approve: async (req, res) => {
    return transition(req, res, "Approved");
  },

  /**
   * PUT /accounts/kyc/:id/reject  (JWT + ACCOUNTS_KYC update)
   * Requires remarks.
   */
  reject: async (req, res) => {
    if (!String(req.body?.remarks || "").trim()) {
      return res.status(400).json({ status: 400, message: "Remarks are required when rejecting a KYC request." });
    }
    return transition(req, res, "Rejected");
  },
};

/**
 * Shared approve/reject transition with history append.
 */
async function transition(req, res, toStatus) {
  try {
    const kycRequest = await KycRequest.findById(req.params.id);
    if (!kycRequest) {
      return res.status(404).json({ status: 404, message: "KYC request not found." });
    }
    if (kycRequest.status !== "Pending") {
      return res.status(409).json({ status: 409, message: `KYC request is ${kycRequest.status}; this action is not allowed.` });
    }

    const remarks = String(req.body?.remarks || "").trim();
    const fromStatus = kycRequest.status;

    kycRequest.status = toStatus;
    kycRequest.remarks = remarks;
    if (toStatus === "Rejected") {
      kycRequest.resubmissionAllowed = !!req.body?.resubmissionAllowed;
    }
    if (toStatus === "Approved") {
      kycRequest.approvedBy = { userId: req.user?._id || null, name: req.user?.name || req.user?.email || "" };
      kycRequest.approvedAt = new Date();
    }
    kycRequest.statusHistory.push({
      fromStatus,
      toStatus,
      actorType: "mes",
      changedBy: req.user?._id || null,
      changedByName: req.user?.name || req.user?.email || "",
      remarks,
      changedAt: new Date(),
    });

    const saved = await kycRequest.save();
    return res.status(200).json({
      status: 200,
      message: `KYC request ${toStatus.toLowerCase()} successfully.`,
      data: saved,
    });
  } catch (error) {
    console.error("kycRequest transition error:", error);
    return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
  }
}
