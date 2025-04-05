const mongoose = require("mongoose");

const assignJigToPlanSchema = new mongoose.Schema({
  processId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "processes",
    required: true,
  },
  jigId: { type: mongoose.Schema.Types.ObjectId, ref: "Jig", required: true },
  roomName: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "roomplans",
    required: true,
  },
  seatDetails: {
    type: {
      rowNumber: { type: String, required: false },
      seatNumber: { type: String, required: false },
    },
    default: {},
  },
  ProcessShiftMappings: {
    type: {
      formattedShiftDate: {type: String, required: false, default: null},
      startTime: {type: String, required: false, default: null},
      endTime: {type: String, required: false, default: null},
    },
    default: {},
  },
  startDate: {type: Date, required: true},
  estimatedEndDate: {type: Date, required: false},
  status:{type: String, enum: ["Occupied","Free"],required: false},
  createdAt: {type: Date, default: Date.now},
  updatedAt: {type: Date, default: Date.now},
});

const assignJigToPlan = mongoose.model(
  "assignJigPlan",
  assignJigToPlanSchema
);

module.exports = assignJigToPlan;
