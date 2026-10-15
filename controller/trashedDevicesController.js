// Read-only list of one process's crashed devices (status "Crashed" / legacy "Trashed", written by
// the TRC single trash in deviceController.trashDevice). Feeds the View Planning
// "Crashed" count and popup.
const mongoose = require("mongoose");
const deviceModel = require("../models/device");

const { CRASHED_STATUS_VALUES } = require("../constants/crashStatus");
const MAX_EXPORT_ROWS = 10000;

const normalizeText = (value) => String(value ?? "").trim();
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toTrashedRow = (device) => ({
  _id: device._id,
  serialNo: device.serialNo,
  imeiNo: device.trash?.imeiNo || "",
  ccid: device.trash?.ccid || "",
  previousStage: device.trash?.previousStage || device.currentStage || "",
  reason: device.trash?.reason || "",
  trashedAt: device.trash?.trashedAt || device.updatedAt || null,
  trashedByName: device.trash?.trashedByName || "",
});

module.exports = {
  // GET /devices/trashed-by-process/:processId  ?page&limit&search&export=1
  listTrashedDevicesByProcess: async (req, res) => {
    try {
      const { processId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(processId)) {
        return res.status(400).json({ status: 400, message: "Invalid process id" });
      }
      const query = req.query || {};
      const isExport = String(query.export || "") === "1";
      const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
      const limitNum = isExport
        ? MAX_EXPORT_ROWS
        : Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
      const skip = isExport ? 0 : (pageNum - 1) * limitNum;

      const filter = { status: { $in: CRASHED_STATUS_VALUES }, processID: new mongoose.Types.ObjectId(processId) };
      const search = normalizeText(query.search);
      if (search) {
        const rx = { $regex: escapeRegex(search), $options: "i" };
        filter.$or = [{ serialNo: rx }, { "trash.imeiNo": rx }, { "trash.ccid": rx }];
      }

      const [devices, total] = await Promise.all([
        deviceModel
          .find(filter)
          .select("_id serialNo currentStage trash updatedAt")
          .sort({ "trash.trashedAt": -1, updatedAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        deviceModel.countDocuments(filter),
      ]);

      return res.status(200).json({
        status: 200,
        data: devices.map(toTrashedRow),
        meta: { page: pageNum, limit: limitNum, total, truncated: isExport && total > limitNum },
      });
    } catch (error) {
      console.error("[ERROR] listTrashedDevicesByProcess:", error);
      return res.status(500).json({ status: 500, message: "Failed to fetch crashed devices", details: error.message });
    }
  },
};
