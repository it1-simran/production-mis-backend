const mongoose = require("mongoose");

const deviceSchemas = new mongoose.Schema({
  productType: { type: mongoose.Schema.Types.ObjectId, ref: "products" },
  processID: { type:mongoose.Schema.Types.ObjectId, ref: "processes"},
  serialNo: { type: String, required: true },
  imeiNo: { type: String, required: false, default: "" },
  modelName: { type: String, required: false, default: "" },
  status: { type: String, required: false, default: "" },
  currentStage: { type: String, required: false, default: "" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
const device = mongoose.model("devices", deviceSchemas);
module.exports = device;
