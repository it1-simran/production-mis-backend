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
  selectedProcess: { type: mongoose.Schema.Types.ObjectId, ref: "processes" },
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
  assignedCustomStages : { type: String, required: false},
  assignedCustomStagesOp : { type: String, required: false },
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
    downTimeType:{type:String,required:false,default:""},
    description: { type: String, required: false, trim: true, default: "" },
  },
});

const PlaningAndSchedulingModel = mongoose.model(
  "PlaningAndScheduling",
  planingAndSchedulingSchema
);

module.exports = PlaningAndSchedulingModel;
