const mongoose = require("mongoose");

const imeiSchemas = new mongoose.Schema({
  productType: { type: mongoose.Schema.Types.ObjectId, ref: "products" },
  imeiNo: { type: String, required: false, default: "" },
  status: { type: String, required: false, default: "" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
const device = mongoose.model("imei", imeiSchemas);
module.exports = device;
