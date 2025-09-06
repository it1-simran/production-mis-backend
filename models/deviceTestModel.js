const mongoose = require("mongoose");

const deviceTestSchema = new mongoose.Schema({
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "device" },
  processId: {type:mongoose.Schema.Types.ObjectId, ref:"processes"},
  operatorId: {type:mongoose.Schema.Types.ObjectId, ref:"users"},
  serialNo: { type: String, required: false },
  seatNumber:{type:String,required:false},
  stageName: { type: String, required: false },
  status: { type: String, required: false },
  timeConsumed: { type: String, required: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const deviceTest = mongoose.model("deviceTestRecords", deviceTestSchema);

module.exports = deviceTest;
