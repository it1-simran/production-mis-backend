const mongoose = require("mongoose");
const moment = require("moment");
const assignedOperatorsToPlanModel = require("../models/assignOperatorToPlan");
const assignedJigToPlanModel = require("../models/assignJigToPlan");
const planningAndSchedulingModel = require("../models/planingAndSchedulingModel");
module.exports = {
  create: async (req, res) => {
    try {
      const data = req?.body;
      const moment = require("moment");
      let seatsDetails = JSON.parse(data?.seatDetails);
      let ProcessShiftMappings = JSON.parse(data?.ProcessShiftMappings);
      let newassignOp;
      const data1 = {
        processId: data.processId,
        userId: data.userId,
        roomName: data.roomName,
        seatDetails: seatsDetails,
        ProcessShiftMappings: ProcessShiftMappings,
        status: data.status,
        startDate: moment(data.startDate, "YY/MM/DD HH:mm:ss").toDate(),
      };
      const checkEntryExist = await assignedOperatorsToPlanModel.findOne({
        processId: data.processId,
        userId: data.userId,
      });
      if (!checkEntryExist) {
        const assignedOperatorsToPlan = new assignedOperatorsToPlanModel(data1);
        newassignOp = await assignedOperatorsToPlan.save();
      } else {
        newassignOp = await assignedOperatorsToPlanModel.findByIdAndUpdate(
          checkEntryExist._id,
          data1,
          { new: true, runValidators: true }
        );
      }
      return res.status(200).json({
        status: 200,
        message: "Operator Assigned Successfully!!",
        newassignOp,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getTaskByUserID: async (req, res) => {
    try {
      const userId = req.params.id;
      const currentDate = moment.utc().startOf("day").toISOString();
      const task = await assignedOperatorsToPlanModel.aggregate([
        {
          $match: { userId: new mongoose.Types.ObjectId(userId) },
        },
        {
          $lookup: {
            from: "planingandschedulings",
            localField: "processId",
            foreignField: "selectedProcess",
            as: "planDetails",
          },
        },
        {
          $unwind: "$planDetails",
        },
        {
          $lookup: {
            from: "processes",
            localField: "processId",
            foreignField: "_id",
            as: "processDetails",
          },
        },
        {
          $unwind: "$processDetails",
        },
        {
          $lookup: {
            from: "assignkitstolines",
            localField: "processId",
            foreignField: "processId",
            as: "assignKitsToLine",
          },
        },
        {
          $unwind: {
            path: "$assignKitsToLine",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "roomplans",
            localField: "roomName",
            foreignField: "_id",
            as: "roomDetails",
          },
        },
        {
          $unwind: "$roomDetails",
        },
        {
          $project: {
            userId: 1,
            planId: "$planDetails._id",
            processId: "$processDetails._id",
            seatDetails: 1,
            ProcessShiftMappings: 1,
            roomName: 1,
            "roomDetails.floorName": 1,
            processName: "$processDetails.name",
            "planDetails.assignedStages": 1,
            "planDetails.startDate": 1,
            "planDetails.estimatedEndDate": 1,
            "planDetails.roomName": 1,
            "planDetails.seatDetails": 1,
            status: "$processDetails.status",
            kitRecievedConfirmationId:"$assignKitsToLine._id",
            kitRecievedSeatDetails:"$assignKitsToLine.seatDetails",
            kitRecievedConfirmationStatus: "$assignKitsToLine.status",
            issuedKitsStatus: "$assignKitsToLine.issuedKitsStatus",
            assignedKitsToOperator:"$assignKitsToLine.issuedKits",
            requiredKits:"$processDetails.issuedKits"
          },
        },
      ]);

      if (!task.length) {
        return res.status(404).json({
          status: 404,
          message: "No tasks found for the given user and date.",
        });
      }
      let filterTask = task;
      return res.status(200).json({
        status: 200,
        message: "Task Retrieved Successfully!!",
        task: filterTask,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  createJigAssignedToPlan: async (req, res) => {
    try {
      const data = req?.body;
      const moment = require("moment");
      let newassignJig;
      let seatsDetails = data?.seatDetails ? JSON.parse(data.seatDetails) : [];
      let ProcessShiftMappings = data?.ProcessShiftMappings
        ? JSON.parse(data.ProcessShiftMappings)
        : [];
      if (!data.processId || !data.jigId || !data.roomName || !data.startDate) {
        return res
          .status(400)
          .json({ status: 400, message: "Missing required fields" });
      }
      const data1 = {
        processId: data.processId,
        jigId: data.jigId,
        roomName: data.roomName,
        seatDetails: seatsDetails,
        ProcessShiftMappings: ProcessShiftMappings,
        status: data.status || "pending",
        startDate: moment(data.startDate, "YY/MM/DD HH:mm:ss").toDate(),
      };
      let jigData = await assignedJigToPlanModel.findOne({ jigId: data.jigId });
      if (jigData && Object.keys(jigData).length > 0) {
        newassignJig = await assignedJigToPlanModel.findByIdAndUpdate(
          jigData._id,
          { status: data.status },
          { new: true, runValidators: true }
        );
      } else {
        const assignedJigToPlan = new assignedJigToPlanModel(data1);
        newassignJig = await assignedJigToPlan.save();
      }

      return res.status(200).json({
        status: 200,
        message: "Jig Created Successfully!!",
        newassignJig,
      });
    } catch (error) {
      console.error("Error:", error.message);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
