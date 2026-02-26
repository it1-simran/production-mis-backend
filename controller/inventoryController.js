const mongoose = require("mongoose");
const InventoryModel = require("../models/inventoryManagement");
const ProcessModel = require("../models/process");
const ProductModel = require("../models/Products");

module.exports = {
  dashboard: async (req, res) => {
    try {
      processCount = await ProcessModel.countDocuments({});
      productCount = await ProductModel.countDocuments({});
      productWiseQuantity = await ProcessModel.aggregate([
        {
          $lookup: {
            from: "products",
            localField: "selectedProduct",
            foreignField: "_id",
            as: "productDetails",
          },
        },
        {
          $unwind: "$productDetails",
        },
      ]);
      const quantityByProduct = productWiseQuantity.reduce((acc, item) => {
        const productId = item.selectedProduct;
        const quantity = parseInt(item.quantity);
        if (acc[productId]) {
          acc[productId] += quantity;
        } else {
          acc[productId] = quantity;
        }
        return acc;
      }, {});
      let overallInventoryAccuracy = await calculateOverallInventoryAccuracy(
        quantityByProduct
      );
      const inventoryDashboard = {
        processCount,
        productCount,
        overallInventoryAccuracy,
      };
      return res.status(200).json({
        status: 200,
        status_msg: "Data Fetched Sucessfully!!",
        inventoryDashboard,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "An error occurred while creating the Dashboard.",
        error: error.message,
      });
    }
  },
  create: async (req, res) => {
    try {
      const data = req.body;
      const newInventoryModel = new InventoryModel(data);
      await newInventoryModel.save();
      return res.status(201).json({
        status: 200,
        message: "Inventory created successfully!",
        newInventoryModel,
      });
    } catch (error) {
      console.error("Error creating Inventory:", error);
      return res.status(500).json({
        status: 500,
        message: "An error occurred while creating the Inventory.",
        error: error.message,
      });
    }
  },
  view: async (req, res) => {
    try {
      const Inventory = await InventoryModel.find();
      return res.status(200).json({
        status: 200,
        status_msg: "Inventory Fetched Sucessfully!!",
        Inventory,
      });
    } catch (e) {
      console.error("Error fetching Inventory details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  getProcessInventory: async (req, res) => {
    try {
      const data = await ProcessModel.aggregate([
        {
          $lookup: {
            from: "inventories",
            localField: "selectedProduct",
            foreignField: "productType",
            as: "inventoryProcess",
          },
        },
        { $unwind: { path: "$inventoryProcess", preserveNullAndEmptyArrays: true } },
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
          $project: {
            _id: 1,
            name: 1,
            processID: 1,
            orderConfirmationNo: 1,
            processQuantity: "$quantity",
            inventoryQuantity: { $ifNull: ["$inventoryProcess.quantity", 0] },
            cartonQuantity: { $ifNull: ["$inventoryProcess.cartonQuantity", 0] },
            inventoryStatus: "$inventoryProcess.status",
            productName: "$productDetails.name",
            fgToStore: 1,
            issuedKits: 1,
            issuedCartons: 1,
            createdAt: 1,
            updatedAt: 1,
            status: 1,
            kitStatus: 1,
            productDetails: 1,
          },
        },
      ]);
      const processInventory = data.filter(
        (item) =>
          item?.status === "Waiting_Kits_allocation" ||
          item?.status === "Waiting_Kits_approval" ||
          item?.status === "active" ||
          item?.kitStatus === "partially_issued"
      );

      return res.status(200).json({
        status: 200,
        status_msg: "Processes Inventories Fetched Sucessfully!!",
        processInventory,
      });
    } catch (error) {
      console.error("Error Fetching Process Inventory", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  updateInventoryQuantity: async (req, res) => {
    try {
      const id = req.params.id;
      if (!mongoose.isValidObjectId(id)) {
        return res
          .status(400)
          .json({ status: 400, message: "Invalid ID format" });
      }
      const updateInventory = {
        quantity: req?.body?.quantity,
        cartonQuantity: req?.body?.cartonQuantity,
        status: req?.body?.status,
        updatedAt: new Date(),
      };
      const update = await InventoryModel.findByIdAndUpdate(
        id,
        updateInventory,
        {
          new: true,
          runValidators: true,
        }
      );
      if (!update) {
        return res.status(404).json({ message: "Inventory not found" });
      }
      return res.status(200).json({
        status: 200,
        message: "Inventory updated successfully",
        shift: update,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getProcessByProductID: async (req, res) => {
    try {
      const ProcessByProductID = await ProcessModel.find({
        selectedProduct: req.params.id,
      });
      return res.status(200).json({
        status: 200,
        status_msg: "Processes Fetched Sucessfully!!",
        ProcessByProductID,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateCarton: async (req, res) => {
    try {
      const id = req?.body?.process;
      const process = await ProcessModel.findById(req.body.process);
      if (!process) {
        return res.status(404).json({ status: 404, message: "Process not found" });
      }

      let Inventory = await InventoryModel.findOne({
        productType: process?.selectedProduct,
      });

      if (!Inventory) {
        Inventory = new InventoryModel({
          productName: process.productName || "Unknown",
          productType: process.selectedProduct,
          quantity: 0,
          cartonQuantity: 0,
          status: "Out of Stock",
        });
        await Inventory.save();
      }

      const issueQty = parseInt(req?.body?.issueCartonProcess) || 0;
      const updateIssueCarton = {
        quantity: (Inventory?.quantity || 0) - issueQty,
        updatedAt: new Date(),
      };

      const updatedData = {
        issuedCartons: (process?.issuedCartons || 0) + issueQty,
        updatedAt: new Date(),
      };

      await InventoryModel.findByIdAndUpdate(Inventory._id, updateIssueCarton);
      const updatedProcess = await ProcessModel.findByIdAndUpdate(id, updatedData, {
        new: true,
        runValidators: true,
      });
      return res.status(200).json({
        status: 200,
        status_msg: "Carton Updated Sucessfully!!",
        updatedProcess,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateIssueKit: async (req, res) => {
    try {
      const id = req?.body?.process;
      const process = await ProcessModel.findById(req.body.process);
      if (!process) {
        return res.status(404).json({ status: 404, message: "Process not found" });
      }

      let Inventory = await InventoryModel.findOne({
        productType: process?.selectedProduct,
      });

      if (!Inventory) {
        Inventory = new InventoryModel({
          productName: process.productName || "Unknown",
          productType: process.selectedProduct,
          quantity: 0,
          cartonQuantity: 0,
          status: "Out of Stock",
        });
        await Inventory.save();
      }

      const kitQty = parseInt(req?.body?.issuedKits) || 0;
      const updateIssueKit = {
        quantity: (Inventory?.quantity || 0) - kitQty,
        updatedAt: new Date(),
      };

      const updatedData = {
        issuedKits: (process.issuedKits || 0) + kitQty,
        kitStatus: req?.body?.kitStatus,
        status: req?.body?.status,
        updatedAt: new Date(),
      };

      await InventoryModel.findByIdAndUpdate(Inventory._id, updateIssueKit);
      const updatedProcess = await ProcessModel.findByIdAndUpdate(id, updatedData, {
        new: true,
        runValidators: true,
      });
      return res.status(200).json({
        status: 200,
        status_msg: "Updated Process Sucessfully!!",
        updatedProcess,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};

const calculateOverallInventoryAccuracy = async (physicalCounts) => {
  try {
    const inventories = await InventoryModel.find();
    if (inventories.length === 0) {
      console.log("No inventory data found.");
      return 0;
    }

    let totalAccuracy = 0;
    let itemCount = 0;

    for (let i = 0; i < inventories.length; i++) {
      const inventory = inventories[i];
      const systemRecordedCount = inventory.quantity;
      const physicalCount =
        physicalCounts[inventory.productType.toString()] || 0;
      if (systemRecordedCount === 0) {
        console.log(`Skipping ${inventory.name} (No stock available)`);
        continue;
      }
      const accuracy = (physicalCount / systemRecordedCount) * 100;
      totalAccuracy += accuracy;
      itemCount++;
    }
    const overallAccuracy = itemCount > 0 ? totalAccuracy / itemCount : 0;
    console.log(`Overall Inventory Accuracy: ${overallAccuracy.toFixed(2)}%`);
    return overallAccuracy.toFixed(2);
  } catch (error) {
    console.error(
      "Error calculating overall inventory accuracy:",
      error.message
    );
  }
};
