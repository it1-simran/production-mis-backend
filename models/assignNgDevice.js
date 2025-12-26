const mongoose = require("mongoose");

const assignNgDeviceSchema = new mongoose.Schema({
  deviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "device",
    required: true,
  },
  processId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "processes",
    required: false,
  },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "planingandschedulings",
    required: false,
  },
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "products",
    required: false,
  },
  operatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "users",
    required: false,
  },
  serialNo: { type: String, required: false },
  stageName: { type: String, required: false },
  status: { type: String, required: false },
  assignDepartment: { type: String, enum: ["QC", "TRC"], required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const AssignNgDevice = mongoose.model(
  "assignNgDeviceRecords",
  assignNgDeviceSchema
);

module.exports = AssignNgDevice;
