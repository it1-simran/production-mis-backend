const mongoose = require("mongoose");

const deviceSchemas = new mongoose.Schema({
  productType: { type: mongoose.Schema.Types.ObjectId, ref: "products" },
  processID: { type: mongoose.Schema.Types.ObjectId, ref: "process" },
  serialNo: { type: String, required: true },
  imeiNo: { type: String, required: false, default: "" },
  customFields: { type: Object, required: false, default: {} },
  modelName: { type: String, required: false, default: "" },
  status: { type: String, required: false, default: "" },
  currentStage: { type: String, required: false, default: "" },
  flowVersion: { type: Number, required: false, default: 1 },
  flowStartedAt: { type: Date, required: false, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Middleware to parse customFields if it's a string
deviceSchemas.pre('save', function (next) {
  if (typeof this.customFields === 'string') {
    try {
      this.customFields = JSON.parse(this.customFields);
    } catch (err) {
      this.customFields = {};
    }
  }
  next();
});

// Middleware for findByIdAndUpdate
deviceSchemas.pre('findByIdAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update && typeof update.$set?.customFields === 'string') {
    try {
      update.$set.customFields = JSON.parse(update.$set.customFields);
    } catch (err) {
      update.$set.customFields = {};
    }
  }
  next();
});

deviceSchemas.index({ serialNo: 1 });
deviceSchemas.index({ processID: 1 });
deviceSchemas.index({ serialNo: 1, processID: 1 });

const device = mongoose.model("devices", deviceSchemas);
module.exports = device;
