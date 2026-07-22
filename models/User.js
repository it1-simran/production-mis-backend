
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  employeeCode: { type: String, required: true, unique: true },
  gender: { type: String, required: true },
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

// Ensure email is never stored as null/empty — it must be a real value or absent
userSchema.pre('save', function (next) {
  if (!this.email || String(this.email).trim() === '') {
    this.email = undefined;
  }
  if (!this.mobileNo || String(this.mobileNo).trim() === '') {
    this.mobileNo = undefined;
  }
  next();
});

const User = mongoose.model("User", userSchema);
module.exports = User;
