const holidayModel = require("../models/holidayModel");
const mongoose = require("mongoose");
module.exports = {
  view: async (req, res) => {
    try {
      const holidays = await holidayModel.find();
      return res.status(200).json({
        status: 200,
        message: "Holidays Fetched Successfully!!",
        holidays,
      });
    } catch (error) {
      return res.status(500).json({ staus: 500, error: error.message });
    }
  },
  create: async (req, res) => {
    try {
      const { holidayId, ...data } = req.body;
      const updatedHoliday = await holidayModel.findOneAndUpdate(
        { _id: holidayId || new mongoose.Types.ObjectId() }, // Generate ID for creation if not present
        data,
        {
          new: true,
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        }
      );
      const message = holidayId
        ? "Holiday updated successfully!"
        : "Holiday created successfully!";
      return res.status(200).json({
        status: 200,
        message,
        holiday: updatedHoliday,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
    // try {
    //   const { holidayId, ...data } = req?.body;
    //   const updatedHoliday = await holidayModel.findOneAndUpdate(
    //     { _id: holidayId },
    //     data,
    //     {
    //       new: true,
    //       upsert: true,
    //       runValidators: true,
    //     }
    //   );
    //   return res.status(200).json({
    //     status: 200,
    //     message: holidayId
    //       ? "Holiday Updated Successfully!!"
    //       : "Holiday Created Successfully!!",
    //     holiday: updatedHoliday,
    //   });
    // } catch (error) {
    //   return res.status(500).json({ staus: 500, error: error.message });
    // }
  },
  delete: async (req, res) => {
    try {
      const Holiday = await holidayModel.findByIdAndDelete(req.params.id);
      if (!Holiday) {
        return res.status(404).json({ message: "Holiday not found" });
      }
      res
        .status(200)
        .json({ message: "Holiday Deleted Successfully!!", Holiday });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deleteHolidayMultiple: async (req, res) => {
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

      const result = await holidayModel.deleteMany({ _id: { $in: objectIds } });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} Holiday(s) deleted successfully`,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};

