const mongoose = require("mongoose");
const StickerFormatMaster = require("../models/stickerFormatMaster");
const productModel = require("../models/Products");
const processModel = require("../models/process");

module.exports = {
  // POST /sticker/format/create
  create: async (req, res) => {
    try {
      const { name, dimensions, fields } = req.body;
      if (!name || !String(name).trim()) {
        return res.status(400).json({ status: 400, message: "Format name is required." });
      }
      const format = new StickerFormatMaster({
        name: String(name).trim(),
        dimensions: dimensions || {},
        fields: Array.isArray(fields) ? fields : [],
        createdBy: req.user?._id || null,
      });
      const saved = await format.save();
      return res.status(200).json({ status: 200, message: "Sticker format created successfully.", data: saved });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  // GET /sticker/format/list
  getAll: async (req, res) => {
    try {
      const formats = await StickerFormatMaster.aggregate([
        { $sort: { createdAt: -1 } },
        {
          $project: {
            name: 1,
            dimensions: 1,
            createdAt: 1,
            updatedAt: 1,
            fieldsCount: { $size: { $ifNull: ["$fields", []] } },
          },
        },
      ]);
      return res.status(200).json({ status: 200, message: "Sticker formats fetched successfully.", data: formats });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  // GET /sticker/format/:id
  getById: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid format ID." });
      }
      const format = await StickerFormatMaster.findById(id).lean();
      if (!format) {
        return res.status(404).json({ status: 404, message: "Sticker format not found." });
      }
      return res.status(200).json({ status: 200, message: "Sticker format fetched successfully.", data: format });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  // PUT /sticker/format/:id
  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid format ID." });
      }
      const { name, dimensions, fields } = req.body;
      const updatePayload = {};
      if (name !== undefined) updatePayload.name = String(name).trim();
      if (dimensions !== undefined) updatePayload.dimensions = dimensions;
      if (fields !== undefined) updatePayload.fields = Array.isArray(fields) ? fields : [];

      const updated = await StickerFormatMaster.findByIdAndUpdate(
        id,
        { $set: updatePayload },
        { new: true, runValidators: true }
      ).lean();
      if (!updated) {
        return res.status(404).json({ status: 404, message: "Sticker format not found." });
      }
      return res.status(200).json({ status: 200, message: "Sticker format updated successfully.", data: updated });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  // DELETE /sticker/format/:id
  // Blocked if any product or process substep references this format
  delete: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid format ID." });
      }
      const oid = new mongoose.Types.ObjectId(id);

      // Check products
      const affectedProducts = await productModel
        .find({ "stages.subSteps.stickerFormatId": oid })
        .select("name")
        .lean();

      // Check processes
      const affectedProcesses = await processModel
        .find({ "stages.subSteps.stickerFormatId": oid })
        .select("name processID")
        .lean();

      if (affectedProducts.length > 0 || affectedProcesses.length > 0) {
        return res.status(409).json({
          status: 409,
          message: "Cannot delete — this format is in use. Remove references from the listed products and processes first.",
          affectedProducts: affectedProducts.map((p) => ({ _id: p._id, name: p.name })),
          affectedProcesses: affectedProcesses.map((p) => ({ _id: p._id, name: p.name, processID: p.processID })),
        });
      }

      const deleted = await StickerFormatMaster.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ status: 404, message: "Sticker format not found." });
      }
      return res.status(200).json({ status: 200, message: "Sticker format deleted successfully." });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
