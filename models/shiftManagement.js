const mongoose = require("mongoose");

const ShiftManagementSchema = new mongoose.Schema({
  name: { type: String, required: true },
  startTime: {type: String, required: false},
  endTime: {type: String, required: false},
  totalBreakTime:{type: String, required: false},
  intervals: {
    type: [{
      startTime: {type: String, required: false},
      endTime: {type: String, required: false},
      breakTime: {type: Boolean, required: false},
    }],
    required: false,
  },
  weekDays: {
    type: {
      sun: { type: Boolean, default: false },
      mon: { type: Boolean, default: false },
      tue: { type: Boolean, default: false },
      wed: { type: Boolean, default: false },
      thu: { type: Boolean, default: false },
      fri: { type: Boolean, default: false },
      sat: { type: Boolean, default: false },
    },
    required: true,
  },
  descripition: { type: String, required: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const ShiftManagement = mongoose.model("Shifts", ShiftManagementSchema);

module.exports = ShiftManagement;
