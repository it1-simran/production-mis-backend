const mongoose = require("mongoose");

const assignKitsToLineSchema = new mongoose.Schema({
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "planingandschedulings",
    required: true,
  },
  processId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "processes",
    required: true,
  },
  issuedKits: {
    type: Number,
    required: false,
    default: 0,
  },
  seatDetails:{ 
    type: [{
      rowNumber: { type: String, required: false },
      seatNumber: { type: String, required: false },
      issuedKits: {type: Number, required: false}
    }],
    default: [],
  },
  issuedKitsStatus: { type: String ,enum : ["PARTIALLY_ISSUED","ISSUED","NOT_ISSUED",'REJECTED'],required: false},
  status:{type: String, enum: ["ASSIGN_TO_OPERATOR","CONFIRM","REJECT"],required: true},
  createdAt: {type: Date, default: Date.now},
  updatedAt: {type: Date, default: Date.now},
});

const assignKitsToLine = mongoose.model(
  "assignKitsToLine",
  assignKitsToLineSchema
);

module.exports = assignKitsToLine;
