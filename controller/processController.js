const mongoose = require("mongoose");
const ProcessModel = require("../models/process");
const ProcessLogModel = require("../models/ProcessLogs");
const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
const AssignOperatorToPlanModel = require("../models/assignOperatorToPlan");
const AssignJigToPlanModel = require("../models/assignJigToPlan");
const AssignKitsToLineModel = require("../models/assignKitsToLine");
const OperatorModel = require("../models/User");
const DeviceTestRecordModel = require("../models/deviceTestModel");
module.exports = {
  create: async (req, res) => {
    try {
      const data = req?.body;
      const bindData = {
        name: data?.name,
        selectedProduct: data?.selectedProduct,
        orderConfirmationNo: data?.orderConfirmationNo,
        processID: data?.processID,
        quantity: data?.quantity,
        descripition: data?.descripition,
        stages: JSON.parse(data?.stages),
        commonStages: JSON.parse(data?.commonStages),
      };
      const newProcess = new ProcessModel(bindData);
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
            consumedKits: 1,
            fgToStore: 1,
            dispatchStatus: 1,
            deliverStatus: 1,
            stages: 1,
            commonStages: 1,
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
  getProcessesByProductId: async (req, res) => {
    try {
      const Processes = await ProcessModel.find({
        selectedProduct: req.params.id,
      });
      return res.status(200).json({
        status: 200,
        status_msg: "Processes Fetched Sucessfully!!",
        Processes,
      });
    } catch (error) {
      return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
  },
  delete: async (req, res) => {
    try {
      const { id } = req.params;
      const deletedProcess = await ProcessModel.findByIdAndDelete(id);

      if (!deletedProcess) {
        return res.status(404).json({ message: "Process not found" });
      }
      await Promise.all([
        PlaningAndSchedulingModel.deleteMany({ selectedProcess: id }),
        AssignOperatorToPlanModel.deleteMany({ processId: id }),
        AssignJigToPlanModel.deleteMany({ processId: id }),
      ]);

      return res.status(200).json({
        message: "Process and related data deleted successfully!",
        process: deletedProcess,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message || "Internal Server Error",
      });
    }
  },

  // delete: async (req, res) => {
  //   try {
  //     const Process = await ProcessModel.findByIdAndDelete(req.params.id);
  //     const planingAndScheduling = await PlaningAndSchedulingModel.findOneAndDelete({selectedProcess
  //     :req.params.id});
  //     const delAssignOperatorsplans = await AssignOperatorPlansModel.findOneAndDelete({processId
  //     :req.params.id});
  //     const assignJigPlans = await AssignJigPlansModel.findOneAndDelete({processId:req.params.id});

  //     if (!Process) {
  //       return res.status(404).json({ message: "Process not found" });
  //     }
  //     res
  //       .status(200)
  //       .json({ message: "Process Deleted Successfully!!", Process });
  //   } catch (error) {dsx
  //     return res.status(500).json({ status: 500, error: error.message });
  //   }
  // },
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
      const data = req?.body;

      const oldProcess = await ProcessModel.findById(id);
      if (!oldProcess) {
        return res.status(404).json({ message: "Process not found" });
      }

      let newStages = JSON.parse(data?.stages || "[]");
      let newCommonStages = JSON.parse(data?.commonStages || "[]");

      // Preserving operator/jig assignments for existing stages during cloning if they match by name
      if (data?.isCloning === "true") {
        newStages = newStages.map((ns) => {
          const matchingOld = oldProcess.stages.find(
            (os) => os.stageName === ns.stageName
          );
          if (matchingOld) {
            return {
              ...ns,
              managedBy: matchingOld.managedBy || ns.managedBy,
              jigId: matchingOld.jigId || ns.jigId,
            };
          }
          return ns;
        });
        newCommonStages = newCommonStages.map((ncs) => {
          const matchingOld = oldProcess.commonStages.find(
            (ocs) => ocs.stageName === ncs.stageName
          );
          if (matchingOld) {
            return {
              ...ncs,
              managedBy: matchingOld.managedBy || ncs.managedBy,
            };
          }
          return ncs;
        });
      }

      const updatedData = {
        name: data?.name,
        selectedProduct: data?.selectedProduct,
        orderConfirmationNo: data?.orderConfirmationNo,
        processID: data?.processID,
        quantity: data?.quantity,
        descripition: data?.descripition,
        stages: newStages,
        commonStages: newCommonStages,
      };

      const updatedProcess = await ProcessModel.findByIdAndUpdate(
        id,
        updatedData,
        {
          new: true,
          runValidators: true,
        }
      );

      if (!updatedProcess) {
        return res.status(404).json({ message: "Process not found after update" });
      }

      // Surgical cleanup of orphan assignments in plans
      const activeStageNames = new Set(newStages.map((s) => s.stageName));
      const activeCommonStageNames = new Set(
        newCommonStages.map((s) => s.stageName)
      );

      try {
        const plans = await PlaningAndSchedulingModel.find({
          selectedProcess: id,
        });

        for (const plan of plans) {
          let assignedStages = JSON.parse(plan.assignedStages || "{}");
          let assignedOperators = JSON.parse(plan.assignedOperators || "{}");
          let assignedJigs = JSON.parse(plan.assignedJigs || "{}");
          let modified = false;

          for (const key in assignedStages) {
            const stagesOnSeat = assignedStages[key];
            const isStillActive = Array.isArray(stagesOnSeat)
              ? stagesOnSeat.some((s) => activeStageNames.has(s.name))
              : activeStageNames.has(stagesOnSeat);

            if (!isStillActive) {
              // This stage is removed!
              const [row, seat] = key.split("-");

              // Free operators - we don't need to manually update status if we delete mapping
              // but we can update to "Free" if there's any other logic depending on it.
              // Here we just delete the mapping records so they disappear from task lists.
              await AssignOperatorToPlanModel.deleteMany({
                processId: id,
                "seatDetails.rowNumber": row,
                "seatDetails.seatNumber": seat,
              });
              await AssignJigToPlanModel.deleteMany({
                processId: id,
                "seatDetails.rowNumber": row,
                "seatDetails.seatNumber": seat,
              });

              // Remove from plan JSON blobs
              delete assignedStages[key];
              delete assignedOperators[key];
              delete assignedJigs[key];
              modified = true;
            }
          }

          // Cleanup for custom/common stages
          let assignedCustomStages = JSON.parse(plan.assignedCustomStages || "[]");
          let assignedCustomStagesOp = JSON.parse(plan.assignedCustomStagesOp || "[]");
          let filteredCustomStages = [];
          let filteredCustomStagesOp = [];
          let customModified = false;

          for (let i = 0; i < assignedCustomStages.length; i++) {
            const stageName = assignedCustomStages[i];
            if (activeCommonStageNames.has(stageName)) {
              filteredCustomStages.push(stageName);
              filteredCustomStagesOp.push(assignedCustomStagesOp[i]);
            } else {
              // Removed common stage
              await AssignOperatorToPlanModel.deleteMany({
                processId: id,
                stageType: stageName,
              });
              customModified = true;
            }
          }

          if (modified || customModified) {
            plan.assignedStages = JSON.stringify(assignedStages);
            plan.assignedOperators = JSON.stringify(assignedOperators);
            plan.assignedJigs = JSON.stringify(assignedJigs);
            plan.assignedCustomStages = JSON.stringify(filteredCustomStages);
            plan.assignedCustomStagesOp = JSON.stringify(filteredCustomStagesOp);
            await plan.save();
          }
        }
      } catch (cleanupError) {
        console.error("Error during surgical cloning cleanup:", cleanupError);
      }

      return res.status(200).json({
        status: 200,
        message: "Process updated successfully!!",
        data: updatedProcess,
      });
    } catch (error) {
      console.error("Error updating process:", error);
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
      let assignedOperatorsToPlan = await AssignOperatorToPlanModel.find({
        processId: id,
        status: "Occupied",
      });
      if (assignedOperatorsToPlan.length > 0) {
        assignedOperatorsToPlan.map(async (value, index) => {
          let operatorData = { status: "Free" };
          const updatedPlan =
            await AssignOperatorToPlanModel.findByIdAndUpdate(
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
      const updatedQuantity = await ProcessModel.findByIdAndUpdate(
        id,
        {
          quantity: totalQuantity,
          kitStatus: req.body.status,
        },
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
      const users = await OperatorModel.find();

      // const users = await OperatorModel.aggregate([
      //   {
      //     $match: { userType: "Operator" },
      //   },
      //   {
      //     $lookup: {
      //       from: "assignpoperatorsplans",
      //       localField: "_id",
      //       foreignField: "userId",
      //       as: "assignOperatorDetails",
      //     },
      //   },
      //   {
      //     $addFields: {
      //       hasFreeStatus: {
      //         $anyElementTrue: {
      //           $map: {
      //             input: "$assignOperatorDetails",
      //             as: "detail",
      //             in: { $eq: ["$$detail.status", "Free"] },
      //           },
      //         },
      //       },
      //     },
      //   },
      //   {
      //     $match: {
      //       $or: [
      //         { assignOperatorDetails: { $eq: [] } },
      //         { hasFreeStatus: true },
      //       ],
      //     },
      //   },
      // ]);
      console.log("users ==>", users);
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
      let operatorData = await AssignOperatorToPlanModel.findOne({ userId });
      if (operatorData && Object.keys(operatorData).length > 0) {
        updateAssignedOperator =
          await AssignOperatorToPlanModel.findByIdAndUpdate(
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
  updateIssuedKitsToLine: async (req, res) => {
    try {
      let data = req.body;
      const condition = {
        planId: data.planId,
        processId: data.processId,
      };

      const updateData = {
        planId: data.planId,
        processId: data.processId,
        issuedKits: parseInt(data.issuedKits),
        seatDetails: JSON.parse(data.seatDetails),
        issuedKitsStatus: data.issuedKitsStatus,
        status: "ASSIGN_TO_OPERATOR",
      };
      let processData = {
        status: req.body.processStatus,
      };
      const options = {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      };

      const updatedEntry = await AssignKitsToLineModel.findOneAndUpdate(
        condition,
        updateData,
        options
      );
      // if(updatedEntry) {
      const updatedPlan = await PlaningAndSchedulingModel.findByIdAndUpdate(
        data.planId,
        { assignedStages: data.assignedStage },
        {
          new: true,
          runValidators: true,
        }
      );
      const updatedProcess = await ProcessModel.findByIdAndUpdate(
        data.processId,
        processData,
        { new: true, runValidators: true }
      );
      if (updatedProcess) {
        return res.status(200).json({
          status: 200,
          message: "Issued Kits to Line Updated Successfully!!",
          updatedProcess,
        });
      }
      // }
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateStatusRecievedKit: async (req, res) => {
    try {
      let id = req.params.id;
      let data = { status: req?.body?.status, issuedKitsStatus: req?.body?.issuedKitsStatus };
      let processData = {
        status: req.body.processStatus,
      };
      const updateStatus = await AssignKitsToLineModel.findByIdAndUpdate(
        id,
        data,
        {
          new: true,
          runValidators: true,
        }
      );
      const updatedProcess = await ProcessModel.findByIdAndUpdate(
        req.body.processId,
        processData,
        { new: true, runValidators: true }
      );
      return res.status(200).json({
        status: 200,
        message: "Update Status to Line SuccessFully !!",
        updateStatus,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getDeviceTestRecordsByProcessId: async (req, res) => {
    try {
      let processId = req.params.id;
      const pageRaw = req.query.page;
      const limitRaw = req.query.limit;
      const shouldPaginate = pageRaw || limitRaw;
      let deviceTestRecords;
      let meta;
      if (shouldPaginate) {
        const page = Math.max(parseInt(pageRaw) || 1, 1);
        const limit = Math.min(Math.max(parseInt(limitRaw) || 100, 1), 1000);
        const skip = (page - 1) * limit;
        const [entries, total] = await Promise.all([
          DeviceTestRecordModel.find({ processId }, null, { sort: { createdAt: -1 } })
            .populate("operatorId", "name employeeCode")
            .skip(skip)
            .limit(limit)
            .lean(),
          DeviceTestRecordModel.countDocuments({ processId }),
        ]);
        deviceTestRecords = entries;
        meta = { page, limit, total };
      } else {
        deviceTestRecords = await DeviceTestRecordModel.find({ processId }, null, { sort: { createdAt: -1 } })
          .populate("operatorId", "name employeeCode")
          .lean();
      }
      return res.status(200).json({
        status: 200,
        message: "Device Record Test Fetched SuccessFully !!",
        deviceTestRecords,
        ...(meta ? { meta } : {}),
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
