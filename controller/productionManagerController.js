const mongoose = require("mongoose");
const ProcessModel = require("../models/process");
module.exports = {
  getProcesses: async (req, res) => {
    try {
      let Processes = await ProcessModel.aggregate([
        // { $match: {status: "Waiting_Kits_approval"}},
        {
          $lookup: {
            from: "planingandschedulings",
            localField: "_id",
            foreignField: "selectedProcess",
            as: "planingDetails",
          },
        },
        {
          $unwind: {
            path: "$planingDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "products",
            localField: "selectedProduct",
            foreignField: "_id",
            as: "productDetails",
          },
        },
        { $unwind: "$productDetails" },
        {
          $lookup: {
            from: "assignkitstolines",
            localField: "_id",
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
          $project: {
            _id: 1,
            name: 1,
            selectedProduct: 1,
            orderConfirmationNo: 1,
            processID: 1,
            quantity: 1,
            issuedKits: 1,
            issuedCartons: 1,
            consumedKits: 1,
            consumedCartons: 1,
            descripition: 1,
            fgToStore: 1,
            stages: 1,
            dispatchStatus: 1,
            deliverStatus: 1,
            kitStatus: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            planId: "$planingDetails._id",
            issuedKitsToOperator: "$assignKitsToLine.issuedKits",
            assignStages: "$planingDetails.assignedStages",
            repeatCount: "$planingDetails.repeatCount",
            productStage: "$productDetails.stages",
            kitRecievedId: "$assignKitsToLine._id",
            kitRecievedConfirmationStatus: "$assignKitsToLine.status",
            issuedKitsStatus: "$assignKitsToLine.issuedKitsStatus",
            assignedKitsToOperator: "$assignKitsToLine.issuedKits",
          },
        },
      ]);
      if (!Processes.length) {
        console.log(
          "No processes found or the lookup did not match any documents."
        );
      }
      return res.status(200).json({
        status: 200,
        message: "Processes Fetched Successfully!!",
        Processes,
      });
    } catch (error) {
      res
        .status(500)
        .json({
          message: `An error occurred while Fetching the Prodcesss:${error.message}`,
        });
    }
  },
  getRemainingKitFromCompletedProcess: async (req, res) => {
    try {
      let Processes = await ProcessModel.aggregate([
        { $match: { status: "completed" } },
        {
          $lookup: {
            from: "returnkittostores",
            localField: "_id",
            foreignField: "processId",
            as: "returnKitsDetails",
          },
        },
        {
          $unwind: {
            path: "$returnKitsDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            consumedCartons: 1,
            consumedKits: 1,
            createdAt: 1,
            deliverStatus: 1,
            descripition: 1,
            dispatchStatus: 1,
            fgToStore: 1,
            issuedCartons: 1,
            issuedKits: 1,
            kitStatus: 1,
            name: 1,
            orderConfirmationNo: 1,
            processID: 1,
            quantity: 1,
            returnKitsStatus: { $ifNull: ["$returnKitsDetails.status", ""] },
            selectedProduct: 1,
            status: 1,
            updatedAt: 1,
          },
        },
      ]);
      return res.status(200).json({
        status: 200,
        message: "Processes Fetched Successfully!!",
        Processes,
      });
    } catch (error) {
      res
        .status(500)
        .json({
          message: "An error occurred while Fetching the Remaining Kit ",
        });
    }
  },
  updateProductionStatus: async (req, res) => {
    try {
      const { id: ProcessId, status: ProductionStatus, issuedKits } = req.body;

      const existingProcess = await ProcessModel.findById(ProcessId);

      if (!existingProcess) {
        return res.status(404).json({
          status: 404,
          message: "Process not found",
        });
      }

      const updateData = {
        status: ProductionStatus,
      };
 
      if (existingProcess.kitStatus === "Waiting_Kits_allocation") {
        updateData.issuedKits = issuedKits;
      }

      const Process = await ProcessModel.findByIdAndUpdate(
        ProcessId,
        updateData,
        { new: true }
      );

      return res.status(200).json({
        status: 200,
        message: "Update Production Status Successfully!!",
        Process,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        message: "An error occurred while updating the Production status",
      });
    }
  },

  processStatics: async (req, res) => {
    try {
      let Process = await ProcessModel.aggregate([
        {
          $lookup: {
            from: "planingandschedulings",
            localField: "_id",
            foreignField: "selectedProcess",
            as: "planingData",
          },
        },
        { $unwind: "$planingData" },
        // {
        //   $project: {
        //     // _id: 1,
        //     // name: 1,
        //     // processID: 1,
        //     // processQuantity: "$quantity",
        //     // inventoryQuantity: "$inventoryProcess.quantity",
        //     // cartonQuantity: "$inventoryProcess.cartonQuantity",
        //     // status: "$inventoryProcess.status",
        //     // productName: "$products.name",
        //     // issuedKits: 1,
        //     // issuedCartons: 1,
        //     // createdAt: 1,
        //     // updatedAt: 1,
        //     // status: 1,
        //     // productDetails: 1,
        //   },
        // },
      ]);
      console.log("Process ==>", Process);
    } catch (error) {
      res
        .status(500)
        .json({
          message: "An error occured while updating the Production Status",
        });
    }
  },
  getProcessCompletionAnalytics: async (req, res) => {
    try {
      const days = Math.max(parseInt(req.query.days, 10) || 14, 1);
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      start.setHours(0, 0, 0, 0);

      const daily = await ProcessModel.aggregate([
        { $match: { createdAt: { $gte: start } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            total: { $sum: 1 },
            completed: {
              $sum: {
                $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const map = daily.reduce((acc, row) => {
        acc[row._id] = row;
        return acc;
      }, {});

      const categories = [];
      const completionRate = [];
      for (let i = 0; i < days; i += 1) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const key = d.toISOString().slice(0, 10);
        categories.push(key);
        const row = map[key];
        const rate = row && row.total > 0 ? (row.completed / row.total) * 100 : 0;
        completionRate.push(Number(rate.toFixed(2)));
      }

      const totals = await ProcessModel.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
            },
          },
        },
      ]);
      const total = totals[0]?.total || 0;
      const completed = totals[0]?.completed || 0;
      const overallRate = total > 0 ? (completed / total) * 100 : 0;

      return res.status(200).json({
        status: 200,
        message: "Process completion analytics fetched successfully",
        categories,
        series: [{ name: "Completion Rate (%)", data: completionRate }],
        overall: {
          total,
          completed,
          rate: Number(overallRate.toFixed(2)),
        },
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "An error occurred while fetching completion analytics",
        error: error.message,
      });
    }
  },
};
