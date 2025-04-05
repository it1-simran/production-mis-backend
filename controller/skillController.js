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
};
