const mongoose = require("mongoose");
const stickerFieldModel = require("../models/stickerFieldManagement");

module.exports = {
  createStickerField: async (req, res) => {
    try {
      const { stickerFieldId, ...data } = req?.body;
  
      if (!data || Object.keys(data).length === 0) {
        return res.status(400).json({
          status: 400,
          message: "Invalid data provided",
        });
      }
  
      let savedStickerField;
  
      if (stickerFieldId) {
        if (!mongoose.Types.ObjectId.isValid(stickerFieldId)) {
          return res.status(400).json({ status: 400, message: "Invalid sticker field ID" });
        }
        savedStickerField = await stickerFieldModel.findOneAndUpdate(
          { _id: stickerFieldId },
          data,
          {
            new: true,
            upsert: true,
            runValidators: true,
          }
        );
      } else {
        // Create a new sticker field
        const newStickerField = new stickerFieldModel(data);
        savedStickerField = await newStickerField.save();
      }
  
      return res.status(200).json({
        status: 200,
        message: stickerFieldId
          ? "Sticker Field Updated Successfully!!"
          : "Sticker Field Created Successfully!!",
        data: savedStickerField,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  
  getStickerField: async (req, res) => {
    try {
      let stickerFields = await stickerFieldModel.find().sort({ _id: -1 });
      return res.status(200).json({
        status: 200,
        message: "Sticker Fields Fetched Successfully!!",
        data: stickerFields,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deleteStickerField: async (req, res) => {
    try {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid sticker field ID" });
      }
      const stickerField = await stickerFieldModel.findByIdAndDelete(id);
      if (!stickerField) {
        return res.status(404).json({ status: 404, message: "Sticker Field not found" });
      }
      res.status(200).json({
        status: 200,
        message: "Sticker Field deleted successfully",
        stickerField,
      });
    } catch (error) {
      res.status(500).json({ status: 500, message: "Failed to delete sticker field" });
    }
  },
  deleteStickerFieldMultiple: async (req, res) => {
    try {
      const ids = req.body.deleteIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          message: "Invalid request, ids must be an array of strings",
        });
      }
      const objectIds = ids.map((id) => {
        if (mongoose.Types.ObjectId.isValid(id)) {
          return new mongoose.Types.ObjectId(id);
        } else {
          throw new Error(`Invalid ObjectId: ${id}`);
        }
      });

      const result = await stickerFieldModel.deleteMany({
        _id: { $in: objectIds },
      });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} Sticker Field(s) deleted successfully`,
      });
    } catch (error) {
      res.status(500).json({ status: 500, message: "Failed to delete sticker fields" });
    }
  },
};
