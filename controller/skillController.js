const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const SkillModel = require("../models/skillManagement");
module.exports = {
  create: async (req, res) => {
    try {
      const { skillFieldId, ...data } = req?.body;
      let savedSkillField;

      if (skillFieldId) {
        savedSkillField = await SkillModel.findOneAndUpdate(
          { _id: skillFieldId },
          data,
          {
            new: true,
            upsert: true,
            runValidators: true,
          }
        );
      } else {
        const newSkillField = new SkillModel(data);
        savedSkillField = await newSkillField.save();
      }
      return res.status(201).json({
        status: 200,
        message: skillFieldId
          ? "Skill Field Updated Successfully!!"
          : "Skill Field Created Successfully!!",
        savedSkillField,
      });
    } catch (error) {
      console.error("Error creating Skill:", error);
      return res.status(500).json({
        status: 500,
        message: "An error occurred while creating the Skill.",
        error: error.message,
      });
    }
  },
  getSkills: async (req, res) => {
    try {
      let skills = await SkillModel.find();
      return res.status(200).json({
        status: 200,
        message: "Skill Fetched successfully!",
        skills,
      });
    } catch (error) {
      console.error("Error Fetching Skills", error);
      return res.status(500).json({
        status: 500,
        message: "An error occurred while Fetching the Skills.",
        error: error.message,
      });
    }
  },
  delete: async (req, res) => {
    try {
      let id = req.params.id;
      let skill = await SkillModel.findByIdAndDelete(id);
      if (!skill) {
        return res.status(404).json({ message: "Skill not Found" });
      }
      res.status(200).json({
        message: "Skill Deleted Successfully!!",
        skill,
      });
    } catch (error) {
      console.error("Error deleting skill:", error);
      res.status(500).json({
        message: "An error occurred while Deleting the Skill!!",
        error: error.message,
      });
    }
  },
  deleteMultiple: async (req, res) => {
    try {
      const ids = req.body.deleteIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          message: "Invalid request, ids must be an array of strings",
        });
      }
      const result = await SkillModel.deleteMany({
        _id: { $in: ids },
      });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No skills found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} Skill(s) deleted successfully`,
      });
    } catch (error) {
      console.error("Error deleting multiple skills:", error);
      res.status(500).json({
        message: "An error occurred while Deleting the Skills!!",
        error: error.message,
      });
    }
  },
};
