const mongoose = require("mongoose");

const cartonManagementSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "products", required: true },
    devices: [
      {
        deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "devices", required: false },
      },
    ],
    cartonSize: {
      width: { type: String, required: false, default: "" },
      height: { type: String, required: false, default: "" },
    },
    maxCapacity: { type: String, required: false, default: "" },
    status: { type: String, required: false, default: "" },
    weightCarton: { type: String, required: false, default: "" },
  },
  { timestamps: true }
);

const CartonManagement = mongoose.model("CartonManagement", cartonManagementSchema);
module.exports = CartonManagement;