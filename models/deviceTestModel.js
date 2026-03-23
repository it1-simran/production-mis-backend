const mongoose = require("mongoose");

const deviceTestSchema = new mongoose.Schema({
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "devices" },
  processId: { type: mongoose.Schema.Types.ObjectId, ref: "process" },
  operatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  serialNo: { type: String, required: false },
  // How the device was searched/identified at test time
  // e.g. "Through Serial" or "Through Jig Stages"
  searchType: { type: String, required: false, default: "" },
  seatNumber: { type: String, required: false },
  stageName: { type: String, required: false },
  status: { type: String, required: false },
  trcRemarks: { type: [mongoose.Schema.Types.Mixed], required: false, default: [] },
  logs: {
    type: [
      {
        stepName: { type: String, required: false },
        stepType: { type: String, required: false },
        logData: { type: mongoose.Schema.Types.Mixed, required: false },
        status: { type: String, required: false },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    required: false,
    default: []
  },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "products" },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlaningAndScheduling" },
  assignedDeviceTo: { type: String, required: false },
  // Free-form operator-provided description captured at NG time.
  ngDescription: { type: String, required: false, default: "" },
  flowVersion: { type: Number, required: false, default: 1 },
  flowBoundary: { type: Boolean, required: false, default: false },
  flowType: { type: String, required: false, default: "stage" },
  previousFlowVersion: { type: Number, required: false, default: null },
  flowStartedAt: { type: Date, required: false, default: null },
  timeConsumed: { type: String, required: false },
  totalBreakTime: { type: String, required: false },
  startTime: { type: Date, required: false },
  endTime: { type: Date, required: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Performance indexes for common query patterns
deviceTestSchema.index({ operatorId: 1, createdAt: -1 });
deviceTestSchema.index({ deviceId: 1, createdAt: -1 });
deviceTestSchema.index({ deviceId: 1, flowVersion: 1, createdAt: -1 });
deviceTestSchema.index({ planId: 1, operatorId: 1 });
deviceTestSchema.index({ processId: 1, createdAt: -1 });
deviceTestSchema.index({ serialNo: 1 });
deviceTestSchema.index({ createdAt: -1 });

const deviceTest = mongoose.model("deviceTestRecords", deviceTestSchema);

module.exports = deviceTest;
