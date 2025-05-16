const mongoose = require("mongoose");

const processSchema = new mongoose.Schema({
  name: { type: String, required: true },
  selectedProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'products', required: true },
  orderConfirmationNo: { type: String, required: true },
  processID: { type: String, required: true },
  quantity: { type: String, required: true },
  issuedKits: {type: Number, required:false, default:0},
  issuedCartons: {type: Number, default:0},
  consumedKits: {type:Number, default:0},
  consumedCartons: {type:Number, default:0},
  descripition: { type: String, required: true },
  fgToStore: {type: Number, required: false, default: 0},
  dispatchStatus: {
    type:String,
    enum: ['dispatched', 'not dispatched'],
    default: 'not dispatched'
  },
  deliverStatus : {
    type:String,
    enum: ['delivered', 'not delivered'],
    default: 'not delivered'
  },
  kitStatus: { 
    type: String,
    enum: [
      "issued",
      "partially_issued",
      "not_issued"
    ],
    default: "not_issued"
  },
  status: {
    type: String,
    enum: [
      "waiting_schedule",
      "Waiting_Kits_allocation",
      "Waiting_Kits_approval",
      "waiting_for_line_feeding",
      "waiting_for_kits_confirmation",
      "active",
      "down_time_hold",
      "completed"
    ],
    default: "waiting_schedule"
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Creating the model from schema
const Process = mongoose.model("process", processSchema);

module.exports = Process;
