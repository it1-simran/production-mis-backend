const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  employeeCode: { type: String, required: true, unique: true },
  email: { type: String, unique: true, sparse: true },
  mobileNo: { type: String, unique: true, sparse: true },
  gender: {type: String, required:true},
  password: { type: String, required: true },
  dateOfBirth: { type: Date, required: true },
  userType: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  profilePic: { type: String, default: "" },
  coverPic: { type: String, default: "" },
  skills: { type: [String], default: [] },
  department: { type: String, default: "" },
  status: { type: String, enum: ['Active', 'Inactive', 'Discarded'], default: 'Active' },
  deboardedAt: { type: Date, default: null },
  deboardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deboardReason: { type: String, default: "" }
});

const User = mongoose.model("User", userSchema);
module.exports = User;
