const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  employeeCode: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  gender: {type: String, required:true},
  password: { type: String, required: true },
  dateOfBirth: { type: Date, required: true },
  userType: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  profilePic: { type: String, default: "" },
  coverPic: { type: String, default: "" },
  skills: { type: [String], default: [] },
});

const User = mongoose.model("User", userSchema);
module.exports = User;
