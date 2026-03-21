const deviceModel = require("../models/device");
const deviceTestModel = require("../models/deviceTestModel");
const processModel = require("../models/process");
const deviceTestRecords = require("../models/deviceTestModel");
const planingAndScheduling = require("../models/planingAndSchedulingModel");
const productModel = require("../models/Products");
const inventoryModel = require("../models/inventoryManagement");
const imeiModel = require("../models/imeiModel");
const NGDevice = require("../models/NGDevice");
const User = require("../models/User");
const mongoose = require("mongoose");
const DeviceAttempt = require("../models/deviceAttempt");

function sanitizeKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeKeys(item));
  }
  if (value && typeof value === "object") {
    const next = {};
    Object.keys(value).forEach((key) => {
      const safeKey = String(key).replace(/\u0000/g, "");
      next[safeKey] = sanitizeKeys(value[key]);
    });
    return next;
  }
  return value;
}

module.exports = {
  create: async (req, res) => {
    try {
      const data = req.body;
      const productType = data.selectedProduct;
      const currentStage = req.body.currentStage;
      const processID = req.body.processId;
      const prefix = req.body.prefix;
      const noOfSerialRequired = req.body.noOfSerialRequired;
      const suffix = req.body.suffix;
      const enableZero = req.body.enableZero;
      const lastSerialNo = req.body.lastSerialNo;
      const noOfZeroRequired = req.body.noOfZeroRequired;
      const startFrom = req.body.startFrom;
      const serials = generateSerials(
        lastSerialNo,
        prefix,
        parseInt(noOfSerialRequired),
        suffix,
        enableZero,
        noOfZeroRequired,
        1,
        1,
        parseInt(startFrom)
      );
      const savedDevices = [];

      for (const value of serials) {
        const device = new deviceModel({
          productType,
          processID,
          serialNo: value,
          currentStage,
        });
        const savedDevice = await device.save();
        savedDevices.push(savedDevice);
      }

      return res.status(200).json({
        status: 200,
        message: "Devices added successfully",
        data: savedDevices,
      });
    } catch (error) {
      console.error("error ==>", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getLastEntryBasedOnPrefixAndSuffix: async (req, res) => {
    try {
      const data = req.query;
      const escapeRegex = (string) => string.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
      const escapedPrefix = escapeRegex(data.prefix || "");
      const escapedSuffix = escapeRegex(data.suffix || "");

      const lastEntry = await deviceModel
        .findOne({
          serialNo: { $regex: `^${escapedPrefix}.*${escapedSuffix}$` },
        })
        .sort({ createdAt: -1 })
        .exec();
      return res.status(200).json({
        status: 200,
        message: "Last Entry Fetched Successfully",
        data: lastEntry,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getDeviceCountByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;
      const count = await deviceModel.countDocuments({ processID: processId });
      return res.status(200).json({
        status: 200,
        message: "Device Count Fetched Successfully",
        count: count,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getNGDevicesByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(processId)) {
        return res.status(400).json({
          status: 400,
          message: "Invalid processId",
        });
      }

      const ngDevices = await deviceTestRecords
        .find({
          processId: new mongoose.Types.ObjectId(processId),
          status: { $regex: /^NG$/i },
        })
        .populate("deviceId")
        .populate("processId")
        .lean();

      return res.status(200).json({
        status: 200,
        message: "NG devices fetched successfully",
        data: ngDevices,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  createIMEI: async (req, res) => {
    try {
      const data = req.body;
      const productType = data.selectedProduct;
      const imeis = JSON.parse(data.imei);
      const savedImeis = [];

      for (const value of imeis.slice(1)) {
        const imei = new imeiModel({
          productType,
          imeiNo: value[0],
          status: "Pending",
        });
        const savedImei = await imei.save();
        savedImeis.push(savedImei);
      }

      return res.status(200).json({
        status: 200,
        message: "IMEI added successfully",
        data: savedImeis,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  viewIMEI: async (req, res) => {
    try {
      const imei = await imeiModel.aggregate([
        {
          $lookup: {
            from: "products", // Collection name in MongoDB
            localField: "productType",
            foreignField: "_id",
            as: "products",
          },
        },
        {
          $unwind: "$products",
        },
        {
          $project: {
            _id: 1,
            imeiNo: 1,
            status: 1,
            productName: "$products.name",
          },
        },
      ]);
      return res.status(200).json({
        status: 200,
        status_msg: "IMEI Fetched Sucessfully!!",
        imei,
      });
    } catch (error) {
      console.error("Error fetching IMEI details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  deleteIMEI: async (req, res) => {
    try {
      const imei = await imeiModel.findByIdAndDelete(req.params.id);
      if (!imei) {
        return res.status(404).json({ message: "Product not found" });
      }
      res.status(200).json({ message: "Product deleted successfully", imei });
    } catch (error) {
      console.error("Error fetching Product details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  deleteMultipleIMEI: async (req, res) => {
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

      const result = await imeiModel.deleteMany({ _id: { $in: objectIds } });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} item(s) deleted successfully`,
      });
    } catch (error) {
      // Error handling
      if (error.message.startsWith("Invalid ObjectId")) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error deleting multiple items:", error);
      return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
  },
  getDeviceByProductId: async (req, res) => {
    try {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          status: 400,
          error: "Invalid Product ID",
        });
      }
      const devices = await deviceModel.find({ productType: id });
      if (devices.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "No devices found for the given Product ID",
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Devices retrieved successfully",
        data: devices,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  createDeviceTestEntry: async (req, res) => {
    try {
      const data = req.body;
      if (data && data.logs) {
        data.logs = sanitizeKeys(data.logs);
      }
      let planing;
      try {
        planing = await planingAndScheduling.findById(data.planId);
        if (!planing) {
          return res.status(404).json({
            status: 404,
            message: "Planing not found",
          });
        }
      } catch (err) {
        return res.status(500).json({
          status: 500,
          message: `Error fetching planing data: ${err.message}`,
        });
      }
      let products;
      try {
        products = await processModel.find({ _id: planing.selectedProcess });
        if (!products) {
          return res.status(404).json({
            status: 404,
            message: "Process not found",
          });
        }
      } catch (err) {
        return res.status(500).json({
          status: 500,
          message: `Error fetching product data: ${err.message}`,
        });
      }
      let assignedStages = {};
      let assignedOperator = {};

      try {
        assignedStages = JSON.parse(planing.assignedStages) || {};
        assignedOperator = JSON.parse(planing.assignedOperators) || {};
      } catch (err) {
        return res.status(500).json({
          status: 500,
          message: "Invalid JSON format in planing data.",
        });
      }
      let assignedCustomStagesOp = [];
      if (planing.assignedCustomStagesOp) {
        try {
          assignedCustomStagesOp = Array.isArray(planing.assignedCustomStagesOp)
            ? planing.assignedCustomStagesOp
            : JSON.parse(planing.assignedCustomStagesOp);
        } catch (err) {
          assignedCustomStagesOp = [];
        }
      }
      let matchingIndices = Object.keys(assignedOperator).filter((key) =>
        assignedOperator[key].some(
          (operator) => operator._id === data.operatorId
        )
      );
      const assignedDeviceTo = (req.body.assignedDeviceTo || "").trim();
      const isQcOrTrc = assignedDeviceTo === "QC" || assignedDeviceTo === "TRC";

      // If assigning directly to QC/TRC and operator isn't in assignedOperators,
      // allow the record to be created without seat-based plan updates.
      if (matchingIndices.length === 0 && isQcOrTrc) {
        try {
          const notes = String(data.ngDescription || data?.logData?.description || "").trim();
          const ngPayload = {
            processId: planing.selectedProcess || data.processId || null,
            userId: data.operatorId || data.userId || null,
            department: assignedDeviceTo,
            serialNo:
              data.serialNo ||
              data.serialNoValue ||
              data.deviceSerial ||
              "",
            ngStage: data.stageName || data.ngStage || "",
            ...(notes ? { notes } : {}),
          };
          if (ngPayload.processId && ngPayload.userId && ngPayload.serialNo) {
            const ngRecord = new NGDevice(ngPayload);
            await ngRecord.save();
          }
        } catch (ngErr) {
          console.error("Error creating NGDevice record:", ngErr);
        }

        const deviceTestRecord = new deviceTestRecords({
          ...data,
          assignedDeviceTo,
        });
        const savedDeviceTestRecord = await deviceTestRecord.save();
        return res.status(200).json({
          status: 200,
          message: "Device Pass Successfully",
          data: savedDeviceTestRecord,
        });
      }
      if (matchingIndices.length > 0) {
        let currentIndex = matchingIndices[0];
        let currentStage = assignedStages[currentIndex][0]?.name;
        let productStages = (products.stages || []).map(
          (stage) => stage.stageName
        );
        let commonStages = (products.commonStages || []).map(
          (stage) => stage.stageName
        );
        const mergedStages = [...productStages, ...commonStages];

        let lastProductStage = productStages[productStages.length - 1];
        let lastStage = mergedStages[mergedStages.length - 1];
        let nextIndex = getNextIndex(assignedStages, currentIndex);
        if (assignedStages[currentIndex]) {
          const seatStages = assignedStages[currentIndex];
          const stageIdx = seatStages.findIndex(s => (s.name || s.stageName) === (data.stageName || currentStage));
          const targetStageIdx = stageIdx !== -1 ? stageIdx : 0;

          if (data.status === "Pass") {
            if (seatStages[targetStageIdx].totalUPHA > 0) {
              seatStages[targetStageIdx].totalUPHA -= 1;
            }
            seatStages[targetStageIdx].passedDevice = (seatStages[targetStageIdx].passedDevice || 0) + 1;

            if (currentStage === lastProductStage) {
              if (commonStages.length > 0) {
                const customStageData = {
                  name: commonStages[0],
                  totalUPHA: 1,
                  passedDevice: 0,
                  ngDevice: 0,
                };
                assignedCustomStagesOp.push(customStageData);
              }
            } else {
              if (
                nextIndex &&
                assignedStages[nextIndex] &&
                assignedStages[nextIndex][0]
              ) {
                assignedStages[nextIndex][0].totalUPHA += 1;
              }
            }
          } else {
            // NG flow: remove one from current stage WIP and mark NG count
            if (seatStages[targetStageIdx].totalUPHA > 0) {
              seatStages[targetStageIdx].totalUPHA -= 1;
            }
            seatStages[targetStageIdx].ngDevice = (seatStages[targetStageIdx].ngDevice || 0) + 1;

            data.assignedDeviceTo = (req.body.assignedDeviceTo || "").trim();
            if (data.assignedDeviceTo === "QC" || data.assignedDeviceTo === "TRC") {
              try {
                const notes = String(data.ngDescription || data?.logData?.description || "").trim();
                const ngPayload = {
                  processId: planing.selectedProcess || data.processId || null,
                  userId: data.operatorId || data.userId || null,
                  department: data.assignedDeviceTo,
                  serialNo:
                    data.serialNo ||
                    data.serialNoValue ||
                    data.deviceSerial ||
                    "",
                  ngStage: currentStage || data.ngStage || "",
                  ...(notes ? { notes } : {}),
                };
                // Only attempt to create when required identifiers are present
                if (
                  ngPayload.processId &&
                  ngPayload.userId &&
                  ngPayload.serialNo
                ) {
                  const ngRecord = new NGDevice(ngPayload);
                  await ngRecord.save();
                } else {
                  console.warn(
                    "NGDevice not created due to missing fields",
                    ngPayload
                  );
                }
              } catch (ngErr) {
                console.error("Error creating NGDevice record:", ngErr);
              }
            } else {
              // Move device back to assigned stage (previous stage selected from UI)
              try {
                const serial =
                  data.serialNo ||
                  data.serialNoValue ||
                  data.deviceSerial ||
                  data.serial ||
                  null;
                const deviceId = data.deviceId || null;
                let deviceToUpdate = null;

                if (deviceId && mongoose.Types.ObjectId.isValid(deviceId)) {
                  deviceToUpdate = await deviceModel.findById(deviceId);
                } else if (serial) {
                  deviceToUpdate = await deviceModel.findOne({
                    serialNo: serial,
                  });
                }

                if (deviceToUpdate) {
                  const targetStageName = data.assignedDeviceTo;
                  if (targetStageName) {
                    deviceToUpdate.currentStage = targetStageName;
                    deviceToUpdate.status = "Rework";
                    await deviceToUpdate.save();

                    // increment WIP count for the target stage seat in plan (if found)
                    const targetKey = Object.keys(assignedStages).find((k) => {
                      const arr = Array.isArray(assignedStages[k])
                        ? assignedStages[k]
                        : [assignedStages[k]];
                      return arr.some(
                        (s) =>
                          String(s?.name || s?.stageName || "").trim() ===
                          targetStageName
                      );
                    });
                    if (targetKey) {
                      const arr = Array.isArray(assignedStages[targetKey])
                        ? assignedStages[targetKey]
                        : [assignedStages[targetKey]];
                      const idx = arr.findIndex(
                        (s) =>
                          String(s?.name || s?.stageName || "").trim() ===
                          targetStageName
                      );
                      if (idx !== -1) {
                        arr[idx].totalUPHA = (arr[idx].totalUPHA || 0) + 1;
                        assignedStages[targetKey] = arr;
                      }
                    } else {
                      console.warn(
                        "Target stage not found in assignedStages for rework",
                        { targetStageName }
                      );
                    }

                    // Reset attempt count when device is moved back to a stage for rework
                    try {
                      const attemptFilter = { deviceId: deviceToUpdate._id };
                      if (data.planId && mongoose.Types.ObjectId.isValid(data.planId)) {
                        attemptFilter.planId = new mongoose.Types.ObjectId(data.planId);
                      }
                      if (data.processId && mongoose.Types.ObjectId.isValid(data.processId)) {
                        attemptFilter.processId = new mongoose.Types.ObjectId(data.processId);
                      }
                      await DeviceAttempt.updateMany(
                        attemptFilter,
                        { $set: { attemptCount: 0, stageAttempts: {}, lastAttemptAt: new Date() } }
                      );
                    } catch (e) {
                      console.warn("Failed to reset attempt count on rework:", e);
                    }
                  }
                } else {
                  console.warn("Device not found to move to previous stage", {
                    deviceId,
                    serial,
                  });
                }
              } catch (mvErr) {
                console.error("Error moving device to previous stage:", mvErr);
              }
            }
          }
        }
        if (currentStage === "FG to Store") {
          planing.consumedKit += 1;
        }
        if (currentStage === lastStage) {
          assignedStages[currentIndex][0].totalUPHA -= 1;
        }
        planing.assignedStages = JSON.stringify(assignedStages);
        planing.assignedCustomStagesOp = JSON.stringify(assignedCustomStagesOp);

        let updatedstages;
        try {
          updatedstages = await planingAndScheduling.findByIdAndUpdate(
            data.planId,
            {
              $set: {
                assignedStages: planing.assignedStages,
                consumedKit: planing.consumedKit,
                assignedCustomStagesOp: planing.assignedCustomStagesOp,
              },
            },
            { new: true, runValidators: true }
          );

          if (!updatedstages) {
            return res.status(500).json({
              status: 500,
              message: "Error updating planing data.",
            });
          }
        } catch (err) {
          return res.status(500).json({
            status: 500,
            message: `Error updating planing data: ${err.message}`,
          });
        }
        const deviceTestRecord = new deviceTestRecords(data);
        let savedDeviceTestRecord;
        try {
          savedDeviceTestRecord = await deviceTestRecord.save();
        } catch (err) {
          return res.status(500).json({
            status: 500,
            message: `Error saving device test record: ${err.message}`,
          });
        }

        return res.status(200).json({
          status: 200,
          message: "Device Pass  successfully",
          data: savedDeviceTestRecord,
        });
      } else {
        return res.status(404).json({
          status: 404,
          message: "Operator not found in assigned operators.",
        });
      }
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  registerDeviceAttempt: async (req, res) => {
    try {
      const { deviceId, serialNo, planId, processId, operatorId, stageName } = req.body || {};

      if (!planId || !processId) {
        return res.status(400).json({
          status: 400,
          message: "planId and processId are required",
        });
      }

      let resolvedDeviceId = deviceId;
      if (!resolvedDeviceId && serialNo) {
        const query = { serialNo: String(serialNo).trim() };
        if (processId) query.processID = processId;
        const device = await deviceModel.findOne(query).lean();
        if (!device?._id) {
          return res.status(404).json({
            status: 404,
            message: "Device not found for provided serialNo",
          });
        }
        resolvedDeviceId = device._id;
      }

      if (!resolvedDeviceId || !mongoose.Types.ObjectId.isValid(resolvedDeviceId)) {
        return res.status(400).json({
          status: 400,
          message: "Valid deviceId or serialNo is required",
        });
      }

      const normalizedStageName = String(stageName || "").trim();
      const stageKey = Buffer.from(
        normalizedStageName.length > 0 ? normalizedStageName : "__default__"
      ).toString("base64url");

      const attempt = await DeviceAttempt.findOneAndUpdate(
        {
          deviceId: new mongoose.Types.ObjectId(resolvedDeviceId),
          planId: new mongoose.Types.ObjectId(planId),
          processId: new mongoose.Types.ObjectId(processId),
        },
        {
          $inc: {
            attemptCount: 1,
            [`stageAttempts.${stageKey}`]: 1,
          },
          $set: { lastAttemptAt: new Date(), stageName: normalizedStageName },
          ...(operatorId ? { $setOnInsert: { operatorId } } : {}),
        },
        { new: true, upsert: true }
      );

      const stageAttempts = attempt?.stageAttempts || {};
      const stageAttemptCount =
        typeof stageAttempts?.get === "function"
          ? stageAttempts.get(stageKey) || 0
          : stageAttempts?.[stageKey] || 0;

      return res.status(200).json({
        status: 200,
        message: "Attempt registered",
        attemptCount: stageAttemptCount,
        totalAttemptCount: attempt?.attemptCount || 0,
        deviceId: attempt?.deviceId,
        stageName: attempt?.stageName || "",
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Error registering device attempt",
        error: error.message,
      });
    }
  },
  getOverallDeviceTestEntry: async (req, res) => {
    try {
      const pageRaw = req.query.page;
      const limitRaw = req.query.limit;
      const shouldPaginate = pageRaw || limitRaw;
      let DeviceTestEntry;
      let meta;
      if (shouldPaginate) {
        const page = Math.max(parseInt(pageRaw) || 1, 1);
        const limit = Math.min(Math.max(parseInt(limitRaw) || 100, 1), 1000);
        const skip = (page - 1) * limit;
        const [entries, total] = await Promise.all([
          deviceTestRecords
            .find({}, null, { sort: { createdAt: -1 } })
            .populate("deviceId")
            .populate("processId")
            .skip(skip)
            .limit(limit)
            .lean(),
          deviceTestRecords.countDocuments(),
        ]);
        DeviceTestEntry = entries;
        meta = { page, limit, total };
      } else {
        DeviceTestEntry = await deviceTestRecords
          .find({}, null, { sort: { createdAt: -1 } })
          .populate("deviceId")
          .populate("processId")
          .lean();
      }
      return res.status(200).json({
        status: 200,
        status_msg: "Device Test Entry Fetched Sucessfully!!",
        DeviceTestEntry,
        ...(meta ? { meta } : {}),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  getDeviceTestEntryByOperatorId: async (req, res) => {
    try {
      const id = req.params.id;
      const { date, startDate, endDate } = req.query;

      let query = { operatorId: id };
      let startOfDay, endOfDay;

      if (date) {
        const targetDate = new Date(date);
        startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
      } else if (startDate && endDate) {
        startOfDay = new Date(startDate);
        startOfDay.setHours(0, 0, 0, 0);
        endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
      } else {
        // Default to current date
        startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
      }

      query.createdAt = {
        $gte: startOfDay,
        $lte: endOfDay,
      };

      const deviceTestRecord = await deviceTestRecords
        .find(query, null, { sort: { createdAt: -1 } })
        .populate("operatorId", "name employeeCode")
        .populate("productId", "name")
        .populate("planId", "processName")
        .lean();

      if (deviceTestRecord.length === 0) {
        return res.status(404).json({
          status: 404,
          message:
            "No device records found for the given Operator ID with the specified filters/date",
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Device records retrieved successfully",
        data: deviceTestRecord,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },

  getDeviceTestHistoryByDeviceId: async (req, res) => {
    try {
      let id = req.params.deviceId;

      let deviceTestHistory = await deviceTestRecords
        .find({ deviceId: id }, null, { sort: { createdAt: -1 } })
        .populate("deviceId")
        .populate("operatorId", "name employeeCode")
        .populate("productId", "name")
        .populate("planId", "processName")
        .lean();



      if (deviceTestHistory.length === 0) {
        return res.status(200).json({
          status: 200,
          message: "No devices record history found for the given Product ID",
          data: [],
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Devices Record retrieved successfully",
        data: deviceTestHistory,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },

  getOverallProcessByOperatorId: async (req, res) => {
    try {
      const { planId, operatorId } = req.params;
      const devices = await deviceTestRecords
        .find({ planId, operatorId })
        .populate("operatorId", "name employeeCode")
        .populate("productId", "name")
        .populate("planId", "processName")
        .lean();

      if (devices.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "No devices found for the given plan and operator.",
        });
      }
      res.status(200).json({
        status: 200,
        message: "Overall process retrieved successfully!",
        data: devices,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "An error occurred while retrieving the process.",
        error: error.message,
      });
    }
  },
  getDeviceTestTrends: async (req, res) => {
    try {
      const interval = (req.query.interval || "day").toLowerCase();
      const days = Math.max(parseInt(req.query.days, 10) || 7, 1);
      const hours = Math.max(parseInt(req.query.hours, 10) || 24, 1);
      const { operatorId, processId } = req.query;

      const match = {};
      if (operatorId && mongoose.Types.ObjectId.isValid(operatorId)) {
        match.operatorId = new mongoose.Types.ObjectId(operatorId);
      }
      if (processId && mongoose.Types.ObjectId.isValid(processId)) {
        match.processId = new mongoose.Types.ObjectId(processId);
      }

      let start;
      let format;
      if (interval === "hour") {
        start = new Date();
        start.setHours(start.getHours() - (hours - 1), 0, 0, 0);
        format = "%Y-%m-%d %H:00";
      } else {
        start = new Date();
        start.setDate(start.getDate() - (days - 1));
        start.setHours(0, 0, 0, 0);
        format = "%Y-%m-%d";
      }
      match.createdAt = { $gte: start };

      const trend = await deviceTestRecords.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              bucket: { $dateToString: { format, date: "$createdAt" } },
              status: { $toUpper: "$status" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.bucket": 1 } },
      ]);

      const buckets = {};
      trend.forEach((row) => {
        const key = row._id.bucket;
        if (!buckets[key]) buckets[key] = { Pass: 0, NG: 0 };
        if (row._id.status === "PASS") buckets[key].Pass = row.count;
        if (row._id.status === "NG") buckets[key].NG = row.count;
      });

      const categories = [];
      const passData = [];
      const ngData = [];
      if (interval === "hour") {
        for (let i = 0; i < hours; i += 1) {
          const d = new Date(start);
          d.setHours(start.getHours() + i, 0, 0, 0);
          const key = d.toISOString().slice(0, 13).replace("T", " ") + ":00";
          categories.push(key);
          passData.push(buckets[key]?.Pass || 0);
          ngData.push(buckets[key]?.NG || 0);
        }
      } else {
        for (let i = 0; i < days; i += 1) {
          const d = new Date(start);
          d.setDate(start.getDate() + i);
          const key = d.toISOString().slice(0, 10);
          categories.push(key);
          passData.push(buckets[key]?.Pass || 0);
          ngData.push(buckets[key]?.NG || 0);
        }
      }

      return res.status(200).json({
        status: 200,
        message: "Device test trends fetched successfully",
        categories,
        series: [
          { name: "Pass", data: passData },
          { name: "NG", data: ngData },
        ],
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getNGReasonDistribution: async (req, res) => {
    try {
      const days = Math.max(parseInt(req.query.days, 10) || 30, 1);
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      start.setHours(0, 0, 0, 0);

      const dist = await NGDevice.aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: "$ngStage", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);

      return res.status(200).json({
        status: 200,
        message: "NG distribution fetched successfully",
        labels: dist.map((d) => d._id || "Unknown"),
        series: dist.map((d) => d.count),
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  searchByJigFields: async (req, res) => {
    try {
      const { jigFields, processId } = req.body;
      if (!jigFields || typeof jigFields !== 'object') {
        return res.status(400).json({ status: 400, message: "Invalid jigFields" });
      }

      // Convert all jigField values to strings for comparison
      const searchCriteria = {};
      for (const [k, v] of Object.entries(jigFields)) {
        if (v !== undefined && v !== null && v !== "") {
          searchCriteria[k] = String(v).trim();
        }
      }

      if (Object.keys(searchCriteria).length === 0) {
        return res.status(400).json({ status: 400, message: "No search values provided" });
      }

      // We fetch all devices for this process and filter in JS
      // This is because searching across all keys in the nested customFields object is difficult in plain MongoDB queries 
      // without knowing the stage names (which are the first-level keys in customFields).
      const devices = await deviceModel.find({ processID: processId });

      const matchingDevices = devices.filter(device => {
        let customFields = device.customFields;

        if (typeof customFields === 'string') {
          try {
            customFields = JSON.parse(customFields);
          } catch (e) {
            customFields = {};
          }
        }

        for (const [key, value] of Object.entries(searchCriteria)) {
          const searchVal = String(value).trim();
          const searchKeyLower = key.toLowerCase();

          if (searchKeyLower.includes("imei") && String(device.imeiNo).trim() === searchVal) return true;
          if (searchKeyLower.includes("serial") && String(device.serialNo).trim() === searchVal) return true;

          if (customFields && typeof customFields === 'object') {
            if (String(customFields[key]).trim() === searchVal) return true;
            for (const cfName in customFields) {
              if (cfName.toLowerCase() === searchKeyLower && String(customFields[cfName]).trim() === searchVal) {
                return true;
              }
            }

            for (const stageName in customFields) {
              const stageData = customFields[stageName];
              if (stageData && typeof stageData === 'object') {
                if (String(stageData[key]).trim() === searchVal) return true;
                for (const fieldName in stageData) {
                  if (fieldName.toLowerCase() === searchKeyLower && String(stageData[fieldName]).trim() === searchVal) {
                    return true;
                  }
                }
              }
            }
          }
        }
        return false;
      });

      if (matchingDevices.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Device not found with these JIG parameters"
        });
      }

      // if (matchingDevices.length > 1) {
      //   return res.status(409).json({
      //     status: 409,
      //     message: "Duplicate entries of device found"
      //   });
      // }

      return res.status(200).json({
        status: 200,
        data: matchingDevices[0]
      });
    } catch (error) {
      console.error("Error in searchByJigFields:", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateStageBySerialNo: async (req, res) => {
    try {
      let serialNo = req.params.serialNo || req.body.serialNo;
      let updates = req.body;
      const device = await deviceModel.findOne({ serialNo: serialNo });
      if (!device) {
        return res.status(404).json({ message: "Device with serial number not found" });
      }

      if (updates.customFields) {
        let incomingCustomFields = updates.customFields;
        if (typeof incomingCustomFields === 'string') {
          try {
            incomingCustomFields = JSON.parse(incomingCustomFields);
          } catch (e) {
            incomingCustomFields = {};
          }
        }

        let currentStageName = updates.currentStage || device.currentStage || "Unknown Stage";
        let existingCustomFields = device.customFields || {};

        if (typeof existingCustomFields !== 'object' || Array.isArray(existingCustomFields)) {
          existingCustomFields = {};
        }

        existingCustomFields[currentStageName] = {
          ...(existingCustomFields[currentStageName] || {}),
          ...incomingCustomFields
        };

        updates.customFields = existingCustomFields;
      }

      const updatedDevice = await deviceModel.findByIdAndUpdate(
        device._id,
        { $set: updates },
        { new: true, runValidators: true }
      );
      if (!updatedDevice) {
        return res.status(404).json({ message: "Device not found" });
      }
      res.status(200).json({
        status: 200,
        message: "Device updated successfully",
        updatedDevice,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  updateStageByDeviceId: async (req, res) => {
    try {
      let deviceId = req.params.deviceId;
      let updates = req.body;
      const device = await deviceModel.findById(deviceId);
      if (!device) {
        return res.status(404).json({ message: "Device not found" });
      }

      if (updates.customFields) {
        let incomingCustomFields = updates.customFields;
        if (typeof incomingCustomFields === 'string') {
          try {
            incomingCustomFields = JSON.parse(incomingCustomFields);
          } catch (e) {
            incomingCustomFields = {};
          }
        }

        let currentStageName = updates.currentStage || device.currentStage || "Unknown Stage";
        let existingCustomFields = device.customFields || {};

        if (typeof existingCustomFields !== 'object' || Array.isArray(existingCustomFields)) {
          existingCustomFields = {};
        }

        existingCustomFields[currentStageName] = {
          ...(existingCustomFields[currentStageName] || {}),
          ...incomingCustomFields
        };

        updates.customFields = existingCustomFields;
      }

      const updatedDevice = await deviceModel.findByIdAndUpdate(
        deviceId,
        { $set: updates },
        { new: true, runValidators: true }
      );
      if (!updatedDevice) {
        return res.status(404).json({ message: "Device not found" });
      }

      // Reset attempt counts when a device is resolved via QC/TRC
      if (updates.status && String(updates.status).toLowerCase().includes("resolved")) {
        try {
          await DeviceAttempt.updateMany(
            { deviceId: device._id },
            { $set: { attemptCount: 0, stageAttempts: {}, lastAttemptAt: new Date() } }
          );
        } catch (e) {
          console.warn("Failed to reset attempt count on resolved update:", e);
        }
      }

      res.status(200).json({
        status: 200,
        message: "Device updated successfully",
        updatedDevice,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  markAsResolved: async (req, res) => {
    try {
      const { deviceId, serialNumber, serialNo } = req.body;

      if (!deviceId || !(serialNumber || serialNo)) {
        return res.status(400).json({ message: "deviceId and serialNumber are required" });
      }

      if (!mongoose.Types.ObjectId.isValid(deviceId)) {
        return res.status(400).json({ message: "Invalid deviceId" });
      }

      const device = await deviceModel.findById(deviceId);
      if (!device) {
        return res.status(404).json({ message: "Device not found" });
      }

      const incomingSerial = serialNumber || serialNo;
      if (device.serialNo !== incomingSerial) {
        return res.status(400).json({ message: "Serial number does not match the device" });
      }

      const process = await processModel.findById(device.processID);
      if (!process) {
        return res.status(404).json({ message: "Process not found for device" });
      }

      const firstStageName = Array.isArray(process.stages) && process.stages.length > 0
        ? (process.stages[0]?.stageName || "")
        : "";

      const selectedStage = req.body.currentStage || req.body.nextStage || req.body.selectedStage || "";
      if (!selectedStage) {
        await deviceTestRecords.deleteMany({
          deviceId: device._id,
          serialNo: incomingSerial,
        });
      }

      const incomingStatus = req.body.status || "QC Resolved";
      const isTRC = (incomingStatus || "").toUpperCase().includes("TRC") || !!req.body.trcRemarks;
      let parsedTrcRemarks = undefined;
      if (req.body.trcRemarks) {
        try {
          parsedTrcRemarks = typeof req.body.trcRemarks === "string"
            ? JSON.parse(req.body.trcRemarks)
            : req.body.trcRemarks;
        } catch (e) {
          parsedTrcRemarks = { parseError: true, raw: req.body.trcRemarks };
        }
      }
      const testRecordPayload = {
        deviceId: device._id,
        processId: device.processID,
        serialNo: device.serialNo,
        stageName: isTRC ? "TRC" : "QC",
        status: incomingStatus,
        assignedDeviceTo: isTRC ? "TRC" : "QC",
        ...(isTRC ? { trcRemarks: parsedTrcRemarks ? [parsedTrcRemarks] : [] } : {}),
      };

      const testRecord = new deviceTestRecords(testRecordPayload);
      const savedRecord = await testRecord.save();

      const nextStage = selectedStage || device.currentStage || firstStageName;
      const updatedDevice = await deviceModel.findByIdAndUpdate(
        device._id,
        { $set: { status: incomingStatus || "", currentStage: nextStage } },
        { new: true, runValidators: true }
      );

      try {
        await DeviceAttempt.updateMany(
          { deviceId: device._id },
          { $set: { attemptCount: 0, stageAttempts: {}, lastAttemptAt: new Date() } }
        );
      } catch (e) {
        console.warn("Failed to reset attempt count on resolve:", e);
      }

      return res.status(200).json({
        status: 200,
        message: "Device marked as resolved",
        data: {
          device: updatedDevice,
          testRecord: savedRecord,
        },
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getDeviceTestHistoryByOperatorId: async (req, res) => {
    try {
      const id = req.params.id;
      const { date, startDate, endDate } = req.query;

      let query = { operatorId: id };

      if (date) {
        const targetDate = new Date(date);
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: startOfDay, $lte: endOfDay };
      } else if (startDate && endDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: start, $lte: end };
      }

      const deviceTestRecord = await deviceTestRecords
        .find(query)
        .populate("operatorId", "name employeeCode")
        .populate("productId", "name")
        .populate("planId", "processName")
        .sort({ createdAt: -1 });

      if (deviceTestRecord.length === 0) {
        return res.status(404).json({
          status: 404,
          message:
            "No device records found for the given Operator ID with the specified filters",
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Device records retrieved successfully",
        data: deviceTestRecord,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },

  getDeviceById: async (req, res) => {
    try {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid deviceId" });
      }
      const device = await deviceModel
        .findById(id)
        .populate("productType", "name")
        .populate("processID", "processName pid processID")
        .lean();

      if (!device) {
        return res.status(404).json({ status: 404, message: "Device not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "Device fetched successfully",
        data: device
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  seedStageHistory: async (req, res) => {
    try {
      const { processId, serials, stages, stageOperatorMap } = req.body || {};

      if (!processId || !mongoose.Types.ObjectId.isValid(processId)) {
        return res.status(400).json({ status: 400, message: "Valid processId is required" });
      }
      if (!Array.isArray(serials) || serials.length === 0) {
        return res.status(400).json({ status: 400, message: "serials must be a non-empty array" });
      }
      if (!Array.isArray(stages) || stages.length === 0) {
        return res.status(400).json({ status: 400, message: "stages must be a non-empty array" });
      }
      if (!stageOperatorMap || typeof stageOperatorMap !== "object") {
        return res.status(400).json({ status: 400, message: "stageOperatorMap is required" });
      }

      const requester = await User.findById(req.user.id).lean();
      if (!requester || String(requester.userType || "").toLowerCase() !== "admin") {
        return res.status(403).json({ status: 403, message: "Only admin can seed stage history" });
      }

      const devices = await deviceModel.find({
        serialNo: { $in: serials },
        processID: processId,
      });

      if (!devices || devices.length === 0) {
        return res.status(404).json({ status: 404, message: "No matching devices found" });
      }

      await deviceModel.updateMany(
        { _id: { $in: devices.map((d) => d._id) } },
        { $set: { currentStage: "Packaging", status: "Pass", updatedAt: new Date() } }
      );

      await deviceTestRecords.deleteMany({
        processId: new mongoose.Types.ObjectId(processId),
        serialNo: { $in: serials },
        stageName: { $in: stages },
      });

      const now = new Date();
      const testRecords = [];
      devices.forEach((device) => {
        stages.forEach((stageName, idx) => {
          const operatorId = stageOperatorMap[stageName];
          if (!operatorId || !mongoose.Types.ObjectId.isValid(operatorId)) {
            throw new Error(`Missing/invalid operatorId for stage: ${stageName}`);
          }
          testRecords.push({
            deviceId: device._id,
            processId: new mongoose.Types.ObjectId(processId),
            operatorId: new mongoose.Types.ObjectId(operatorId),
            serialNo: device.serialNo,
            stageName,
            status: "Pass",
            assignedDeviceTo: "Operator",
            timeConsumed: "00:01:00",
            startTime: new Date(now.getTime() + idx * 60000),
            endTime: new Date(now.getTime() + (idx + 1) * 60000),
            logs: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        });
      });

      const insertResult = await deviceTestRecords.insertMany(testRecords);

      return res.status(200).json({
        status: 200,
        message: "Stage history seeded successfully",
        devicesUpdated: devices.length,
        recordsInserted: insertResult.length,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
function getNextIndex(assignedStages, currentIndex) {
  const keys = Object.keys(assignedStages);

  // Sort keys like "0-0", "0-1", ..., "0-10" correctly
  const sortedKeys = keys.sort((a, b) => {
    const [a1, a2] = a.split("-").map(Number);
    const [b1, b2] = b.split("-").map(Number);
    return a1 - b1 || a2 - b2;
  });

  const currentIndexStr = currentIndex.toString();

  const nextIndex = sortedKeys.find((key) => {
    return key > currentIndexStr;
  });

  return nextIndex;
}
function generateSerials(
  lastSerialNo,
  prefix,
  noOfSerialRequired,
  suffix,
  enableZero,
  noOfZeroRequired,
  stepBy = 1,
  repeatTimes = 1,
  startFrom = null
) {
  let start = 1;
  if (startFrom !== null && !isNaN(startFrom)) {
    start = startFrom;
  } else if (lastSerialNo) {
    const match = lastSerialNo.match(/\d+/g);
    if (match) {
      start = parseInt(match[match.length - 1]) + 1;
    }
  }

  const end = start + noOfSerialRequired;
  const serials = [];
  for (let i = start; i < end; i += stepBy) {
    const paddedNumber = enableZero
      ? String(i).padStart(noOfZeroRequired, "0")
      : i;
    for (let r = 0; r < repeatTimes; r++) {
      serials.push(`${prefix}${paddedNumber}${suffix}`);
    }
  }
  return serials;
}
