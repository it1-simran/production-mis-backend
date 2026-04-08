const DispatchService = require("../services/dispatchService");

const dispatchService = new DispatchService();

const sendError = (res, error, fallbackMessage) =>
  res.status(error.status || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    error: error.message || fallbackMessage,
  });

module.exports = {
  getProcessDispatchSummaries: async (req, res) => {
    try {
      const summaries = await dispatchService.getProcessDispatchSummaries(req.query || {});
      return res.status(200).json({ success: true, data: summaries });
    } catch (error) {
      return sendError(res, error, "Failed to fetch dispatch summaries.");
    }
  },

  getReadyCartons: async (req, res) => {
    try {
      const cartons = await dispatchService.getReadyCartons(req.query || {});
      return res.status(200).json({ success: true, data: cartons });
    } catch (error) {
      return sendError(res, error, "Failed to fetch ready cartons.");
    }
  },

  getCartonBySerial: async (req, res) => {
    try {
      const carton = await dispatchService.getReadyCartonBySerial(req.params.cartonSerial);
      return res.status(200).json({ success: true, data: carton });
    } catch (error) {
      return sendError(res, error, "Failed to fetch carton.");
    }
  },

  createInvoice: async (req, res) => {
    try {
      const invoice = await dispatchService.createDraft(req.body || {}, req.user?.id || req.user?._id || null);
      return res.status(201).json({ success: true, data: invoice, message: "Dispatch draft created successfully." });
    } catch (error) {
      return sendError(res, error, "Failed to create dispatch invoice.");
    }
  },

  getInvoices: async (req, res) => {
    try {
      const invoices = await dispatchService.getInvoices(req.query || {});
      return res.status(200).json({ success: true, data: invoices });
    } catch (error) {
      return sendError(res, error, "Failed to fetch dispatch invoices.");
    }
  },

  getInvoiceById: async (req, res) => {
    try {
      const invoice = await dispatchService.getInvoiceById(req.params.id, { includeGatePass: true });
      return res.status(200).json({ success: true, data: invoice });
    } catch (error) {
      return sendError(res, error, "Failed to fetch dispatch invoice.");
    }
  },

  updateInvoice: async (req, res) => {
    try {
      const invoice = await dispatchService.updateDraft(req.params.id, req.body || {}, req.user?.id || req.user?._id || null);
      return res.status(200).json({ success: true, data: invoice, message: "Dispatch draft updated successfully." });
    } catch (error) {
      return sendError(res, error, "Failed to update dispatch invoice.");
    }
  },

  cancelInvoice: async (req, res) => {
    try {
      const invoice = await dispatchService.cancelInvoice(req.params.id, req.user?.id || req.user?._id || null);
      return res.status(200).json({ success: true, data: invoice, message: "Dispatch draft cancelled successfully." });
    } catch (error) {
      return sendError(res, error, "Failed to cancel dispatch invoice.");
    }
  },

  confirmInvoice: async (req, res) => {
    try {
      const invoice = await dispatchService.confirmInvoice(
        req.params.id,
        req.user?.id || req.user?._id || null,
        { includeImeiList: Boolean(req.body?.includeImeiList) }
      );
      return res.status(200).json({ success: true, data: invoice, message: "Dispatch invoice confirmed successfully." });
    } catch (error) {
      return sendError(res, error, "Failed to confirm dispatch invoice.");
    }
  },

  getGatePass: async (req, res) => {
    try {
      const gatePass = await dispatchService.getGatePass(req.params.id, {
        includeImeiList: String(req.query.includeImeiList || "").toLowerCase() === "true",
      });
      await dispatchService.markGatePassPrinted(req.params.id);
      return res.status(200).json({ success: true, data: gatePass });
    } catch (error) {
      return sendError(res, error, "Failed to fetch gate pass.");
    }
  },

  generateGatePassPdf: async (req, res) => {
    try {
      const gatePass = await dispatchService.getGatePass(req.params.id, {
        includeImeiList: Boolean(req.body?.includeImeiList),
      });
      await dispatchService.markGatePassPrinted(req.params.id);
      return res.status(200).json({
        success: true,
        data: {
          ...gatePass,
          contentType: "text/html",
          filename: `gate-pass-${req.params.id}.html`,
        },
      });
    } catch (error) {
      return sendError(res, error, "Failed to generate gate pass.");
    }
  },

  checkWarranty: async (req, res) => {
    try {
      const records = await dispatchService.checkWarranty(req.query || {});
      return res.status(200).json({ success: true, data: records });
    } catch (error) {
      return sendError(res, error, "Failed to check warranty.");
    }
  },
};
