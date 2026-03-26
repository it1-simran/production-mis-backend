const mongoose = require("mongoose");
const userSchema = require("./User");

const operatorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phoneNumber: { type: String },
  password: { type: String, required: true },
  dateOfBirth: { type: Date },
  userType: { type: String },
  profilePic: { type: String },
  coverPic: { type: String },
  skills: { type: [String] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  employeeCode: { type: String },
  gender: { type: String },
});
const planingAndSchedulingSchema = new mongoose.Schema({
  processName: { type: String, required: false, default: "" },
  selectedProcess: { type: mongoose.Schema.Types.ObjectId, ref: "process" },
  selectedRoom: { type: mongoose.Schema.Types.ObjectId, ref: "roomplans" },
  selectedShift: { type: mongoose.Schema.Types.ObjectId, ref: "shifts" },
  issuedKits: { type: String, required: false, default: "" },
  issuedCarton: { type: String, required: false, default: "" },
  ProcessShiftMappings: {
    type: {
      formattedShiftDate: { type: String, required: false, default: null },
      startTime: { type: String, required: false, default: null },
      endTime: { type: String, required: false, default: null },
    },
    default: {},
  },
  repeatCount: { type: Number, required: true },
  startDate: { type: Date, required: true },
  assignedJigs: { type: String, required: false },
  assignedOperators: { type: String, required: false },
  assignedCustomStages: { type: String, required: false },
  assignedCustomStagesOp: { type: String, required: false },
  assignedStages: { type: String, required: true },
  isDrafted: { type: Number, required: true },
  totalUPHA: { type: String, required: false },
  totalTimeEstimation: { type: String, required: false },
  status: {
    type: String,
    enum: [
      "Waiting_Kits_allocation",
      "Waiting_Kits_approval",
      "active",
      "down_time_hold",
      "completed"
    ],
    default: "Waiting_Kits_allocation"
  },
  estimatedEndDate: { type: Date, required: false },
  consumedKit: { type: Number, default: 0 },
  downTime: {
    from: { type: Date, required: false, default: null },
    to: { type: Date, required: false, default: null },
    downTimeType: { type: String, required: false, default: "" },
    description: { type: String, required: false, trim: true, default: "" },
  },
  overtimeWindows: {
    type: [
      {
        from: { type: Date, required: true },
        to: { type: Date, required: true },
        reason: { type: String, required: false, trim: true, default: "" },
        createdBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: false,
          default: null,
        },
        createdAt: { type: Date, required: false, default: Date.now },
        updatedAt: { type: Date, required: false, default: Date.now },
        active: { type: Boolean, required: false, default: true },
      },
    ],
    default: [],
  },
  overtimeSummary: {
    type: {
      totalMinutes: { type: Number, required: false, default: 0 },
      totalWindows: { type: Number, required: false, default: 0 },
      lastUpdatedAt: { type: Date, required: false, default: null },
    },
    default: {
      totalMinutes: 0,
      totalWindows: 0,
      lastUpdatedAt: null,
    },
  },
});

planingAndSchedulingSchema.index({ selectedProcess: 1, status: 1, startDate: -1 });
planingAndSchedulingSchema.index({ selectedRoom: 1, selectedShift: 1, status: 1 });
planingAndSchedulingSchema.index({ "overtimeWindows.active": 1, startDate: -1 });
 
const PlaningAndSchedulingModel = mongoose.model(
  "PlaningAndScheduling",
  planingAndSchedulingSchema
);

module.exports = PlaningAndSchedulingModel;
