const mongoose = require("mongoose");

const fieldSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    slug: { type: String, default: "" },
    sourceFields: [
      {
        name: { type: String, default: "" },
        slug: { type: String, default: "" },
      },
    ],
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    type: { type: String, default: "" },
    value: { type: String, default: "" },
    displayValue: { type: Boolean, default: true },
    barWidth: { type: Number, default: 1 },
    barWidthMm: { type: Number, default: 0.25 },
    barHeight: { type: Number, default: 0 },
    barHeightMm: { type: Number, default: 3.3 },
    barDensity: { type: Number, default: 0.636 },
    barLength: { type: Number, default: 0 },
    format: { type: String, default: "" },
    codeSet: { type: String, default: "Auto" },
    textEncoding: { type: String, default: "US-ASCII" },
    includeCheckDigit: { type: Boolean, default: false },
    hibc: { type: Boolean, default: false },
    gs1_128: { type: Boolean, default: false },
    lineColor: { type: String, default: "#000000" },
    background: { type: String, default: "transparent" },
    margin: { type: Number, default: 0 },
    fontSize: { type: Number, default: 12 },
    textMargin: { type: Number, default: 2 },
    valueFontBold: { type: Boolean, default: false },
    styles: {
      color: { type: String, default: "" },
      fontSize: { type: String, default: "" },
      fontStyle: { type: String, default: "" },
      fontWeight: { type: String, default: "" },
      textAlign: { type: String, default: "" },
      lineHeight: { type: String, default: "" },
      letterSpacing: { type: String, default: "" },
      backgroundColor: { type: String, default: "" },
      borderColor: { type: String, default: "" },
      borderWidth: { type: String, default: "" },
      borderRadius: { type: String, default: "" },
      padding: { type: String, default: "" },
      transform: { type: String, default: "" },
    },
  },
  { _id: false }
);

const stickerFormatMasterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    dimensions: {
      width: { type: String, default: "" },
      height: { type: String, default: "" },
    },
    fields: [fieldSchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

stickerFormatMasterSchema.index({ name: 1 });
stickerFormatMasterSchema.index({ createdAt: -1 });

module.exports = mongoose.model("StickerFormatMaster", stickerFormatMasterSchema, "stickerFormatMasters");
