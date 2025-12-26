const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const ShiftModel = require("../models/shiftManagement");
module.exports = {
  create: async (req, res) => {
    try {
      const { name, intervals, weekDays,descripition } = req.body;
      if (!name || !weekDays) {
        return res.status(400).json({
          status: 400,
          message: "All fields are required: name, weekDays.",
        });
      }
      const data = {
        name,
        intervals,
        weekDays,
        descripition
      };
      const newShiftModel = new ShiftModel(data);
      await newShiftModel.save();
      return res.status(201).json({
        status: 201,
        message: "Shift created successfully!",
        newShiftModel,
      });
    } catch (error) {
      console.error("Error creating shift:", error);
      return res.status(500).json({
        status: 500,
        message: "An error occurred while creating the shift.",
        error: error.message,
      });
    }
  },
  view: async (req, res) => {
    try {
      const Shifts = await ShiftModel.find();
      console.log("Shifts ===:> ", Shifts);
      return res.status(200).json({
        status: 200,
        status_msg: "Shifts Fetched Sucessfully!!",
        Shifts,
      });
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .json({ message: "An error occurred while Creating the Shift!!" });
    }
  },
  delete: async (req, res) => {
    try {
      const Shifts = await ShiftModel.findByIdAndDelete(req.params.id);
      if (!Shifts) {
        return res.status(404).json({ message: "shift not found" });
      }
      res.status(200).json({ message: "Shift Deleted Successfully!!", Shifts });
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: "An error occurred while Deleting the Shift!!" });
    }
  },
  deleteUserRoleMultiple: async (req, res) => {
    try {
      const ids = req.body.deleteIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          message: "Invalid request, ids must be an array of strings",
        });
      }
      const objectIds = ids.map((id) => {
        if (mongoose.Types.ObjectId.isValid(id)) {
          return new mongoose.Types.ObjectId(id);
        } else {
          throw new Error(`Invalid ObjectId: ${id}`);
        }
      });

      const result = await ShiftModel.deleteMany({ _id: { $in: objectIds } });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} Shift(s) deleted successfully`,
      });
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .json({ message: "An error occurred while Deleting the Shifts!!" });
    }
  },
  getShiftByID: async (req, res) => {
    try {
      const id = req.params.id;
      const shift = await ShiftModel.findById(id).lean();
      if (!shift) {
        return res.status(404).json({ error: "Room Plan not found" });
      }
      return res.status(200).json(shift);
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .json({ message: "An error occurred while Fetching the Shift!!" });
    }
  },
  updateshift: async (req, res) => {
    try {
      const id = req.params.id;
      if (!mongoose.isValidObjectId(id)) { 
        return res
          .status(400)
          .json({ status: 400, message: "Invalid ID format" });
      }
      const updatedData = {
        name: req?.body?.name,
        startTime:req?.body?.startTime,
        endTime:req?.body?.endTime,
        descripition:req?.body?.descripition,
        totalBreakTime:req?.body?.totalBreakTime,
        intervals: req?.body?.intervals,
        weekDays: req?.body?.weekDays,
      };
      const updatedShift = await ShiftModel.findByIdAndUpdate(id, updatedData, {
        new: true,
        runValidators: true,
      });
      if (!updatedShift) {
        return res.status(404).json({ message: "Room Plan not found" });
      }
      return res.status(200).json({
        status: 200,
        message: "Room Plan updated successfully",
        shift: updatedShift,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
