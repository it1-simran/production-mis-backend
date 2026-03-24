const mongoose = require("mongoose");
const processLogModel = require("../models/ProcessLogs");
const cartonModel = require("../models/cartonManagement");
const deviceModel = require("../models/device");
const ProcessModel = require("../models/process");
const productModel = require("../models/Products");
const deviceTestModel = require("../models/deviceTestModel");
const inventoryModel = require("../models/inventoryManagement");
const planingModel = require("../models/planingAndSchedulingModel");
// const ProcessModel = require("../models/process");

const normalizeObjectIdList = (values = []) =>
  values
    .map((value) => {
      if (!value) return null;
      if (value instanceof mongoose.Types.ObjectId) return value;
      if (mongoose.Types.ObjectId.isValid(String(value))) {
        return new mongoose.Types.ObjectId(String(value));
      }
      return null;
    })
    .filter(Boolean);

const findCartonConflicts = async (deviceIds = [], excludeCartonIds = []) => {
  const normalizedDeviceIds = normalizeObjectIdList(deviceIds);
  if (normalizedDeviceIds.length === 0) return null;

  const normalizedExcludeIds = normalizeObjectIdList(excludeCartonIds);
  return cartonModel.findOne({
    _id: { $nin: normalizedExcludeIds },
    devices: { $in: normalizedDeviceIds },
  });
};

