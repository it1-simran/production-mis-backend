const mongoose = require("mongoose");
const { Schema } = mongoose;

const ProcessLogSchema = new Schema({
  action: {
    type: String,
    required: true,
    enum: ["CREATE","UPDATE","PLANING_CREATED","PROCESS_EXTENDED","PLANING_UPDATED","SHIFT_CHANGE","HOLD","ASSIGN","ASSIGN_JIG","PROCESS_COMPLETED"],
  },
  processId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "processes",
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  description: {
    type: String,
    default: "",
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("processLog", ProcessLogSchema);