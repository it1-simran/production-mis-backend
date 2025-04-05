const mongoose = require("mongoose");
const ProcessModel = require("../models/Process");
const ProcessLogModel = require("../models/ProcessLogs");
const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
const AsssignOperatorToPlanModel = require("../models/assignOperatorToPlan");
const OperatorModel = require("../models/User");
module.exports = {
  create: async (req, res) => {
    try {
      const data = req?.body;
      const newProcess = new ProcessModel(data);
      await newProcess.save();
      return res.status(200).json({
        status: 200,
        message: "Process Created Successfully!!",
        newProcess,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  view: async (req, res) => {
    try {
      const Processes = await ProcessModel.aggregate([
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
            from: "planingandschedulings",
            localField: "_id",
            foreignField: "selectedProcess",
            as: "planingandScheduling",
          },
        },
        {
          $unwind: {
            path: "$planingandScheduling",
            preserveNullAndEmptyArrays: true,
          },
        },
        // {
        //   $lookup: {
        //     from: "products",
        //     localField: "selectedProduct",
        //     foreignField: "_id",
        //     as: "productDetails",
        //   },
        // },
        // {$unwind:'$productDetails'},
        // {
        //   $lookup: {
        //     from: "planingandschedulings",
        //     localField:"_id",
        //     foreignField: "selectedProcess",
        //     as: "planingandScheduling"
        //   },
        // },
        // {
        //   $unwind:'$planingandScheduling',
        //   preserveNullAndEmptyArrays: true
        // },
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
            descripition: 1,
            kitStatus: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            productName: "$productDetails.name",
            planing: { $ifNull: ["$planingandScheduling", {}] },
          },
        },
      ]);
      return res.status(200).json({
        status: 200,
        message: "Process Fetched Successfully!!",
        Processes,
      });
    } catch (error) {
      return res.status(500).json({ staus: 500, error: error.message });
    }
  },
  delete: async (req, res) => {
    try {
      const Process = await ProcessModel.findByIdAndDelete(req.params.id);
      if (!Process) {
        return res.status(404).json({ message: "Process not found" });
      }
      res
        .status(200)
        .json({ message: "Process Deleted Successfully!!", Process });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deleteProcessMultiple: async (req, res) => {
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
      const result = await ProcessModel.deleteMany({ _id: { $in: objectIds } });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} Process(es) deleted successfully`,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getProcessByID: async (req, res) => {
    try {
      const id = req.params.id;
      const process = await ProcessModel.findById(id);
      if (!process) {
        return res.status(404).json({ error: "Process not found" });
      }
      return res.status(200).json(process);
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  update: async (req, res) => {
    try {
      const id = req.params.id;
      const updatedData = req.body;
      const updatedProcess = await ProcessModel.findByIdAndUpdate(
        id,
        updatedData,
        {
          new: true,
          runValidators: true,
        }
      );
      if (!updatedProcess) {
        return res.status(404).json({ message: "Process not found" });
      }
      return res.status(200).json({
        status: 200,
        message: "Process updated successfully!!",
        shift: updatedProcess,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  processLogs: async (req, res) => {
    try {
      const data = req?.body;
      const processLogs = new ProcessLogModel(data);
      await processLogs.save();
      return res.status(200).json({
        status: 200,
        message: "Process Logs Created Successfully!!",
        processLogs,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateMarkasCompletedProcess: async (req, res) => {
    try {
      const { id } = req.params;
      console.log("Process ID:", id);

      if (!id) {
        return res
          .status(400)
          .json({ status: 400, message: "Process ID is required" });
      }
      let assignedOperatorsToPlan = await AsssignOperatorToPlanModel.find({
        processId: id,
        status: "Occupied",
      });
      if (assignedOperatorsToPlan.length > 0) {
        assignedOperatorsToPlan.map(async (value, index) => {
          let operatorData = { status: "Free" };
          const updatedPlan =
            await AsssignOperatorToPlanModel.findByIdAndUpdate(
              value._id,
              operatorData,
              {
                new: true,
                runValidators: true,
              }
            );
        });
      }
      const updatedData = req.body;
      const updatedProcess = await ProcessModel.findByIdAndUpdate(
        id,
        updatedData,
        {
          new: true,
          runValidators: true,
        }
      );

      if (!updatedProcess) {
        return res
          .status(404)
          .json({ status: 404, message: "Process not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "Process Updated Successfully!",
        data: updatedProcess,
      });
    } catch (error) {
      console.error("Error updating process:", error);
      return res.status(500).json({
        status: 500,
        message: "Internal Server Error",
        error: error.message,
      });
    }
  },

  updateMoreQuantity: async (req, res) => {
    try {
      const id = req.params.id;
      console.log("updatedQuantity", req.body.quantity);
      const planData = await ProcessModel.aggregate([
        {
          $match: { _id: new mongoose.Types.ObjectId(id) },
        },
        {
          $lookup: {
            from: "planingandschedulings",
            localField: "_id",
            foreignField: "selectedProcess",
            as: "planing",
          },
        },
        {
          $unwind: {
            path: "$planing",
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
            descripition: 1,
            kitStatus: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            planing: 1,
          },
        },
      ]);
      let finalPlanData = planData[0];
      let planingID = finalPlanData?.planing?._id;
      let startDate = finalPlanData?.planing?.startDate;
      let totalUPHA = parseInt(finalPlanData?.planing.totalUPHA);
      let totalQuantity =
        parseInt(finalPlanData.quantity) + parseInt(req.body.quantity);
      const totalTimeEstimationInDays = parseInt(
        (totalQuantity / totalUPHA).toFixed(2)
      );
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + totalTimeEstimationInDays);
      const updateQuanity = await ProcessModel.findByIdAndUpdate(
        id,
        { quantity: totalQuantity },
        { new: true, runValidators: true }
      );
      const updatedPlaningAndScheduling =
        await PlaningAndSchedulingModel.findByIdAndUpdate(
          planingID,
          {
            totalTimeEstimation: totalTimeEstimationInDays,
            estimatedEndDate: endDate,
          },
          { new: true, runValidators: true }
        );
      return res.status(200).json({
        status: 200,
        message: "Process updated successfully!!",
        startDate,
        totalUPHA,
        totalQuantity,
        endDate,
        totalTimeEstimationInDays,
        planData: finalPlanData,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getVacantOperator: async (req, res) => {
    try {
      let users = await OperatorModel.aggregate([
        {
          $match: {
            userType: "Operator",
          },
        },
        {
          $lookup: {
            from: "assignpoperatorsplans",
            localField: "_id",
            foreignField: "userId",
            as: "assignOperatorDetails",
          },
        },
        {
          $match: {
            $or: [
              { assignOperatorDetails: { $size: 0 } },
              { "assignOperatorDetails.status": "Free" },
            ],
          },
        },
      ]);

      return res.status(200).json({
        status: 200,
        message: "VacantOperator found!!",
        users,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateStatusAssignedOperator: async (req, res) => {
    try {
      let userId = req.params.id;
      let status = req.body.status;
      let updateAssignedOperator;
      let operatorData = await AsssignOperatorToPlanModel.findOne({ userId });
      if (operatorData && Object.keys(operatorData).length > 0) {
        updateAssignedOperator = await AsssignOperatorToPlanModel.findByIdAndUpdate(
          operatorData._id,
          { status },
          { new: true, runValidators: true }
        );
      } else {
        return res.status(500).json({
          status: 500,
          message: "No Records found!!",
          updateAssignedOperator,
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Vacant Operator found!!",
        updateAssignedOperator,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
