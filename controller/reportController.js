const mongoose = require("mongoose");
const reportedIssueModel = require("../models/reportIssueModel");

module.exports = {
  create: async (req, res) => {
    try {
      const data = req.body;
      if (!data) {
        return res.status(400).json({
          status: 400,
          message: "Invalid data provided",
        });
      }
      
      const reportedIssue = new reportedIssueModel(data);
      const savedReportedIssue = await reportedIssue.save();
      return res.status(200).json({
        status: 200,
        message: "Reported Issue Created Successfully!",
        data: savedReportedIssue,
      });
    } catch (error) {
      console.error("Error creating reported issue:", error.message);
      return res.status(500).json({ 
        status: 500, 
        message: "An error occurred while creating the reported issue.", 
        error: error.message 
      });
    }
  },  
};
