const ProductCategory = require("../models/productCategory");

module.exports = {
  create: async (req, res) => {
    try {
      let { id, name, products, status } = req.body;
      name = String(name || "").trim();
      status = String(status || "1").trim();
      const productIds = Array.isArray(products) ? products : [];

      if (!name) {
        return res.status(400).json({
          status: 400,
          message: "Category Name is required.",
        });
      }

      const isInactive = status === "0" || String(status).toLowerCase() === "inactive";
      if (isInactive && productIds.length > 0) {
        return res.status(400).json({
          status: 400,
          message: "Products cannot be assigned to an inactive Product Category.",
        });
      }

      const finalProductIds = isInactive ? [] : productIds;

      if (id) {
        const existingCategory = await ProductCategory.findById(id);
        if (!existingCategory) {
          return res.status(404).json({ status: 404, message: "Product Category not found." });
        }
        existingCategory.name = name;
        existingCategory.products = finalProductIds;
        existingCategory.status = status;
        existingCategory.updatedAt = Date.now();

        await existingCategory.save();
        const populatedCategory = await ProductCategory.findById(id).populate("products", "name status").lean();
        return res.status(200).json({
          status: 200,
          message: "Product Category updated successfully!",
          productCategory: populatedCategory,
        });
      } else {
        const newCategory = new ProductCategory({
          name,
          products: finalProductIds,
          status: status || "1",
          createdBy: req.user?.id || null,
        });
        const savedCategory = await newCategory.save();
        const populatedCategory = await ProductCategory.findById(savedCategory._id).populate("products", "name status").lean();
        return res.status(200).json({
          status: 200,
          message: "Product Category created successfully!",
          productCategory: populatedCategory,
        });
      }
    } catch (error) {
      console.error("Error in createProductCategory:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  view: async (req, res) => {
    try {
      await ProductCategory.updateMany(
        { status: { $in: ["0", "inactive"] } },
        { $set: { products: [] } }
      );

      const productCategories = await ProductCategory.find()
        .populate("products", "name status")
        .sort({ _id: -1 })
        .lean();

      const sanitizedCategories = productCategories.map((cat) => {
        const isInactive = String(cat.status) === "0" || String(cat.status).toLowerCase() === "inactive";
        return {
          ...cat,
          products: isInactive ? [] : (cat.products || []),
        };
      });

      return res.status(200).json({
        status: 200,
        message: "Product Categories fetched successfully!",
        productCategories: sanitizedCategories,
      });
    } catch (error) {
      console.error("Error in viewProductCategory:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  delete: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await ProductCategory.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ status: 404, message: "Product Category not found." });
      }
      return res.status(200).json({
        status: 200,
        message: "Product Category deleted successfully!",
        deleted,
      });
    } catch (error) {
      console.error("Error in deleteProductCategory:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },

  deleteMultiple: async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ status: 400, message: "Category IDs array is required." });
      }
      const result = await ProductCategory.deleteMany({ _id: { $in: ids } });
      return res.status(200).json({
        status: 200,
        message: `${result.deletedCount} Product Category(ies) deleted successfully!`,
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      console.error("Error in deleteMultipleProductCategories:", error);
      return res.status(500).json({ status: 500, message: "Internal server error", error: error.message });
    }
  },
};
