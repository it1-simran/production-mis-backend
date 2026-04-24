const mongoose = require("mongoose");

const deviceSchemas = new mongoose.Schema({
  productType: { type: mongoose.Schema.Types.ObjectId, ref: "products" },
  processID: { type: mongoose.Schema.Types.ObjectId, ref: "process" },
  serialNo: { type: String, required: true },
  imeiNo: { type: String, required: false, default: "" },
  customFields: { type: Object, required: false, default: {} },
  modelName: { type: String, required: false, default: "" },
  ccid: { type: String, required: false, default: "" },
  status: { type: String, required: false, default: "" },
  currentStage: { type: String, required: false, default: "" },
  dispatchStatus: {
    type: String,
    required: false,
    enum: ["READY", "RESERVED", "DISPATCHED"],
    default: undefined,
  },
  dispatchInvoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DispatchInvoice",
    required: false,
    default: null,
  },
  dispatchDate: { type: Date, required: false, default: null },
  customerName: { type: String, required: false, default: "" },
  warrantyStartDate: { type: Date, required: false, default: null },
  warrantyEndDate: { type: Date, required: false, default: null },
  cartonSerial: { type: String, required: false, default: "" },
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

  // Auto-populate imeiNo from customFields if missing
  if (!this.imeiNo && this.customFields) {
    const cf = this.customFields;
    const imei = (cf.Functional && cf.Functional.IMEI) || 
                 (cf.functional && cf.functional.imei) ||
                 (cf.Functional && cf.Functional.imei) ||
                 (cf.functional && cf.functional.IMEI);
    if (imei) {
      this.imeiNo = String(imei).trim();
    }
  }
  next();
});

// Middleware for findByIdAndUpdate
deviceSchemas.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update && update.$set) {
    let cf = update.$set.customFields;
    if (typeof cf === 'string') {
      try {
        cf = JSON.parse(cf);
        update.$set.customFields = cf;
      } catch (err) {
        // ignore
      }
    }
    
    if (!update.$set.imeiNo && cf) {
      const imei = (cf.Functional && cf.Functional.IMEI) || 
                   (cf.functional && cf.functional.imei) ||
                   (cf.Functional && cf.Functional.imei) ||
                   (cf.functional && cf.functional.IMEI);
      if (imei) {
        update.$set.imeiNo = String(imei).trim();
      }
    }
  }
  next();
});

deviceSchemas.pre('updateOne', function (next) {
  const update = this.getUpdate();
  if (update && update.$set) {
    let cf = update.$set.customFields;
    if (typeof cf === 'string') {
      try {
        cf = JSON.parse(cf);
        update.$set.customFields = cf;
      } catch (err) {
        // ignore
      }
    }
    
    if (!update.$set.imeiNo && cf) {
      const imei = (cf.Functional && cf.Functional.IMEI) || 
                   (cf.functional && cf.functional.imei) ||
                   (cf.Functional && cf.Functional.imei) ||
                   (cf.functional && cf.functional.IMEI);
      if (imei) {
        update.$set.imeiNo = String(imei).trim();
      }
    }
  }
  next();
});

deviceSchemas.index({ serialNo: 1 });
deviceSchemas.index({ processID: 1 });
deviceSchemas.index({ serialNo: 1, processID: 1 });
deviceSchemas.index({ dispatchStatus: 1, dispatchInvoiceId: 1 });
deviceSchemas.index({ imeiNo: 1 });
deviceSchemas.index({ ccid: 1 });
deviceSchemas.index({ productType: 1, processID: 1, currentStage: 1, status: 1 });

const device = mongoose.model("devices", deviceSchemas);
module.exports = device;


