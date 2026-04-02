const mongoose = require("mongoose");

const assignOperatorToPlanSchema = new mongoose.Schema({
  processId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "processes",
    required: true,
  },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
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
  stageType: { type: String, required: false },
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

assignOperatorToPlanSchema.index({ userId: 1, processId: 1 });
assignOperatorToPlanSchema.index({ userId: 1, status: 1 });
assignOperatorToPlanSchema.index({ processId: 1, status: 1 });

const assignOperatorToPlan = mongoose.model(
  "assignpOperatorsPlan",
  assignOperatorToPlanSchema
);

module.exports = assignOperatorToPlan;


