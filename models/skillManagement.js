const mongoose = require("mongoose");

const SkillManagementSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const SkillManagement = mongoose.model(
  "Skill",
  SkillManagementSchema
);

module.exports = SkillManagement;
