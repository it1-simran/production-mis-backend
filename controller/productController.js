const mongoose = require("mongoose");
const { getUnscopedAuthorizedReadListFilter } = require("../utils/accessControl");
const Product = require("../models/Products");
const InventoryModel = require("../models/inventoryManagement");


const ProductCategory = require("../models/productCategory");
const Carton = require('../models/cartonManagement');
module.exports = {
  create: async (req, res) => {
    try {
      const name = req.body.name;
      const stages = JSON.parse(req.body.Products || "[]");
      const commonStages = JSON.parse(req.body.commonStages || "[]");
      const bodyStatus = String(req.body.status || req.body.productStatus || "").toLowerCase();
      const isDraft = String(req.body.isDraft || "").toLowerCase() === "true" || bodyStatus === "draft";

      if (!name || (!isDraft && (!stages || !stages.length))) {
        return res.status(400).json({
          status: 400,
          message: "Product Name and Products are required",
        });
      }

      if (!isDraft) {
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
              if (!subStep.stepFields) {
                subStep.stepFields = {};
              }
            }
          }
        }
      }

        const newProduct = new Product({
          name,
          stages,
          commonStages,
          status: isDraft ? "draft" : "active",
          createdBy: req.user?.id,
          department: req.user?.department || "",
          autoNgEnabled: !!req.body.autoNgEnabled,
        });

      const productCategory = req.body.productCategory || req.body.category;
      if (productCategory) {
        const catDoc = await ProductCategory.findById(productCategory);
        if (catDoc && (String(catDoc.status) === "0" || String(catDoc.status).toLowerCase() === "inactive")) {
          return res.status(400).json({
            status: 400,
            message: "Cannot assign product to an inactive Product Category.",
          });
        }
      }

      const savedProduct = await newProduct.save();
      if (savedProduct && productCategory) {
        await ProductCategory.updateOne(
          { _id: productCategory },
          { $addToSet: { products: savedProduct._id } }
        );
      }
      if (savedProduct && savedProduct.status !== "draft") {
        const InventoryData = {
          productName: name,
          productType: savedProduct._id,
          createdBy: req.user?.id,
          department: req.user?.department || "",
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
      const filter = getUnscopedAuthorizedReadListFilter();
      const Products = await Product.find(filter).sort({ _id: -1 }).lean();

      // Attach Product Category information (only active categories)
      await ProductCategory.updateMany(
        { status: { $in: ["0", "inactive"] } },
        { $set: { products: [] } }
      );
      const categories = await ProductCategory.find({ status: { $nin: ["0", "inactive"] } }).lean();
      const productCategoryMap = {};
      categories.forEach((cat) => {
        if (Array.isArray(cat.products)) {
          cat.products.forEach((pId) => {
            const pIdStr = String(pId._id || pId);
            productCategoryMap[pIdStr] = {
              _id: String(cat._id),
              name: cat.name,
              status: cat.status,
            };
          });
        }
      });

      const ProductsWithCategory = Products.map((p) => {
        const catInfo = productCategoryMap[String(p._id)];
        return {
          ...p,
          category: catInfo || null,
          categoryName: catInfo ? catInfo.name : "",
        };
      });

      return res.status(200).json({
        status: 200,
        status_msg: "Products Fetched Sucessfully!!",
        Products: ProductsWithCategory,
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
      await InventoryModel.deleteMany({ productType: product._id });
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
      const product = await Product.findById(id).lean();
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
        const categoryDoc = await ProductCategory.findOne({ products: id, status: { $nin: ["0", "inactive"] } }).lean();
        if (categoryDoc) {
          product.category = {
            _id: String(categoryDoc._id),
            name: categoryDoc.name,
          };
          product.productCategory = String(categoryDoc._id);
          product.categoryName = categoryDoc.name;
        }

        let inventory = await InventoryModel.findOne({ productType: product._id }).lean();
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
      const autoNgEnabled = req.body.autoNgEnabled === "true" || req.body.autoNgEnabled === true;
      const productCategory = req.body.productCategory || req.body.category || "";
      if (productCategory) {
        const catDoc = await ProductCategory.findById(productCategory);
        if (catDoc && (String(catDoc.status) === "0" || String(catDoc.status).toLowerCase() === "inactive")) {
          return res.status(400).json({
            status: 400,
            message: "Cannot assign product to an inactive Product Category.",
          });
        }
      }

      const updatedData = { name: req.body.name, stages, commonStages, autoNgEnabled };

      const updatedProduct = await Product.findByIdAndUpdate(id, updatedData, {
        new: true,
        runValidators: true,
      });

      if (!updatedProduct) {
        return res.status(404).json({ message: "Product not found" });
      }

      // Sync category mapping
      await ProductCategory.updateMany({ products: id }, { $pull: { products: id } });
      if (productCategory) {
        await ProductCategory.updateOne(
          { _id: productCategory },
          { $addToSet: { products: id } }
        );
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
  activate: async (req, res) => {
    try {
      const id = req.params.id;
      const product = await Product.findById(id);
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }

      if (String(product.status || "active").toLowerCase() !== "active") {
        product.status = "active";
        await product.save();
      }

      await InventoryModel.findOneAndUpdate(
        { productType: product._id },
        { $setOnInsert: { productName: product.name, productType: product._id } },
        { upsert: true, new: true }
      );

      return res.status(200).json({
        status: 200,
        message: "Product activated successfully",
        product,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
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
      await InventoryModel.deleteMany({ productType: { $in: objectIds } });
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
