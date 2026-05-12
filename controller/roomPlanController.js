const mongoose = require("mongoose");
const RoomPlanModel = require("../models/roomPlan");

module.exports = {
  create: async (req, res) => {
    try {
      const floorName = req.body.floorName;
      if (!req.body.lines) {
        return res.status(400).json({ status: 400, message: "Lines data is required" });
      }
      let lines;
      try { lines = typeof req.body.lines === "string" ? JSON.parse(req.body.lines) : req.body.lines; } catch { return res.status(400).json({ status: 400, message: "Invalid lines JSON" }); }
      const newRoomPlan = new RoomPlanModel({ floorName, lines });
      await newRoomPlan.save();

      return res
        .status(200)
        .json({
          status: 200,
          message: "Room Plan Created Succesfully",
          newRoomPlan,
        });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  view: async (req, res) => {
    try {
      const RoomPlan = await RoomPlanModel.find().sort({ _id: -1 });
      return res.status(200).json({
        status: 200,
        status_msg: "Room Plans Fetched Successfully!!",
        RoomPlan,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deleteRoomPlan: async (req,res)=>{
    try{
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid room plan ID" });
      }
      const roomPlan = await RoomPlanModel.findByIdAndDelete(req.params.id);
      if (!roomPlan) {
        return res.status(404).json({ message: "Room Plan not found" });
      }
      res.status(200).json({ message: "Room Plan deleted successfully", roomPlan });
    } catch(error) {
       return res.status(500).json({status:500,error:error.message});
    }
  },
  deleteMultipleRoomPlan: async (req,res) =>{
    try{
      const ids = req.body.deleteIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'Invalid request, ids must be an array of strings' });
      }
      const objectIds = ids.map(id => {
        if (mongoose.Types.ObjectId.isValid(id)) {
          return new mongoose.Types.ObjectId(id);
        } else {
          throw new Error(`Invalid ObjectId: ${id}`);
        }
      });

      const result = await RoomPlanModel.deleteMany({ _id: { $in: objectIds } });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: 'No items found to delete' });
      }
      return res.status(200).json({ message: `${result.deletedCount} item(s) deleted successfully` });
    } catch(error) {
      return res.status(500).json({status:500,error:error.message});
    }
  },
  getRoomPlanByID: async (req,res) =>{
    try{
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid room plan ID" });
      }
      const roomPlan = await RoomPlanModel.findById(id);
      if (!roomPlan) {
        return res.status(404).json({ error: "Room Plan not found" });
      }
      return res.status(200).json(roomPlan);
    } catch(error) {
      return res.status(500).json({status:500,error:error.message});
    }
  },
  update: async (req,res) =>{
    try{
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid room plan ID" });
      }
      if (!req.body.lines) {
        return res.status(400).json({ status: 400, message: "Lines data is required" });
      }
      let parsedLines;
      try { parsedLines = typeof req.body.lines === "string" ? JSON.parse(req.body.lines) : req.body.lines; } catch { return res.status(400).json({ status: 400, message: "Invalid lines JSON" }); }
      const updatedData = {floorName:req.body.floorName,lines:parsedLines};
  
      const updatedRoomPlan = await RoomPlanModel.findByIdAndUpdate(id, updatedData, { 
        new: true,
        runValidators: true,
      });
  
      if (!updatedRoomPlan) {
        return res.status(404).json({ message: 'Room Plan not found' });
      }

      return res.status(200).json({
        status: 200,
        message: 'Room Plan updated successfully',
        roomPlan: updatedRoomPlan,
      });
    } catch(error) {
      return res.status(500).json({status:500,error:error.message});
    }
  }
};
