const mongoose = require("mongoose");

const userTypeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  permissions: {
    type: Map,
    of: {
      create: { type: Boolean, default: false },
      read: { type: Boolean, default: false },
      update: { type: Boolean, default: false },
      delete: { type: Boolean, default: false },
    },
    default: {},
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const UserType = mongoose.model("UserType", userTypeSchema, "userTypes");
module.exports = UserType;
