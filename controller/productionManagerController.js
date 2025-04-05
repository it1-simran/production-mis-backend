const mongoose = require("mongoose");
const ProcessModel = require("../models/Process");
module.exports = {
  getProcesses: async (req, res) => {
    try {
      let Processes = await ProcessModel.find({ status: "Waiting_Kits_approval" });
      return res.status(200).json({
        status: 200,
        message: "Processes Fetched Successfully!!",
        Processes,
      });
    } catch (error) {
        res.status(500).json({ message: "An error occurred while Fetching the Prodcesss" });
    }
  },
  getRemainingKitFromCompletedProcess : async (req, res) => {
    try{
      let Processes = await ProcessModel.aggregate([
        {$match:{status: "completed"}},
        {
          $lookup : {
            from : 'returnkittostores',
            localField:"_id",
            foreignField:"processId",
            as:"returnKitsDetails"
          }
        },
        {
          $unwind: {
            path:"$returnKitsDetails",
            preserveNullAndEmptyArrays: true,
          }
        },
        {
          $project:{
            consumedCartons: 1,
            consumedKits:1,
            createdAt:1,
            deliverStatus:1,
            descripition:1,
            dispatchStatus:1,
            fgToStore:1,
            issuedCartons:1,
            issuedKits:1,
            kitStatus:1,
            name:1,
            orderConfirmationNo:1,
            processID:1,
            quantity:1,
            returnKitsStatus: { $ifNull: ["$returnKitsDetails.status", ''] },
            selectedProduct:1,
            status:1,
            updatedAt:1,
          }
        }
      ]);
      return res.status(200).json({
        status: 200,
        message: "Processes Fetched Successfully!!",
        Processes,
      });
    } catch (error) {
      res.status(500).json({message: "An error occurred while Fetching the Remaining Kit "})
    }
  },
  updateProductionStatus: async (req, res) => {
    try {
        let ProcessId = req.body.id;
        let ProductionStatus = req.body.status;
        let Process = await ProcessModel.findByIdAndUpdate(ProcessId, { status: ProductionStatus }, 
            { new: true });
        return res.status(200).json({
            status: 200,
            message: "Update Production Status Successfully!!",
            Process,
        });
    } catch (error) {
        res.status(500).json({ message: "An error occurred while updating the Production status"}); 
    }
  },
  processStatics: async (req,res) => {
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
        res.status(500).json({message:"An error occured while updating the Production Status"}); 
    }
  }
};
