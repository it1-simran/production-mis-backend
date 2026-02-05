const mongoose = require("mongoose");
const kitsModel = require("../models/returnKitToStore");
const InventoryModel = require("../models/inventoryManagement");
const ProcessModel = require("../models/process");

module.exports = {
  createKitsEntry: async (req, res) => {
    try {
      const data = req?.body;
      const kitsEntry = new kitsModel(data);
      await kitsEntry.save();
      return res.status(200).json({status: 200,message: "Kits Return Entry Created Successfully!!",kitsEntry});
    } catch (error) {
      return res.status(500).json({status: 500,status_msg: `Error Creating Return Kit Entry : ${error.message}`});
    }
  },
  updateKitsStatus: async (req,res) => {
    try {
      const id = req.params.id;
      let data = {'status':req.body.status};
      if (!req.body.processID) {
        return res.status(400).json({ status: 400, message: "processID is required" });
      }
      const processData = await ProcessModel.findOne({_id:req.body.processID});
      let updatedProcessData = {
        issuedKits : processData.issuedKits - parseInt(req.body.returnedKits),
        issuedCartons:processData.issuedCartons - parseInt(req.body.returnedCarton),
      }
      console.log("updatedProcessData ==>", updatedProcessData);
      const updatedProcess  = await ProcessModel.findByIdAndUpdate(req.body.processID,updatedProcessData,{new:true});
      const currentInventory = await InventoryModel.findOne({productType:req.body.selectedProduct});
      const inventoryData = {
        'quantity':parseInt(currentInventory.quantity) + parseInt(req.body.returnedKits) ,
        'cartonQuantity':parseInt(currentInventory.cartonQuantity) + parseInt(req.body.returnedCarton),
      };
      if(parseInt(req.body.returnedKits) <  parseInt(currentInventory.issuedKits) || parseInt(req.body.returnedCarton) < parseInt(currentInventory.issuedCartons)) {
        data.status = 'PARTIALLY_RECIVED';
      }
      let inventory  = await InventoryModel.findByIdAndUpdate(currentInventory._id,inventoryData,{new:true});
      let KitsEntry = await kitsModel.findByIdAndUpdate(id, data, { new: true });
      return res.status(200).json({
          status: 200,
          message: "Update Kits Entry Status Successfully!!",
          KitsEntry,
      });
    } catch (error) {
      return res.status(500).json({status: 500,status_msg: `Error Updating Return Kits : ${error.message}"`});
    }
  },
  viewReturnKitStore: async (req, res) => {
    try {
        const kitsEntry = await kitsModel.aggregate([
            {
                $match:{status: "SEND_TO_STORE"}
            },
            {
                $lookup : {
                    from : 'processes',
                    localField:"processId",
                    foreignField:"_id",
                    as:"processesDetails"
                }
            },
            {
                $unwind: "$processesDetails"
            },
            {
                $project:{

                    consumedCartons: "$processesDetails.consumedCartons",
                    consumedKits:"$processesDetails.consumedKits",
                    createdAt:"$processesDetails.createdAt",
                    deliverStatus:"$processesDetails.deliverStatus",
                    descripition:"$processesDetails.descripition",
                    dispatchStatus:"$processesDetails.dispatchStatus",
                    fgToStore:"$processesDetails.fgToStore",
                    issuedCartons:"$processesDetails.issuedCartons",
                    issuedKits:"$processesDetails.issuedKits",
                    kitStatus:"$processesDetails.kitStatus",
                    name:"$processesDetails.name",
                    orderConfirmationNo:"$processesDetails.orderConfirmationNo",
                    processID:"$processesDetails.processID",
                    pID: "$processesDetails._id",
                    quantity:"$processesDetails.quantity",
                    status:  1,
                    selectedProduct:"$processesDetails.selectedProduct",
                    status:"$processesDetails.status",
                    updatedAt:"$processesDetails.updatedAt",
                }
            }
        ]);
        return res.status(200).json({status: 200,message: "Return Kit Store Data Retrieved Successfully!!",kits:kitsEntry});
    } catch(error) {
        return res.status(500).json({status: 500,status_msg: `Error Fetching Return kit Entry : ${error.message}`});
    }
  }
};
