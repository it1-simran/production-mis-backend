const mongoose = require("mongoose");
const moment = require("moment");
const momentTz = require("moment-timezone");
const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
const ProcessLogsModel = require("../models/ProcessLogs");
const RoomPlanModel = require("../models/roomPlan");
const assignedOperatorsToPlanModel = require("../models/assignOperatorToPlan");
const ShiftModel = require("../models/shiftManagement");
const InventoryModel = require("../models/inventoryManagement");
const ProcessModel = require("../models/Process");
module.exports = {
  create: async (req, res) => {
    try {
      const formatDateForMongoose = (dateString) => {
        const [day, month, yearAndTime] = dateString.split("/");
        const [year, time] = yearAndTime.split(" ");
        const [hours, minutes, seconds] = time.split(":");
        return new Date(`20${year}`, month - 1, day, hours, minutes, seconds);
      };
      const data = req?.body;
      const planingId = req?.body?.selectedProcess;
      data.ProcessShiftMappings = JSON.parse(data?.ProcessShiftMappings);
      data.startDate = formatDateForMongoose(data?.startDate);
      data.estimatedEndDate = formatDateForMongoose(data?.estimatedEndDate);
      const newPlanAndScheduling = new PlaningAndSchedulingModel(data);
      await newPlanAndScheduling.save();
      const processUpdater = await ProcessModel.findByIdAndUpdate(
        planingId,
        {
          $set: {
            status: req?.body?.status,
          },
        },
        { new: true }
      );
      const assignOperator = JSON.parse(data?.assignedOperators);
      let seatsDetails = {};
      if (assignOperator.length > 0) {
        const keys = Object.keys(assignOperator);
        const roomAndSeatNumber = keys[0].split("-");
        seatsDetails = {
          rowNumber: roomAndSeatNumber[0],
          seatNumber: roomAndSeatNumber[1],
        };
        const data1 = {
          planId: newPlanAndScheduling?._id,
          userId: assignOperator[keys[0]][0]?._id,
          roomName: data?.selectedRoom,
          kitIssued: data?.issuedKits,
          cartonIssued: data?.issuedCarton,
          seatDetails: seatsDetails,
          ProcessShiftMappings: data?.ProcessShiftMappings,
          startDate: data?.startDate,
          estimatedEndDate: data?.estimatedEndDate,
        };
        const assignOperators = new assignedOperatorsToPlanModel(data1);
        await assignOperators.save();
      }
      return res.status(200).json({
        status: 200,
        message: "Planing And Scheduling Created Successfully!!",
        newPlanAndScheduling,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  update: async (req, res) => {
    try {
      const formatDateForMongoose = (dateString) => {
        const [day, month, yearAndTime] = dateString.split("/");
        const [year, time] = yearAndTime.split(" ");
        const [hours, minutes, seconds] = time.split(":");

        return new Date(`20${year}`, month - 1, day, hours, minutes, seconds);
      };
      const id = req.params.id;
      const updatedData = req.body;
      updatedData.ProcessShiftMappings = JSON.parse(
        updatedData.ProcessShiftMappings
      );
      updatedData.startDate = formatDateForMongoose(updatedData.startDate);
      updatedData.estimatedEndDate = formatDateForMongoose(
        updatedData.estimatedEndDate
      );
      const updatedPlaningAndScheduling =
        await PlaningAndSchedulingModel.findByIdAndUpdate(id, updatedData, {
          new: true,
          runValidators: true,
        });

      if (!updatedPlaningAndScheduling) {
        return res
          .status(404)
          .json({ message: "Planing and Scheduling not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "Planing and Scheduling Updated Successfully!!",
        shift: updatedPlaningAndScheduling,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  view: async (req, res) => {
    try {
      let plans = await PlaningAndSchedulingModel.aggregate([
        {
          $lookup: {
            from: "processes",
            localField: "selectedProcess",
            foreignField: "_id",
            as: "planingData",
          },
        },
        { $unwind: "$planingData" },
        {
          $project: {
            _id: 1,
            processName: 1,
            selectedProcess: 1,
            selectedRoom: 1,
            selectedShift: 1,
            issuedKits: 1,
            issuedCarton: 1,
            ProcessShiftMappings: 1,
            repeatCount: 1,
            startDate: 1,
            assignedJigs: 1,
            assignedOperators: 1,
            assignedStages: 1,
            isDrafted: 1,
            totalUPHA: 1,
            totalTimeEstimation: 1,
            status: "$planingData.status",
            estimatedEndDate: 1,
            consumedKit: 1,
            downTime: 1,
            processName: "$planingData.name",
            isActiveProcess: {
              $and: [
                { $eq: [{ $toLower: "$planingData.status" }, "active"] },
                { $lte: ["$startDate", "$$NOW"] }
              ]
            },
          },
        },
      ]);
      return res.status(200).json({
        status: 200,
        message: "Planning and scheduling fetched successfully!",
        plans,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  checkAvailability: async (req, res) => {
    try {
      const { roomId, shiftId, startDate, expectedEndDate, shiftDataChange } =
        req.body;
      let changedData = JSON.parse(shiftDataChange);
      if (!roomId || !shiftId || !startDate || !expectedEndDate) {
        return res.status(400).json({
          error:
            "Room ID, Shift ID, Start Date, and Expected End Date are required.",
        });
      }
      const parsedStartDate = moment.utc(startDate, "DD/MM/YY HH:mm:ss", true);
      const parsedEndDate = moment.utc(
        expectedEndDate,
        "DD/MM/YY HH:mm:ss",
        true
      );
      if (!parsedStartDate.isValid() || !parsedEndDate.isValid()) {
        return res.status(400).json({
          status: 400,
          error: "Invalid date format. Expected format: DD/MM/YY HH:mm:ss.",
        });
      }
      if (parsedStartDate.isAfter(parsedEndDate)) {
        return res.status(400).json({
          status: 400,
          error: "Start Date must be earlier than Expected End Date.",
        });
      }
      const shift = await ShiftModel.findById(shiftId);
      if (!shift) {
        return res.status(404).json({
          status: 404,
          error: "Shift not found.",
        });
      }
      let shiftStartTime, shiftEndTime;
      shiftStartTime = moment(changedData.startTime, "HH:mm");
      shiftEndTime = moment(changedData.endTime, "HH:mm");
      const query = [
        {
          $match: {
            selectedRoom: new mongoose.Types.ObjectId(roomId),
            isDrafted: 0,
            $or: [
              {
                startDate: {
                  $gte: new Date(parsedStartDate),
                  $lte: new Date(parsedEndDate),
                },
              },
              {
                estimatedEndDate: {
                  $gte: new Date(parsedStartDate),
                  $lte: new Date(parsedEndDate),
                },
              },
              {
                $and: [
                  { startDate: { $lte: new Date(parsedStartDate) } },
                  { estimatedEndDate: { $gte: new Date(parsedEndDate) } },
                ],
              },
            ],
          },
        },
        {
          $lookup: {
            from: "processes",
            localField: "selectedProcess",
            foreignField: "_id",
            as: "processDetails",
          },
        },
        {
          $unwind: {
            path: "$processDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $match: {
            "processDetails.status": {
              $nin: ["completed", "waiting_schedule"],
            },
          },
        },
      ];
      const plans = await PlaningAndSchedulingModel.aggregate(query);
      const filteredPlans = plans.filter((plan) => {
        const { startTime, endTime } = plan.ProcessShiftMappings || {};
        if (!startTime || !endTime) return false;
        const planStartTime = moment(startTime, "HH:mm");
        const planEndTime = moment(endTime, "HH:mm");
        return (
          shiftStartTime.isSameOrBefore(planEndTime.startOf("minute")) &&
          shiftEndTime.isSameOrAfter(planStartTime.startOf("minute"))
        );
      });
      console.log("filteredPlans ==>", filteredPlans);
      if (filteredPlans.length === 0) {
        return res.status(404).json({
          status: 404,
          error:
            "No available seats for the given room, shift, and date range.",
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Available seats fetched successfully!",
        plans: filteredPlans,
      });
    } catch (error) {
      console.error("Error in checkAvailability: ", error.message);
      return res.status(500).json({
        status: 500,
        error: "Internal server error.",
        details: error.message,
      });
    }
  },
  checkAvailabilityFromCurrentDate: async (req, res) => {
    try {
      const { roomId, shiftId } = req.body;

      if (!roomId || !shiftId) {
        return res.status(400).json({
          status: 400,
          error: "Room ID and Shift ID are required.",
        });
      }

      const currentDate = moment.utc().startOf("day");
      const endDate = moment.utc().add(30, "days").endOf("day");

      // ✅ Check if room exists
      const roomPlan = await RoomPlanModel.findById(roomId).lean();
      if (!roomPlan) {
        return res.status(404).json({
          status: 404,
          error: "Room not found.",
        });
      }

      const totalSeatsInRoom =
        roomPlan.lines?.reduce(
          (totalSeats, line) => totalSeats + (line.seats?.length || 0),
          0
        ) || 0;

      // ✅ Fetch plans
      const plans = await PlaningAndSchedulingModel.find({
        selectedRoom: new mongoose.Types.ObjectId(roomId),
        selectedShift: new mongoose.Types.ObjectId(shiftId),
        isDrafted: 0,
      }).lean();

      if (!plans || plans.length === 0) {
        // ✅ Return empty seat availability
        return res.status(200).json({
          status: 200,
          message: "No planning data available.",
          seatAvailability: {},
        });
      }

      // ✅ Build seat availability
      const seatAvailability = {};
      for (const plan of plans) {
        const planStartDate = moment(plan.startDate).startOf("day");
        const planEndDate = moment(plan.estimatedEndDate).endOf("day");

        let currentDateInRange = planStartDate.clone();
        while (currentDateInRange.isSameOrBefore(planEndDate)) {
          const dateString = currentDateInRange.format("YYYY-MM-DD");

          if (!seatAvailability[dateString]) {
            seatAvailability[dateString] = totalSeatsInRoom;
          }

          let assignedStages = 0;
          try {
            const parsedStages = JSON.parse(plan?.assignedStages || "{}");
            assignedStages = Object.keys(parsedStages).length;
          } catch (err) {
            console.warn(
              "Invalid JSON in assignedStages:",
              plan.assignedStages
            );
          }

          seatAvailability[dateString] -= assignedStages;
          currentDateInRange.add(1, "days");
        }
      }

      return res.status(200).json({
        status: 200,
        message: "Planning and scheduling fetched successfully!",
        seatAvailability,
      });
    } catch (error) {
      console.error(
        "Error in checkAvailabilityFromCurrentDate:",
        error.message
      );
      return res.status(500).json({
        status: 500,
        error: "Internal server error.",
        details: error.message,
      });
    }
  },

  // checkAvailabilityFromCurrentDate: async (req, res) => {
  //   try {
  //     const { roomId, shiftId } = req.body;
  //     if (!roomId || !shiftId) {
  //       return res.status(400).json({
  //         status: 400,
  //         error: "Room ID and Shift ID are required.",
  //       });
  //     }
  //     const currentDate = moment.utc().startOf("day");
  //     const startISO = currentDate.toISOString();
  //     const endDate = moment.utc().add(30, "days").toISOString();
  //     const roomPlan = await RoomPlanModel.findById(roomId);
  //     if (!roomPlan) {
  //       return res.status(404).json({
  //         status: 404,
  //         error: "Room not found.",
  //       });
  //     }
  //     const totalSeatsInRoom = roomPlan.lines.reduce(
  //       (totalSeats, line) => totalSeats + line.seats.length,
  //       0
  //     );
  //     const plans = await PlaningAndSchedulingModel.find({
  //       selectedRoom: new mongoose.Types.ObjectId(roomId),
  //       selectedShift: new mongoose.Types.ObjectId(shiftId),
  //       isDrafted: 0,
  //     });
  //     const seatAvailability = {};
  //     plans.forEach((plan) => {
  //       const planStartDate = moment(plan.startDate).startOf("day");
  //       const planEndDate = moment(plan.estimatedEndDate).endOf("day");
  //       let currentDateInRange = planStartDate.clone();
  //       while (currentDateInRange.isSameOrBefore(planEndDate)) {
  //         const dateString = currentDateInRange.toISOString().split("T")[0];
  //         if (!seatAvailability[dateString]) {
  //           seatAvailability[dateString] = totalSeatsInRoom;
  //         }
  //         const assignedStages = Object.keys(
  //           JSON.parse(plan?.assignedStages || "{}")
  //         ).length;
  //         seatAvailability[dateString] -= assignedStages;
  //         currentDateInRange.add(1, "days");
  //       }
  //     });
  //     const dates = Object.keys(seatAvailability);
  //     console.log("seatAvailability ==>", seatAvailability);
  //     return res.status(200).json({
  //       status: 200,
  //       message: "Planning and scheduling fetched successfully!",
  //       seatAvailability,
  //     });
  //   } catch (error) {
  //     console.error(
  //       "Error in checkAvailabilityFromCurrentDate: ",
  //       error.message
  //     );
  //     return res.status(500).json({
  //       status: 500,
  //       error: "Internal server error.",
  //       details: error.message,
  //     });
  //   }
  // },
  delete: async (req, res) => {
    try {
      const planId = req.params.id;
      const planingAndScheduling =
        await PlaningAndSchedulingModel.findByIdAndDelete(planId);
      await ProcessLogsModel.deleteMany({ planId });
      if (!planingAndScheduling) {
        return res
          .status(404)
          .json({ message: "Planing & Scheduling not found" });
      }
      res.status(200).json({
        message: "Planing & Scheduling deleted successfully",
        planingAndScheduling,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deletePlaningMultiple: async (req, res) => {
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
      const result = await PlaningAndSchedulingModel.deleteMany({
        _id: { $in: objectIds },
      });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} item(s) deleted successfully`,
      });
    } catch (error) {
      if (error.message.startsWith("Invalid ObjectId")) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error deleting multiple items:", error);
      return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
  },
  getPlaningAnDschedulingByID: async (req, res) => {
    try {
      const id = req.params.id;
      // const PlaningAndScheduling = await PlaningAndSchedulingModel.find({_id
      //   :id});
      const PlaningAndScheduling = await PlaningAndSchedulingModel.aggregate([
        {
          $match: { _id: new mongoose.Types.ObjectId(id) },
        },
        {
          $lookup: {
            from: "assignkitstolines",
            localField: "_id",
            foreignField: "planId",
            as: "assignKitsToLinesDetails",
          },
        },
        {
          $unwind: {
            path: "$assignKitsToLinesDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "shifts",
            localField: "selectedShift",
            foreignField: "_id",
            as: "shiftDetails",
          },
        },
        {
          $unwind: { path: "$shiftDetails", preserveNullAndEmptyArrays: true },
        },
        {
          $lookup: {
            from: "processes",
            localField: "selectedProcess",
            foreignField: "_id",
            as: "processDetails",
          },
        },
        {
          $unwind: {
            path: "$processDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        // {
        //   $lookup: {
        //     from: "assignpoperatorsplans",
        //     localField: "selectedProcess",
        //     foreignField: "processId",
        //     as: "assignOperatorToPlans"
        //   }
        // },
        // {
        //   $unwind : {
        //     path : "$assignOperatorToPlans",
        //     preserveNullAndEmptyArrays: true
        //   }
        // },
        {
          $project: {
            _id: 1,
            processName: 1,
            selectedProcess: 1,
            selectedRoom: 1,
            selectedShift: 1,
            issuedKits: 1,
            issuedCarton: 1,
            ProcessShiftMappings: 1,
            repeatCount: 1,
            startDate: 1,
            assignedJigs: 1,
            assignedOperators: 1,
            assignedStages: 1,
            isDrafted: 1,
            totalUPHA: 1,
            totalTimeEstimation: 1,
            status: 1,
            estimatedEndDate: 1,
            consumedKit: 1,
            downTime: 1,
            assignedIssuedKits: "$assignKitsToLinesDetails.issuedKits",
            assignedSeatDetails: "$assignKitsToLinesDetails.seatDetails",
            assignedStatus: "$assignKitsToLinesDetails.status",
            assignedIssuedKitsStatus:
              "$assignKitsToLinesDetails.issuedKitsStatus",
            assignedCustomStages: 1,
            assignedCustomStagesOp: 1,
            startTime: "$shiftDetails.startTime",
            processStatus: "$processDetails.status",
            processQuantity: "$processDetails.quantity",
            endTime: "$shiftDetails.endTime",
            totalBreakTime: "$shiftDetails.totalBreakTime",
            //stageType: "$assignOperatorToPlans.stageType"
            isActiveProcess: {
              $and: [
                { $eq: [{ $toLower: "$processDetails.status" }, "active"] },
                { $lte: ["$startDate", "$$NOW"] }
              ]
            }
          },
        },
      ]);
      console.log("PlaningAndScheduling ===>", PlaningAndScheduling);
      if (!PlaningAndScheduling) {
        return res.status(404).json({ error: "Product not found" });
      }
      return res.status(200).json(PlaningAndScheduling[0]);
    } catch (error) {
      console.error("Error Fetching Planing And Scheduling :", error);
      return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
  },
  getPlaningAnDschedulingByProcessId: async (req, res) => {
    try {
      const id = req.params.id;
      const PlaningAndScheduling = await PlaningAndSchedulingModel.find({
        selectedProcess: id,
      });
      if (!PlaningAndScheduling) {
        return res.status(404).json({ error: "Product not found" });
      }
      return res.status(200).json(PlaningAndScheduling[0]);
    } catch (error) {
      console.error("Error Fetching Planing And Scheduling :", error);
      return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
  },
  fetchAllPlaningModel: async (req, res) => {
    try {
      const PlaningAndScheduling = await PlaningAndSchedulingModel.find();
      return res.status(200).json({
        status: 200,
        message: "Planing Model Fetched Successfully!!",
        PlaningAndScheduling,
      });
    } catch (error) {
      return res.status(500).json({ staus: 500, error: error.message });
    }
  },
  planingAndSchedulingLogs: async (req, res) => {
    try {
      const data = req?.body;
      const processLogs = new ProcessLogsModel(data);
      await processLogs.save();
      return res.status(200).json({
        status: 200,
        message: "Process Logs Created Successfully!!",
        processLogs,
      });
    } catch (error) {
      return res.status(500).json({ staus: 500, error: error.message });
    }
  },
  getProcessLogsByProcessId: async (req, res) => {
    try {
      const id = req.params.id;
      const processLogs = await ProcessLogsModel.aggregate([
        {
          $match: {
            processId: new mongoose.Types.ObjectId(id),
          },
        },
        {
          $lookup: {
            from: "processes",
            localField: "processId",
            foreignField: "_id",
            as: "planingData",
          },
        },
        { $unwind: "$planingData" },
        {
          $project: {
            _id: 1,
            action: 1,
            processId: 1,
            userId: 1,
            description: 1,
            timestamp: 1,
            processtName: "$planingData.name",
          },
        },
      ]);
      if (!processLogs) {
        return res.status(404).json({ error: "Product not found" });
      }
      return res.status(200).json(processLogs);
    } catch (error) {
      return res.status(500).json({ staus: 500, error: error.message });
    }
  },
  updateDownTime: async (req, res) => {
    try {
      const id = req.params.id;
      const selectedProcess = req.body.selectedProcess;
      const downTime = req.body.downTime;
      console.log("Received ID:", id);
      console.log("Selected Process:", selectedProcess);
      console.log("DownTime:", downTime);

      const processData = {
        status: "down_time_hold",
      };
      const planingData = {
        downTime: JSON.parse(downTime),
      };
      const planing = await PlaningAndSchedulingModel.findByIdAndUpdate(
        id,
        planingData,
        {
          new: true,
          runValidators: true,
        }
      );
      const process = await ProcessModel.findByIdAndUpdate(
        selectedProcess,
        processData,
        {
          new: true,
          runValidators: true,
        }
      );
      if (!process) {
        return res.status(404).json({
          status: 404,
          message: "Process not found with given ID.",
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Planning and Process updated successfully.",
        process,
      });
    } catch (error) {
      console.error("Error in updateDownTime:", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateProcessStatus: async (req, res) => {
    try {
      const id = req.params.id;
      const selectedProcess = req.body.selectedProcess;
      const processData = {
        status: req.body.status,
      };
      const planingData = {
        downTime: {},
      };
      const planing = await PlaningAndSchedulingModel.findByIdAndUpdate(
        id,
        planingData,
        {
          new: true,
          runValidators: true,
        }
      );
      const process = await ProcessModel.findByIdAndUpdate(
        selectedProcess,
        processData,
        {
          new: true,
          runValidators: true,
        }
      );
      if (!process) {
        return res.status(404).json({
          status: 404,
          message: "Process not found with given ID.",
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Planning and Process updated successfully.",
        process,
      });
    } catch (error) {
      console.error("Error in updateProcessStatus:", error);
    }
  },
  getPlaningAndSchedulingDateWise: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;

      let filterStartDate, filterEndDate;

      if (startDate && endDate) {
        const parsedStart = moment.tz(startDate, "YYYY-MM-DD", "Asia/Kolkata");
        const parsedEnd = moment.tz(endDate, "YYYY-MM-DD", "Asia/Kolkata");

        if (!parsedStart.isValid() || !parsedEnd.isValid()) {
          return res.status(400).json({
            status: 400,
            error: "Invalid date format. Use YYYY-MM-DD.",
          });
        }

        filterStartDate = parsedStart.startOf("day").toDate();
        filterEndDate = parsedEnd.endOf("day").toDate();
      } else {
        const today = moment.tz("Asia/Kolkata");
        filterStartDate = today.clone().startOf("isoWeek").toDate();
        filterEndDate = today.clone().endOf("isoWeek").toDate();
      }

      const response = await PlaningAndSchedulingModel.aggregate([
        {
          $match: {
            startDate: {
              $gte: filterStartDate,
              $lte: filterEndDate,
            },
          },
        },
        {
          $lookup: {
            from: "processes",
            localField: "selectedProcess",
            foreignField: "_id",
            as: "processDetails",
          },
        },
        {
          $unwind: "$processDetails",
        },
        {
          $sort: { startDate: 1 },
        },
      ]);

      // compute active flag based on Asia/Kolkata current datetime and process status
      const now = moment.tz("Asia/Kolkata").toDate();
      const plansWithActive = response.map((p) => {
        const start = p.startDate ? new Date(p.startDate) : null;
        const processActive =
          p.processDetails &&
          typeof p.processDetails.status === "string" &&
          p.processDetails.status.toLowerCase() === "active";
        const inRange = start && start <= now;
        return Object.assign({}, p, { isActiveProcess: processActive && inRange });
      });

      return res.status(200).json({
        status: 200,
        message: "Planning and Scheduling data fetched successfully",
        plans: plansWithActive,
      });
    } catch (error) {
      console.error("API Error:", error.message);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  checkTestRecordsDateWise: async (req, res) => {
    try {
    } catch (error) {
      console.error(" Api Error :", error.message);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