module.exports = {
  createOrUpdate: async (req, res) => {
    try {
      const { processId, devices, packagingData } = req.body;
      const deviceIds = Array.isArray(devices) ? devices : [];
      if (deviceIds.length === 0) {
        return res.status(400).json({
          status: 400,
          message: "At least one device is required.",
        });
      }

      let existingCarton = await cartonModel.findOne({
        processId,
        status: { $in: ["partial", "empty"] },
      });
      if (existingCarton) {
        const existingDeviceSet = new Set(
          Array.isArray(existingCarton.devices)
            ? existingCarton.devices.map((deviceId) => String(deviceId))
            : [],
        );
        const alreadyInThisCarton = deviceIds.some((deviceId) =>
          existingDeviceSet.has(String(deviceId)),
        );
        if (alreadyInThisCarton) {
          return res.status(400).json({
            status: 400,
            message: "Device already exists in this carton.",
          });
        }

        const conflict = await findCartonConflicts(deviceIds, [existingCarton._id]);
        if (conflict) {
          return res.status(409).json({
            status: 409,
            message: `Device already assigned to carton ${conflict.cartonSerial}.`,
          });
        }

        existingCarton.devices.push(...deviceIds);
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

      const conflict = await findCartonConflicts(deviceIds);
      if (conflict) {
        return res.status(409).json({
          status: 409,
          message: `Device already assigned to carton ${conflict.cartonSerial}.`,
        });
      }

      const newCarton = new cartonModel({
        cartonSerial: `CARTON-${Date.now()}`,
        processId,
        devices: deviceIds,
        packagingData,
        cartonSize: {
          width: packagingData?.cartonWidth ? String(packagingData.cartonWidth) : "",
          height: packagingData?.cartonHeight ? String(packagingData.cartonHeight) : "",
          depth: packagingData?.cartonDepth ? String(packagingData.cartonDepth) : "",
        },
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
  verifySticker: async (req, res) => {
    try {
      const { cartonSerial } = req.body;
      if (!cartonSerial) {
        return res.status(400).json({ status: 400, message: "Carton serial is required." });
      }


      const carton = await cartonModel.findOne({ cartonSerial });
      if (carton) {
        await processLogModel.create({
          action: "PRINT_STICKER",
          processId: carton.processId,
          userId: req.user.id,
          description: `Sticker printed for carton ${cartonSerial}`
        });
      }
      const updatedCarton = await cartonModel.findOneAndUpdate(
        { cartonSerial },
        { isStickerVerified: true },
        { new: true }
      );

      if (!updatedCarton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      return res.status(200).json({ status: 200, message: "Sticker verified successfully.", carton: updatedCarton });
    } catch (error) {
      return res.status(500).json({ status: 500, message: "Error verifying sticker.", error: error.message });
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
            cartonStatus: "",
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
            isStickerVerified: { $first: "$isStickerVerified" },
            isLooseCarton: { $first: "$isLooseCarton" },
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
  getCartonsIntoStore: async (req, res) => {
    try {
      const { processId } = req.params;

      const cartons = await cartonModel.aggregate([
        {
          $match: {
            processId: new mongoose.Types.ObjectId(processId),
            status: "full",
            cartonStatus: "FG_TO_STORE",
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
        {
          $addFields: {
            "devices.testRecords": "$deviceTestRecords",
          },
        },
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
            isLooseCarton: { $first: "$isLooseCarton" },
            devices: { $push: "$devices" },
          },
        },
      ]);
      if (!cartons || cartons.length === 0) {
        return res.status(404).json({ message: "No Carton Found" });
      }
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
  getCartonByProcessIdToPDI: async (req, res) => {
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
        {
          $addFields: {
            "devices.testRecords": "$deviceTestRecords",
          },
        },
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
            isLooseCarton: { $first: "$isLooseCarton" },
            devices: { $push: "$devices" },
          },
        },
      ]);
      if (!cartons || cartons.length === 0) {
        return res.status(404).json({ message: "No Carton Found" });
      }
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
          status: "partial",
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
  getOpenCartonsByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;
      const cartons = await cartonModel
        .find({
          processId: processId,
          status: "partial",
          cartonStatus: { $in: [""] },
        })
        .populate("devices")
        .lean();

      if (!cartons || cartons.length === 0) {
        return res.status(404).json({ message: "No open cartons found." });
      }

      return res.status(200).json(cartons);
    } catch (error) {
      console.error("Error fetching open cartons:", error);
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
      const devicesUpdate = await deviceModel.updateMany(
        { _id: { $in: carton.devices } },
        {
          $set: {
            currentStage: "FG_TO_STORE",
          },
        }
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

  verifySticker: async (req, res) => {
    try {
      const { cartonSerial } = req.body;
      if (!cartonSerial) {
        return res
          .status(400)
          .json({ status: 400, message: "Carton serial is required." });
      }

      const updatedCarton = await cartonModel.findOneAndUpdate(
        { cartonSerial },
        { isStickerVerified: true },
        { new: true }
      );

      if (!updatedCarton) {
        return res
          .status(404)
          .json({ status: 404, message: "Carton not found." });
      }

      return res.status(200).json({
        status: 200,
        message: "Carton verified successfully.",
        carton: updatedCarton,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Error verifying carton.",
        error: error.message,
      });
    }
  },
  shiftToPDI: async (req, res) => {
    try {
      const { cartons } = req.body;

      if (!cartons || (Array.isArray(cartons) && cartons.length === 0)) {
        return res
          .status(400)
          .json({ success: false, message: "No cartons provided" });
      }

      // Convert to array if it's a single string (from FormData)
      const cartonArray = Array.isArray(cartons) ? cartons : [cartons];

      // Verification check: ensure all cartons are verified
      const unverifiedCartons = await cartonModel.find({
        cartonSerial: { $in: cartonArray },
        isStickerVerified: { $ne: true },
      });

      if (unverifiedCartons.length > 0) {
        const unverifiedSerials = unverifiedCartons.map((c) => c.cartonSerial);
        return res.status(400).json({
          success: false,
          message:
            "Some cartons are not verified. Please verify all cartons before shifting to PDI.",
          unverifiedCartons: unverifiedSerials,
        });
      }

      // Update all cartons whose serials match

      const firstCarton = await cartonModel.findOne({ cartonSerial: { $in: cartonArray } });
      if (firstCarton) {
        await processLogModel.create({
          action: "SHIFT_CARTON",
          processId: firstCarton.processId,
          userId: req.user.id,
          description: `Shifted ${cartonArray.length} cartons to PDI: ${cartonArray.join(", ")}`
        });
      }
      const result = await cartonModel.updateMany(
        { cartonSerial: { $in: cartonArray } }, // filter
        { $set: { cartonStatus: "PDI" } } // update
      );

      // Also update devices in those cartons
      const affectedCartons = await cartonModel.find({
        cartonSerial: { $in: cartonArray },
      });
      const allDeviceIds = affectedCartons.reduce(
        (acc, curr) => acc.concat(curr.devices),
        []
      );

      await deviceModel.updateMany(
        { _id: { $in: allDeviceIds } },
        { $set: { currentStage: "PDI" } }
      );

      return res.status(200).json({
        success: true,
        shifted: result.modifiedCount,
        message: "Cartons and devices shifted to PDI successfully",
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
      const processes = await ProcessModel.find({
        status: { $in: ["active", "complete"] },
      }).lean();

      // Step 2: Get cartons for each process
      const processData = await Promise.all(
        processes.map(async (process) => {
          const cartons = await cartonModel
            .find({
              processId: process._id,
              cartonStatus: "FG_TO_STORE",
            })
            .lean();

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

  keepInStore: async (req, res) => {
    try {
      const { processId } = req.params;
      const {
        selectedCarton,
        operatorId,
        planId,
        status,
        stageName,
        logs,
        timeConsumed,
      } = req.body;

      if (!selectedCarton) {
        return res
          .status(400)
          .json({ success: false, message: "Carton serial is required" });
      }

      // 1. Fetch the carton by carton serial no
      const carton = await cartonModel.findOne({ cartonSerial: selectedCarton });
      if (!carton) {
        return res
          .status(404)
          .json({ success: false, message: "Carton not found" });
      }

      // 2. Fetch all devices in that carton
      const devices = await deviceModel.find({ _id: { $in: carton.devices } });
      if (!devices || devices.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "No devices found in this carton" });
      }

      const deviceCount = devices.length;

      // 3. Create device test entries for each device in the carton
      const testEntries = devices.map((device) => ({
        deviceId: device._id,
        processId,
        operatorId,
        serialNo: device.serialNo,
        stageName: stageName || "FG to Store",
        status: status || "Pass",
        logs: logs || [],
        timeConsumed: timeConsumed || "0",
      }));
      await deviceTestModel.insertMany(testEntries);

      // 4. Update the count for the consumed kits into the process
      const process = await ProcessModel.findById(processId);
      if (process) {
        process.consumedKits = (process.consumedKits || 0) + deviceCount;
        process.fgToStore = (process.fgToStore || 0) + deviceCount;
        await process.save();
      }

      // 5. Update the count for the consumed kits into the planning if planId is provided
      if (planId) {
        const planing = await planingModel.findById(planId);
        if (planing) {
          planing.consumedKit = (planing.consumedKit || 0) + deviceCount;
          await planing.save();
        }
      }

      // 6. Update the inventory of the store
      if (process && process.selectedProduct) {
        const inventory = await inventoryModel.findOne({
          productType: process.selectedProduct,
        });
        if (inventory) {
          inventory.quantity = (inventory.quantity || 0) + deviceCount;
          inventory.status = "In Stock";
          await inventory.save();
        }
      }

      // 7. Update all devices' current stage
      await deviceModel.updateMany(
        { _id: { $in: carton.devices } },
        { $set: { currentStage: "KEEP_IN_STORE" } }
      );

      // 8. Update carton status to STOCKED
      carton.cartonStatus = "STOCKED";
      await carton.save();

      return res.status(200).json({
        success: true,
        message: `${deviceCount} devices from carton ${selectedCarton} kept in store successfully`,
        devicesProcessed: deviceCount,
      });
    } catch (error) {
      console.error("Error in keepInStore:", error);
      res
        .status(500)
        .json({ success: false, error: "Server error: " + error.message });
    }
  },

  getFullCartons: async (req, res) => {
    try {
      const cartons = await cartonModel.find({
        status: "full",
        cartonStatus: ""
      }).populate({
        path: 'processId',
        select: 'name processID'
      });

      return res.status(200).json({
        success: true,
        data: cartons
      });
    } catch (error) {
      console.error("Error fetching full cartons:", error);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  },

  updatePrinting: async (req, res) => {
    try {
      const { cartonSerial } = req.body;
      if (!cartonSerial) {
        return res.status(400).json({ status: 400, message: "Carton serial is required." });
      }

      const updatedCarton = await cartonModel.findOneAndUpdate(
        { cartonSerial },
        { isStickerPrinted: true },
        { new: true }
      );

      if (!updatedCarton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      return res.status(200).json({
        status: 200,
        message: "Carton print status updated successfully.",
        carton: updatedCarton,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Error updating print status.",
        error: error.message,
      });
    }
  },

  updateWeight: async (req, res) => {
    try {
      const { cartonSerial, weight } = req.body;
      if (!cartonSerial || weight === undefined) {
        return res.status(400).json({ status: 400, message: "Carton serial and weight are required." });
      }

      const carton = await cartonModel.findOne({ cartonSerial });
      if (!carton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      const cartonStatus = String(carton.status || "").trim().toLowerCase();
      if (cartonStatus !== "full") {
        return res.status(400).json({
          status: 400,
          message: "Carton weight can only be verified for full cartons.",
        });
      }

      const recordedWeight = Number(weight);
      if (!Number.isFinite(recordedWeight) || recordedWeight <= 0) {
        return res.status(400).json({
          status: 400,
          message: "Carton weight must be a valid positive number.",
        });
      }

      const processDoc = await ProcessModel.findById(carton.processId).lean();
      const productId = processDoc?.selectedProduct || processDoc?.productType || processDoc?.productId || null;
      let productDoc = null;
      if (productId && mongoose.Types.ObjectId.isValid(String(productId))) {
        productDoc = await productModel.findById(productId).lean();
      }

      const expectedWeight = Number(
        carton?.packagingData?.cartonWeight ??
        processDoc?.packagingData?.cartonWeight ??
        productDoc?.packagingData?.cartonWeight ??
        0,
      );

      if (!Number.isFinite(expectedWeight) || expectedWeight <= 0) {
        return res.status(400).json({
          status: 400,
          message: "No carton weight specification found for this carton.",
        });
      }

      const toleranceKg = 0.5;
      const variance = Math.abs(recordedWeight - expectedWeight);
      if (variance > toleranceKg) {
        return res.status(400).json({
          status: 400,
          message: `Weight mismatch! Expected ${expectedWeight} KG, got ${recordedWeight} KG.`,
        });
      }

      const updatedCarton = await cartonModel.findOneAndUpdate(
        { cartonSerial },
        { weightCarton: recordedWeight },
        { new: true }
      );

      if (!updatedCarton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      return res.status(200).json({
        status: 200,
        message: "Carton weight updated successfully.",
        carton: updatedCarton,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Error updating carton weight.",
        error: error.message,
      });
    }
  },

  getStorePortalCartons: async (req, res) => {
    try {
      const cartons = await cartonModel.aggregate([
        {
          // Normalize "store status" across older/newer records:
          // - Prefer cartonStatus when present, otherwise fallback to status
          // - Compare case-insensitively
          $addFields: {
            storeStatus: {
              $toUpper: {
                $ifNull: [
                  {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$cartonStatus", null] },
                          { $ne: ["$cartonStatus", ""] },
                        ],
                      },
                      "$cartonStatus",
                      "$status",
                    ],
                  },
                  "",
                ],
              },
            },
          },
        },
        {
          $match: {
            storeStatus: { $in: ["FG_TO_STORE", "STOCKED", "KEPT_IN_STORE"] },
          },
        },
        {
          $lookup: {
            from: "processes",
            localField: "processId",
            foreignField: "_id",
            as: "processInfo",
          },
        },
        // Don't drop cartons if the process document is missing/mismatched.
        { $unwind: { path: "$processInfo", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "devices",
            localField: "devices",
            foreignField: "_id",
            as: "deviceDetails",
          },
        },
        {
          $project: {
            processId: 1,
            cartonSerial: 1,
            processName: { $ifNull: ["$processInfo.name", "Unknown Process"] },
            processID: { $ifNull: ["$processInfo.processID", ""] },
            // Provide a single normalized status field for UI.
            status: "$storeStatus",
            createdAt: 1,
            updatedAt: 1,
            maxCapacity: 1,
            deviceCount: { $size: "$devices" },
            devices: "$deviceDetails",
          },
        },
        { $sort: { createdAt: -1 } }
      ]);

      return res.status(200).json({
        success: true,
        data: cartons,
      });
    } catch (error) {
      console.error("Error in getStorePortalCartons:", error);
      res.status(500).json({ success: false, error: "Server error: " + error.message });
    }
  },

  closeLooseCarton: async (req, res) => {
    try {
      const {
        cartonSerial,
        action = "existing",
        quantity,
        packagingData = {},
        cartonWidth,
        cartonHeight,
        cartonDepth,
        cartonWeight,
      } = req.body;

      if (!cartonSerial) {
        return res.status(400).json({ status: 400, message: "Carton serial is required." });
      }

      const carton = await cartonModel.findOne({ cartonSerial });

      if (!carton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      const currentStatus = String(carton.status || "").toLowerCase();
      if (currentStatus !== "partial") {
        return res.status(400).json({
          status: 400,
          message: "Only partial cartons can be closed as loose cartons.",
        });
      }

      if (carton.cartonStatus && String(carton.cartonStatus).trim() !== "") {
        return res.status(400).json({
          status: 400,
          message: "This carton has already been processed.",
        });
      }

      const sourceDevices = Array.isArray(carton.devices) ? carton.devices.filter(Boolean) : [];
      const sourceQuantity = sourceDevices.length;

      if (sourceQuantity === 0) {
        return res.status(400).json({
          status: 400,
          message: "Partial carton has no devices to process.",
        });
      }

      if (action === "assign-new") {
        const resolvedQty = Number(quantity);
        const resolvedWidth = Number(packagingData?.cartonWidth ?? cartonWidth);
        const resolvedHeight = Number(packagingData?.cartonHeight ?? cartonHeight);
        const resolvedDepth = Number(packagingData?.cartonDepth ?? cartonDepth);
        const resolvedWeight = Number(packagingData?.cartonWeight ?? cartonWeight);

        if (!Number.isInteger(resolvedQty) || resolvedQty <= 0) {
          return res.status(400).json({
            status: 400,
            message: "Quantity must be a positive integer.",
          });
        }

        if (resolvedQty > sourceQuantity) {
          return res.status(400).json({
            status: 400,
            message: "Quantity cannot exceed the devices available in the partial carton.",
          });
        }

        if (!resolvedWidth || resolvedWidth <= 0 || !resolvedHeight || resolvedHeight <= 0 || !resolvedDepth || resolvedDepth <= 0) {
          return res.status(400).json({
            status: 400,
            message: "Carton dimensions must be greater than zero.",
          });
        }

        if (!resolvedWeight || resolvedWeight <= 0) {
          return res.status(400).json({
            status: 400,
            message: "Carton weight must be greater than zero.",
          });
        }

        const movedDevices = sourceDevices.slice(0, resolvedQty);
        const remainingDevices = sourceDevices.slice(resolvedQty);
        const conflict = await findCartonConflicts(movedDevices, [carton._id]);
        if (conflict) {
          return res.status(409).json({
            status: 409,
            message: `Device already assigned to carton ${conflict.cartonSerial}.`,
          });
        }
        const newCartonSerial = `CARTON-${Date.now()}`;
        const newCarton = await cartonModel.create({
          cartonSerial: newCartonSerial,
          processId: carton.processId,
          devices: movedDevices,
          packagingData: {
            ...packagingData,
            cartonWidth: resolvedWidth,
            cartonHeight: resolvedHeight,
            cartonDepth: resolvedDepth,
            cartonWeight: resolvedWeight,
            maxCapacity: resolvedQty,
          },
          cartonSize: {
            width: String(resolvedWidth),
            height: String(resolvedHeight),
            depth: String(resolvedDepth),
          },
          maxCapacity: String(resolvedQty),
          status: "full",
          cartonStatus: "",
          weightCarton: String(resolvedWeight),
          isLooseCarton: false,
          looseCartonAction: "assign-new",
          sourceCartonSerial: carton.cartonSerial,
          reassignedQuantity: resolvedQty,
          reassignedCartonSerial: newCartonSerial,
        });

        if (remainingDevices.length === 0) {
          carton.status = "full";
          carton.isLooseCarton = true;
          carton.cartonStatus = "LOOSE_CLOSED";
        } else {
          carton.devices = remainingDevices;
          carton.status = remainingDevices.length >= Number(carton.maxCapacity || remainingDevices.length)
            ? "full"
            : "partial";
          carton.isLooseCarton = false;
          carton.cartonStatus = "";
        }
        carton.looseCartonAction = "assign-new";
        carton.sourceCartonSerial = carton.cartonSerial;
        carton.reassignedCartonSerial = newCarton.cartonSerial;
        carton.reassignedQuantity = resolvedQty;
        carton.looseCartonClosedAt = new Date();
        await carton.save();

        return res.status(200).json({
          status: 200,
          message: "Loose carton reassigned successfully.",
          carton,
          newCarton,
        });
      }

      // Existing carton path remains the same: close the partial carton as loose.
      carton.status = "full";
      carton.isLooseCarton = true;
      carton.cartonStatus = "LOOSE_CLOSED";
      carton.looseCartonAction = "existing";
      carton.sourceCartonSerial = carton.cartonSerial;
      carton.reassignedQuantity = sourceQuantity;
      carton.looseCartonClosedAt = new Date();
      await carton.save();

      return res.status(200).json({
        status: 200,
        message: "Loose carton closed successfully. It is now marked as full.",
        carton,
      });
    } catch (error) {
      console.error("Error in closeLooseCarton:", error);
      return res.status(500).json({
        status: 500,
        message: "Error closing loose carton.",
        error: error.message,
      });
    }
  },
};
