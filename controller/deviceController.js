const deviceModel = require("../models/device");
const deviceTestRecords = require("../models/deviceTestModel");
const planingAndScheduling = require("../models/planingAndSchedulingModel");
const productModel = require("../models/Products");
const inventoryModel = require("../models/inventoryManagement");
const imeiModel = require("../models/imeiModel");
const mongoose = require("mongoose");

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
      const serials = generateSerials(
        lastSerialNo,
        prefix,
        parseInt(noOfSerialRequired),
        suffix,
        enableZero,
        noOfZeroRequired
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
      console.log("error ==>", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getLastEntryBasedOnPrefixAndSuffix: async (req, res) => {
    try {
      const data = req.query;
      const lastEntry = await deviceModel
        .findOne({
          serialNo: { $regex: `^${data.prefix}.*${data.suffix}$` },
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

    // Retrieve the planing and product data
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
      products = await productModel.findById(data.productId);
      if (!products) {
        return res.status(404).json({
          status: 404,
          message: "Product not found",
        });
      }
    } catch (err) {
      return res.status(500).json({
        status: 500,
        message: `Error fetching product data: ${err.message}`,
      });
    }

    // Parse assignedStages and assignedOperators safely
    let assignedStages = {};
    let assignedOperator = {};

    try {
      assignedStages = JSON.parse(planing.assignedStages) || {};
      assignedOperator = JSON.parse(planing.assignedOperators) || {};
    } catch (err) {
      return res.status(500).json({
        status: 500,
        message: 'Invalid JSON format in planing data.',
      });
    }

    // Ensure assignedCustomStagesOp is an array before using .push
    if (!Array.isArray(planing.assignedCustomStagesOp)) {
      assignedCustomStagesOp = JSON.parse(planing.assignedCustomStagesOp); // Initialize as an empty array if it's not already an array
    }

    // Find the matching operator index
    let matchingIndices = Object.keys(assignedOperator).filter((key) =>
      assignedOperator[key].some(
        (operator) => operator._id === data.operatorId
      )
    );

    if (matchingIndices.length > 0) {
      let currentIndex = matchingIndices[0];
      let currentStage = assignedStages[currentIndex][0]?.name;
      let productStages = (products.stages || []).map((stage) => stage.stageName);
      let commonStages = (products.commonStages || []).map((stage) => stage.stageName);
      const mergedStages = [...productStages, ...commonStages];

      let lastProductStage = productStages[productStages.length - 1];
      let lastStage = mergedStages[mergedStages.length - 1];

      // Calculate the nextIndex
      let nextIndex = Object.keys(assignedStages)
        .map(Number)
        .find((index) => index > Number(currentIndex));

      // Update stages
      if (assignedStages[currentIndex] && assignedStages[currentIndex][0]) {
        assignedStages[currentIndex][0].totalUPHA -= 1;

        if (data.status === "Pass") {
          assignedStages[currentIndex][0].passedDevice += 1;
          if (currentStage === lastProductStage) {
            if (commonStages.length > 0) {
              assignedStages[currentIndex][0].totalUPHA -= 1;
              const customStageData = {
                name: commonStages[0],
                totalUPHA: 1,
                passedDevice: 0,
                ngDevice: 0,
              };
              console.log("customStageData ===>", customStageData);
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
          assignedStages[currentIndex][0].ngDevice += 1;
        }
      }
      if (currentStage === "FG to Store") {
        planing.consumedKit += 1;
      }

      if (currentStage === lastStage) {
        assignedStages[currentIndex][0].totalUPHA -= 1;
      }
      console.log("planing.assignedCustomStagesOp -->", assignedCustomStagesOp);
      console.log("assignedStages ==>", assignedStages);
      planing.assignedStages = JSON.stringify(assignedStages);
      planing.assignedCustomStagesOp = JSON.stringify(assignedCustomStagesOp);
      let updatedstages;
      try {
        updatedstages = await planingAndScheduling.findByIdAndUpdate(
          data.planId,
          { $set: { assignedStages: planing.assignedStages, consumedKit: planing.consumedKit, assignedCustomStagesOp: planing.assignedCustomStagesOp } },
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

      // Record the device test entry
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
        message: "Device Test Entry added successfully",
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

  // createDeviceTestEntry: async (req, res) => {
  //   try {
  //     const data = req.body;
  //     let nextIndex;
  //     const planing = await planingAndScheduling.findById(data.planId);
  //     const products = await productModel.findById(data.productId);
  //     let assignedStages = JSON.parse(planing.assignedStages);
  //     let assignedOperator = JSON.parse(planing.assignedOperators);
  //     let matchingIndices = Object.keys(assignedOperator).filter((key) =>
  //       assignedOperator[key].some(
  //         (operator) => operator._id === data.operatorId
  //       )
  //     );

  //     if (matchingIndices.length > 0) {
  //       let currentIndex = matchingIndices[0];
  //       let currentStage = assignedStages[currentIndex][0]?.name;
  //       let productStages = products.stages.map((stage) => stage.stageName);
  //       let commonStages = products.commonStages.map((stage) => stage.stageName);
  //       console.log("productStages ==>", productStages);
  //       console.log("commonStages ===>", commonStages);
  //       const mergedStages = [...productStages, ...commonStages];
  //       let lastStage = mergedStages[mergedStages.length - 1];
  //       nextIndex = Object.keys(assignedStages).find(
  //         (index) => index > currentIndex
  //       );
  //       if (assignedStages[currentIndex] && assignedStages[currentIndex][0]) {
  //         assignedStages[currentIndex][0].totalUPHA -= 1;
  //         if (data.status === "Pass") {
  //           assignedStages[currentIndex][0].passedDevice += 1;
  //         } else {
  //           assignedStages[currentIndex][0].ngDevice += 1;
  //         }
  //       }
  //       if(currentStage === "FG to Store") {
  //           planing.consumedKit += 1;
  //       }
  //       if (currentStage === lastStage) {
  //         assignedStages[currentIndex][0].totalUPHA -= 1;

  //       } else {
  //         if (
  //           nextIndex &&
  //           assignedStages[nextIndex] &&
  //           assignedStages[nextIndex][0] &&
  //           data.status === "Pass"
  //         ) {
  //           assignedStages[nextIndex][0].totalUPHA += 1;
  //         }
  //       }
  //     }
  //     console.log("assignedStages ===>", assignedStages);
  //     return false;
  //     planing.assignedStages = JSON.stringify(assignedStages);
  //     const updatedstages = await planingAndScheduling.findByIdAndUpdate(
  //       data.planId,
  //       { $set: planing },
  //       { new: true, runValidators: true }
  //     );
  //     if (updatedstages) {
  //       const deviceTestRecord = new deviceTestRecords(data);
  //       const savedDeviceTestRecord = await deviceTestRecord.save();
  //       return res.status(200).json({
  //         status: 200,
  //         message: "Devices Test Entry added successfully",
  //         data: savedDeviceTestRecord,
  //       });
  //     } else {
  //       return res.status(500).json({
  //         status: 500,
  //         message: "Erorr Updating Planning",
  //         data: updatedstages,
  //       });
  //     }
  //   } catch (error) {
  //     return res.status(500).json({
  //       status: 500,
  //       error: error.message,
  //     });
  //   }
  // },
  getOverallDeviceTestEntry: async (req, res) => {
    try {
      const DeviceTestEntry = await deviceTestRecords.find();
      return res.status(200).json({
        status: 200,
        status_msg: "Device Test Entry Fetched Sucessfully!!",
        DeviceTestEntry,
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
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      const deviceTestRecord = await deviceTestRecords.find({
        operatorId: id,
        createdAt: {
          $gte: startOfDay,
          $lt: endOfDay,
        },
      });
      if (deviceTestRecord.length === 0) {
        return res.status(404).json({
          status: 404,
          message:
            "No device records found for the given Operator ID on the current date",
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
      let deviceTestHistory = await deviceTestRecords.find({ deviceId: id });
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
  updateStageByDeviceId: async (req, res) => {
    try {
      let deviceId = req.params.deviceId;
      let updates = req.body;
      const updatedDevice = await deviceModel.findByIdAndUpdate(
        deviceId,
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
  getOverallProcessByOperatorId: async (req, res) => {
    try {
      const { planId, operatorId } = req.params;
      const devices = await deviceTestRecords.find({ planId, operatorId });
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
};
function generateSerials(
  lastSerialNo,
  prefix,
  noOfSerialRequired,
  suffix,
  enableZero,
  noOfZeroRequired,
  stepBy = 1,
  repeatTimes = 1
) {
  let start = 1;
  if (lastSerialNo) {
    start += parseInt(lastSerialNo.split("-")[1]);
    noOfSerialRequired += start;
  }
  const serials = [];
  for (let i = start; i <= noOfSerialRequired; i += stepBy) {
    const paddedNumber = enableZero
      ? String(i).padStart(noOfZeroRequired, "0")
      : i;
    for (let r = 0; r < repeatTimes; r++) {
      serials.push(`${prefix}${paddedNumber}${suffix}`);
    }
  }
  return serials;
}
