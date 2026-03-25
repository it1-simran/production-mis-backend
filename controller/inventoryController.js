const mongoose = require("mongoose");
const InventoryModel = require("../models/inventoryManagement");
const ProcessModel = require("../models/process");
const ProductModel = require("../models/Products");

const toPositiveInt = (value) => Math.max(parseInt(value, 10) || 0, 0);

const deriveCartonsFromQuantity = (quantity, maxCapacity) => {
  const qty = toPositiveInt(quantity);
  const capacity = toPositiveInt(maxCapacity);
  if (!qty || !capacity) return 0;
  return Math.ceil(qty / capacity);
};

const getPackagingDataByProductId = async (productId) => {
  if (!mongoose.Types.ObjectId.isValid(productId)) return null;
  const product = await ProductModel.findById(productId).select("stages").lean();
  if (!product) return null;

  const packagingStep = (product.stages || [])
    .flatMap((stage) => stage.subSteps || [])
    .find((step) => step?.isPackagingStatus);

  return packagingStep?.packagingData || null;
};

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
      const data = { ...req.body };
      const quantity = toPositiveInt(data.quantity);
      const packagingData = await getPackagingDataByProductId(data.productType);
      data.quantity = quantity;
      data.cartonQuantity = deriveCartonsFromQuantity(quantity, packagingData?.maxCapacity);
      data.status = quantity > 0 ? "In Stock" : "Out of Stock";
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
      console.error("Error fetching Inventory details:", e);
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
      const processInventory = data
        .filter(
          (item) =>
            item?.status === "Waiting_Kits_allocation" ||
            item?.status === "Waiting_Kits_approval" ||
            item?.status === "active" ||
            item?.kitStatus === "partially_issued"
        )
        .map((item) => {
          const packStep = item?.productDetails?.stages
            ?.flatMap((stage) => stage?.subSteps || [])
            ?.find((step) => step?.isPackagingStatus);
          const cartonCapacity = toPositiveInt(packStep?.packagingData?.maxCapacity);
          const cartonsNeeded = deriveCartonsFromQuantity(item?.processQuantity, cartonCapacity);
          const cartonsAllocated = toPositiveInt(item?.issuedCartons);
          const cartonShortage = Math.max(0, cartonsNeeded - cartonsAllocated);

          return {
            ...item,
            cartonCapacity,
            cartonsNeeded,
            cartonsAllocated,
            cartonShortage,
            cartonAllocationStatus:
              cartonCapacity === 0
                ? "No Packaging Spec"
                : cartonShortage > 0
                  ? "Carton Allocation Pending"
                  : "Carton Auto Allocated",
          };
        });

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
      const inventory = await InventoryModel.findById(id).lean();
      if (!inventory) {
        return res.status(404).json({ message: "Inventory not found" });
      }

      const quantity = toPositiveInt(req?.body?.quantity);
      const packagingData = await getPackagingDataByProductId(inventory.productType);
      const updateInventory = {
        quantity,
        cartonQuantity: deriveCartonsFromQuantity(quantity, packagingData?.maxCapacity),
        status: quantity > 0 ? "In Stock" : "Out of Stock",
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
      return res.status(410).json({
        status: 410,
        status_msg: "Carton allocation is now auto-derived from product packaging and issued kits.",
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getInventoryTrends: async (req, res) => {
    try {
      const days = Math.max(parseInt(req.query.days, 10) || 14, 1);
      const threshold = Math.max(parseInt(req.query.threshold, 10) || 10, 0);
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      start.setHours(0, 0, 0, 0);

      const movement = await InventoryModel.aggregate([
        { $match: { updatedAt: { $gte: start } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$updatedAt" } },
            kits: { $sum: "$quantity" },
            cartons: { $sum: "$cartonQuantity" },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const movementMap = movement.reduce((acc, row) => {
        acc[row._id] = { kits: row.kits, cartons: row.cartons };
        return acc;
      }, {});

      const categories = [];
      const kitsData = [];
      const cartonsData = [];
      for (let i = 0; i < days; i += 1) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const key = d.toISOString().slice(0, 10);
        categories.push(key);
        kitsData.push(movementMap[key]?.kits || 0);
        cartonsData.push(movementMap[key]?.cartons || 0);
      }

      const stockOverview = await InventoryModel.aggregate([
        {
          $group: {
            _id: "$productName",
            kits: { $sum: "$quantity" },
            cartons: { $sum: "$cartonQuantity" },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const lowStock = await InventoryModel.find({
        quantity: { $lte: threshold },
      })
        .select("productName quantity cartonQuantity status")
        .lean();

      return res.status(200).json({
        status: 200,
        message: "Inventory trends fetched successfully",
        movement: {
          categories,
          series: [
            { name: "Kits", data: kitsData },
            { name: "Cartons", data: cartonsData },
          ],
        },
        stockOverview: {
          categories: stockOverview.map((r) => r._id || "Unknown"),
          series: [
            { name: "Kits", data: stockOverview.map((r) => r.kits || 0) },
            { name: "Cartons", data: stockOverview.map((r) => r.cartons || 0) },
          ],
        },
        alerts: {
          lowStockCount: lowStock.length,
          items: lowStock,
        },
      });
    } catch (error) {
      console.error("Error fetching inventory trends:", error);
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

      const kitQty = toPositiveInt(req?.body?.issuedKits);
      const availableInventoryQty = toPositiveInt(Inventory?.quantity);
      const currentProcessQty = toPositiveInt(process.quantity);
      const currentIssuedKits = toPositiveInt(process.issuedKits);
      const remainingProcessQty = Math.max(0, currentProcessQty - currentIssuedKits);

      if (kitQty <= 0) {
        return res.status(400).json({ status: 400, message: "Issued kits must be greater than zero" });
      }
      if (kitQty > remainingProcessQty) {
        return res.status(400).json({ status: 400, message: "Cannot allocate more kits than required" });
      }
      if (kitQty > availableInventoryQty) {
        return res.status(400).json({ status: 400, message: "Insufficient kit stock" });
      }

      const packagingData = await getPackagingDataByProductId(process.selectedProduct);
      const maxCapacity = toPositiveInt(packagingData?.maxCapacity);
      const nextIssuedKits = currentIssuedKits + kitQty;
      const nextIssuedCartons = deriveCartonsFromQuantity(nextIssuedKits, maxCapacity);
      const remainingInventoryQty = availableInventoryQty - kitQty;
      const updateIssueKit = {
        quantity: remainingInventoryQty,
        cartonQuantity: deriveCartonsFromQuantity(remainingInventoryQty, maxCapacity),
        status: remainingInventoryQty > 0 ? "In Stock" : "Out of Stock",
        updatedAt: new Date(),
      };

      const updatedData = {
        issuedKits: nextIssuedKits,
        issuedCartons: nextIssuedCartons,
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

        continue;
      }
      const accuracy = (physicalCount / systemRecordedCount) * 100;
      totalAccuracy += accuracy;
      itemCount++;
    }
    const overallAccuracy = itemCount > 0 ? totalAccuracy / itemCount : 0;

    return overallAccuracy.toFixed(2);
  } catch (error) {
    console.error(
      "Error calculating overall inventory accuracy:",
      error.message
    );
  }
};
