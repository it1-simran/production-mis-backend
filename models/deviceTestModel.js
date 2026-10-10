const mongoose = require("mongoose");
const { decompressDocLogs } = require("../utils/stepLogCompression");

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
        // True when logData above is a gzip Buffer rather than the raw
        // object - see utils/stepLogCompression.js. Absent/false on records
        // saved before compression existed, so old data still reads as plain
        // objects untouched.
        logDataCompressed: { type: Boolean, required: false, default: false },
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
  // Stage-routing snapshot captured at Pass time so planInsightsService can
  // credit the passed device as WIP at its NEXT stage. Without these fields
  // declared here, Mongoose's strict mode silently drops them on save and
  // the device disappears from WIP counts until it's actually tested again.
  nextLogicalStage: { type: String, required: false, default: "" },
  assignedSeatKey: { type: String, required: false, default: "" },
  assignedStageInstanceId: { type: String, required: false, default: "" },
  assignedParallelGroupKey: { type: String, required: false, default: "" },
  // Free-form operator-provided description captured at NG time.
  ngDescription: { type: String, required: false, default: "" },
  // Captured failure reason (e.g. from jig validation)
  reason: { type: String, required: false },
  // Top-level snapshot of log data for quick access in reports
  logData: { type: mongoose.Schema.Types.Mixed, required: false },
  flowVersion: { type: Number, required: false, default: 1 },
  flowBoundary: { type: Boolean, required: false, default: false },
  flowType: { type: String, required: false, default: "stage" },
  previousFlowVersion: { type: Number, required: false, default: null },
  flowStartedAt: { type: Date, required: false, default: null },
  timeConsumed: { type: String, required: false },
  totalBreakTime: { type: String, required: false },
  startTime: { type: Date, required: false },
  endTime: { type: Date, required: false },
  testDurationMs: { type: Number, required: false },
  attemptNumber: { type: Number, required: false, default: 1 },
  reattemptReason: { type: String, required: false, default: "" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Performance indexes for common query patterns
deviceTestSchema.index({ operatorId: 1, createdAt: -1 });
deviceTestSchema.index({ deviceId: 1, createdAt: -1 });
deviceTestSchema.index({ deviceId: 1, flowVersion: 1, createdAt: -1 });
deviceTestSchema.index({ planId: 1, operatorId: 1 });
deviceTestSchema.index({ planId: 1, createdAt: -1 });
deviceTestSchema.index({ planId: 1, processId: 1, createdAt: -1 });
deviceTestSchema.index({ planId: 1, processId: 1, stageName: 1, createdAt: -1 });
deviceTestSchema.index({ processId: 1, createdAt: -1 });
deviceTestSchema.index({ productId: 1, createdAt: -1 });
deviceTestSchema.index({ serialNo: 1 });
deviceTestSchema.index({ serialNo: 1, planId: 1, processId: 1, createdAt: -1 });
deviceTestSchema.index({ status: 1, createdAt: -1 });
deviceTestSchema.index({ status: 1, processId: 1, createdAt: -1 });
deviceTestSchema.index({ status: 1, serialNo: 1, createdAt: -1 });
deviceTestSchema.index({ createdAt: -1 });

// Transparently restores gzip-compressed logs[].logData for every consumer -
// including .lean() queries, since these are query-level hooks, not document
// getters. This is what lets storage compress step logs without any read-path
// call site needing to know about it. See utils/stepLogCompression.js.
deviceTestSchema.post(["find"], function (docs) {
  if (Array.isArray(docs)) docs.forEach(decompressDocLogs);
});
deviceTestSchema.post(["findOne", "findOneAndUpdate"], function (doc) {
  decompressDocLogs(doc);
});

const deviceTest = mongoose.model("deviceTestRecords", deviceTestSchema);

module.exports = deviceTest;


