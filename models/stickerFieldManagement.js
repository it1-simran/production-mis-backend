const mongoose = require("mongoose");

const StickerFieldManagementSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const ShiftManagement = mongoose.model(
  "StickerField",
  StickerFieldManagementSchema
);

module.exports = ShiftManagement;
