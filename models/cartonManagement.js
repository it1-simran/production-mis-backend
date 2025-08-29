const mongoose = require("mongoose");

const cartonManagementSchema = new mongoose.Schema(
  {
    cartonSerial: { type: String, required: true },
    processId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "processes",
      required: true,
    },
    devices: [{type: mongoose.Schema.Types.ObjectId,ref: "devices"}],
    cartonSize: {
      width: { type: String, required: false, default: "" },
      height: { type: String, required: false, default: "" },
    },
    maxCapacity: { type: String, required: false, default: "" },
    status: { type: String, required: false, default: "" },
    cartonStatus: {type:String, required:false, default:""},
    weightCarton: { type: String, required: false, default: "" },
  },
  { timestamps: true }
);

const CartonManagement = mongoose.model(
  "CartonManagement",
  cartonManagementSchema
);
module.exports = CartonManagement;
