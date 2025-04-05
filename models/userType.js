const mongoose = require("mongoose");

const userTypeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const UserType = mongoose.model("UserType", userTypeSchema, "userTypes");
module.exports = UserType;
