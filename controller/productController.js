const mongoose = require("mongoose");
const Product = require("../models/Products");
const InventoryModel = require("../models/inventoryManagement");


const Carton = require('../models/cartonManagement');
module.exports = {
  create: async (req, res) => {
    try {
      const name = req.body.name;
      const stages = JSON.parse(req.body.Products);
      const commonStages = JSON.parse(req.body.commonStages);
      if (!name || !stages || !stages.length) {
        return res.status(400).json({
          status: 400,
          message: "Product Name and Products are required",
        });
      }

      for (let stage of stages) {
        const { subSteps } = stage;
        for (let subStep of subSteps) {
          const stepType = subStep.stepType;
          if (stepType === "manual") {
            subStep.jigFields = [];
            if (!subStep.stepFields) {
              return res.status(400).json({
                status: 400,
                message: "Substeps are required for manual Product type.",
              });
            }
          } else if (stepType === "jig") {
            subStep.stepFields = {};
          }
        }
      }

      const newProduct = new Product({ name, stages,commonStages });

      const savedProduct = await newProduct.save();
      if(savedProduct) {
        const InventoryData = {
          "productName": name,
          "productType": savedProduct._id,
        };
        const newInventoryModel = new InventoryModel(InventoryData);
        await newInventoryModel.save();
      }
      return res.status(200).json({
        status: 200,
        message: "Product created successfully",
        savedProduct,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  view: async (req, res) => {
    try {
      const Products = await Product.find();
      return res.status(200).json({
        status: 200,
        status_msg: "Products Fetched Sucessfully!!",
        Products,
      });
    } catch (error) {
      console.error("Error fetching Products details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  delete: async (req, res) => {
    try {
      const product = await Product.findByIdAndDelete(req.params.id);
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }
      res
        .status(200)
        .json({ message: "Product deleted successfully", product });
    } catch (error) {
      console.error("Error fetching Product details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  getProductByID: async (req, res) => {
    try {
      const id = req.params.id;
      const product = await Product.findById(id);
      // const product = await Product.aggregate([
      //   {
      //     $match: { _id: ObjectId(id) },
      //   },
      //   {
      //     $lookup: {
      //       from: "assignkitstolines",
      //       localField: "_id",
      //       foreignField: "processId",
      //       as: "processData",
      //     },
      //   },
      //   { $unwind: "$processData"},
      //   {
      //     $project: {
      //       _id: 1,
      //       name:1,
      //       selectedProduct: 1,
      //       orderConfirmationNo: 1,
      //       processID: 1,
      //       quantity: 1,
      //       issuedKits: 1,
      //       issuedCartons: 1,
      //       consumedKits: 1,
      //       consumedCartons: 1,
      //       descripition: 1,
      //       fgToStore:1,
      //       dispatchStatus:1,
      //       deliverStatus:1,
      //       kitStatus:1,
      //       status:1,
      //       processtName: "$planingData.name",
      //     },
      //   },
      // ])
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      if(product){
        let inventory = await InventoryModel.findOne({ productType: product._id });
        return res.status(200).json({product,inventory});
      }
    } catch (error) {
      console.error("Error fetching Product details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  update: async (req, res) => {
    try {
      const id = req.params.id;
      const stages = JSON.parse(req.body.stages);
      const commonStages = JSON.parse(req.body.commonStages);
      const updatedData = { name: req.body.name, stages, commonStages };

      const updatedProduct = await Product.findByIdAndUpdate(id, updatedData, {
        new: true,
        runValidators: true,
      });

      if (!updatedProduct) {
        return res.status(404).json({ message: "Product not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "Product updated successfully",
        product: updatedProduct,
      });
    } catch (error) {
      console.error("Error updating product:", error);
      return res
        .status(500)
        .json({ status: 500, message: "Internal Server Error", error });
    }
  },
  deleteMultiple: async (req, res) => {
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

      const result = await Product.deleteMany({ _id: { $in: objectIds } });
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
  }
};
