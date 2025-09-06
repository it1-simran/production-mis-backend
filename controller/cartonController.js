const mongoose = require("mongoose");
const cartonModel = require("../models/cartonManagement");
const deviceModel = require("../models/device");
const ProcessModel = require("../models/Process");
// const ProcessModel = require("../models/process");
module.exports = {
  createOrUpdate: async (req, res) => {
    try {
      const { processId, devices, packagingData } = req.body;
      let existingCarton = await cartonModel.findOne({
        processId,
        status: { $in: ["partial", "empty"] },
      });
      if (existingCarton) {
        if (existingCarton.devices.includes(devices[0])) {
          return res.status(400).json({
            status: 400,
            message: "Device already exists in this carton.",
          });
        }
        existingCarton.devices.push(devices[0]);
        if (existingCarton.devices.length >= existingCarton.maxCapacity) {
          existingCarton.status = "full";
        } else {
          existingCarton.status = "partial";
        }
        await existingCarton.save();
        return res.status(200).json({
          status: 200,
          message: "Device added to existing carton",
          carton: existingCarton,
        });
      }

      const newCarton = new cartonModel({
        cartonSerial: `CARTON-${Date.now()}`,
        processId,
        devices,
        packagingData,
        maxCapacity: packagingData.maxCapacity,
        status:
          devices.length >= packagingData.maxCapacity ? "full" : "partial",
      });

      await newCarton.save();

      return res.status(201).json({
        status: 201,
        message: "New carton created",
        carton: newCarton,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "An error occurred while creating/updating carton.",
        error: error.message,
      });
    }
  },
 getCartonByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;

      const cartons = await cartonModel.aggregate([
        {
          $match: {
            processId: new mongoose.Types.ObjectId(processId),
            status: "full",
            cartonStatus: "PDI",
          },
        },
        {
          $lookup: {
            from: "devices",
            localField: "devices",
            foreignField: "_id",
            as: "devices",
          },
        },
        { $unwind: { path: "$devices", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "devicetestrecords",
            localField: "devices._id",
            foreignField: "deviceId",
            as: "deviceTestRecords",
          },
        },

        // ✅ Merge testRecords into devices
        {
          $addFields: {
            "devices.testRecords": "$deviceTestRecords",
          },
        },

        // 🌀 Group back to carton level
        {
          $group: {
            _id: "$_id",
            cartonSize: { $first: "$cartonSize" },
            cartonSerial: { $first: "$cartonSerial" },
            processId: { $first: "$processId" },
            maxCapacity: { $first: "$maxCapacity" },
            status: { $first: "$status" },
            weightCarton: { $first: "$weightCarton" },
            createdAt: { $first: "$createdAt" },
            updatedAt: { $first: "$updatedAt" },
            __v: { $first: "$__v" },
            cartonStatus: { $first: "$cartonStatus" },
            devices: { $push: "$devices" },
          },
        },
      ]);

      if (!cartons || cartons.length === 0) {
        return res.status(404).json({ message: "No Carton Found" });
      }

      // 📦 Separate arrays
      const cartonSerials = cartons.map((c) => c.cartonSerial);

      return res.json({
        cartonSerials,
        cartonDetails: cartons,
      });
    } catch (error) {
      console.error("Error fetching carton:", error);
      res.status(500).json({ error: "Server error: " + error.message });
    }
  },
  // getCartonByProcessId: async (req, res) => {
  //   try {
  //     const { processId } = req.params;
  //     // const carton = await cartonModel
  //     //   .find({
  //     //     processId,
  //     //     status: { $in: ["full"] },
  //     //     cartonStatus: { $in: ["PDI"] },
  //     //   })
  //     //   .populate({
  //     //     path: "devices",
  //     //     populate: {
  //     //       path: "testRecords", // virtual field in Device schema
  //     //       model: "deviceTest",
  //     //     },
  //     //   });
  //     const carton = await cartonModel.aggregate([
  //       {
  //         $match: {
  //           processId: new mongoose.Types.ObjectId(processId),
  //           status: { $in: ["full"] },
  //           cartonStatus: { $in: ["PDI"] },
  //         },
  //       },
  //       {
  //         $lookup: {
  //           from: "devices", // exact name of your devices collection (check in MongoDB)
  //           localField: "devices",
  //           foreignField: "_id",
  //           as: "devices",
  //         },
  //       },
  //       {
  //         $unwind: "$devices",
  //       },
  //       {
  //         $lookup: {
  //           from: "devicetestrecords", // exact name of the test record collection
  //           localField: "devices._id",
  //           foreignField: "deviceId",
  //           as: "devices.testRecords", // this won't nest, but we'll fix that later
  //         },
  //       },
  //       {
  //         $group: {
  //           _id: "$_id",
  //           cartonSize: { $first: "$cartonSize" },
  //           cartonSerial: { $first: "$cartonSerial" },
  //           processId: { $first: "$processId" },
  //           maxCapacity: { $first: "$maxCapacity" },
  //           status: { $first: "$status" },
  //           weightCarton: { $first: "$weightCarton" },
  //           createdAt: { $first: "$createdAt" },
  //           updatedAt: { $first: "$updatedAt" },
  //           __v: { $first: "$__v" },
  //           cartonStatus: { $first: "$cartonStatus" },
  //           devices: {
  //             $push: {
  //               $mergeObjects: [
  //                 "$devices",
  //                 { testRecords: "$devices.testRecords" },
  //               ],
  //             },
  //           },
  //         },
  //       },
  //     ]);

  //     if (!carton) {
  //       return res.status(404).json({ message: "No Carton Found" });
  //     }
  //     res.json(carton);
  //   } catch (error) {
  //     console.error("Error fetching carton:", error);
  //     res.status(500).json({ error: "Server error" + error.message });
  //   }
  // },
  getPartialCarton: async (req, res) => {
    try {
      const { processId } = req.params;
      const carton = await cartonModel
        .findOne({
          processId: processId,
          status: { $in: ["empty", "partial"] },
          cartonStatus: { $in: [""] },
        })
        .populate("devices");
      if (!carton) {
        return res.status(404).json({ message: "No open carton found." });
      }

      res.status(200).json(carton);
    } catch (error) {
      console.error("Error fetching carton:", error);
      res.status(500).json({ error: "Server error" });
    }
  },

  shiftToNextCommonStage: async (req, res) => {
    try {
      const { selectedCarton } = req.body;

      if (!selectedCarton) {
        return res
          .status(400)
          .json({ success: false, message: "Carton serial is required" });
      }

      // 1. Find and update the carton
      const carton = await cartonModel.findOneAndUpdate(
        { cartonSerial: selectedCarton },
        { $set: { cartonStatus: "FG_TO_STORE" } },
        { new: true }
      );

      if (!carton) {
        return res
          .status(404)
          .json({ success: false, message: "Carton not found" });
      }
      // 2. Update all devices in this carton's devices array
      const devicesUpdate = await deviceModel.updateMany(
        { _id: { $in: carton.devices } }, // use the devices array
        {
          $set: {
            currentStage: "FG_TO_STORE",
          },
        } // update their status
      );

      return res.status(200).json({
        success: true,
        carton,
        updatedDevices: devicesUpdate.modifiedCount,
        message: `Carton and ${devicesUpdate.modifiedCount} devices shifted to FG_TO_STORE successfully`,
      });
    } catch (error) {
      console.error("Error updating carton/devices:", error);
      res.status(500).json({ error: "Server error" });
    }
  },

  shiftToPDI: async (req, res) => {
    try {
      const { cartons } = req.body;

      if (!cartons || cartons.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "No cartons provided" });
      }

      // Update all cartons whose serials match
      const result = await cartonModel.updateMany(
        { cartonSerial: { $in: cartons } }, // filter
        { $set: { cartonStatus: "PDI" } } // update
      );

      return res.status(200).json({
        success: true,
        shifted: result.modifiedCount,
        message: "Cartons shifted to PDI successfully",
      });
    } catch (error) {
      console.error("Error in shiftToPDI:", error);
      return res
        .status(500)
        .json({ success: false, error: "Failed to shift cartons" });
    }
  },
  fetchCurrentRunningProcessFG: async (req, res) => {
    try {
      // Step 1: Get processes with status active/complete
      const processes = await ProcessModel
        .find({
          status: { $in: ["active", "complete"] },
        })
        .lean();

      // Step 2: Get cartons for each process
      const processData = await Promise.all(
        processes.map(async (process) => {
          const cartons = await cartonModel.find({
            processId: process._id,
            cartonStatus: "FG_TO_STORE",
          }).lean();

          // Step 3: Fetch devices for each carton
          const cartonsWithDevices = await Promise.all(
            cartons.map(async (carton) => {
              const devices = await deviceModel
                .find({
                  _id: { $in: carton.devices },
                })
                .lean();

              return {
                ...carton,
                devices, // devices + their testRecords
              };
            })
          );

          return {
            ...process,
            cartons: cartonsWithDevices,
          };
        })
      );

      return res.status(200).json({
        success: true,
        data: processData,
      });
    } catch (error) {
      console.error(
        "Error fetching processes with FG_TO_STORE cartons:",
        error
      );
      res.status(500).json({ success: false, error: "Server error" });
    }
  },

  // fetchCurrentRunningProcessFG : async (req, res) => {

  // }
};
