const ProductCategory = require("../models/productCategory");

// Fetch GPSCPANEL device categories via the shared-key integration proxy.
async function fetchCpanelDeviceCategories() {
  const base = (process.env.CPANEL_API_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("CPANEL_API_URL not configured");
  const r = await fetch(base + "/api/integrations/mes/device-categories", {
    headers: { "x-api-key": process.env.CPANEL_API_KEY || "" },
  });
  if (!r.ok) throw new Error(`CPanel responded ${r.status}`);
  const body = await r.json();
  return Array.isArray(body?.data) ? body.data : [];
}

module.exports = {
  /**
   * Sync GPSCPANEL device categories into MES Product Categories.
   * Matches by deviceCategoryId (then adopts an existing same-named category),
   * setting name + deviceCategoryId so PO→product automation resolves correctly.
   */
  syncFromCpanel: async (req, res) => {
    try {
      const cats = await fetchCpanelDeviceCategories();
      let created = 0, updated = 0;
      for (const c of cats) {
        const devId = Number(c.id);
        const name = String(c.name || "").trim();
        if (!devId || !name) continue;

        let cat = await ProductCategory.findOne({ deviceCategoryId: devId });
        if (!cat) cat = await ProductCategory.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });

        if (cat) {
          cat.name = name;
          cat.deviceCategoryId = devId;
          cat.updatedAt = Date.now();
          await cat.save();
          updated++;
        } else {
          await new ProductCategory({ name, deviceCategoryId: devId, status: "1", createdBy: req.user?.id || null }).save();
          created++;
        }
      }
      return res.status(200).json({ status: 200, message: `Synced ${cats.length} device categories (${created} created, ${updated} updated).`, created, updated, total: cats.length });
    } catch (error) {
      console.error("productCategory syncFromCpanel error:", error);
      return res.status(502).json({ status: 502, message: "Could not sync from GPSCPANEL.", error: error.message });
    }
  },

  create: async (req, res) => {
    try {
      let { id, name, products, status, testingPlan, deviceCategoryId } = req.body;
      name = String(name || "").trim();
      status = String(status || "1").trim();
      const productIds = Array.isArray(products) ? products : [];
      const plan = Array.isArray(testingPlan) ? testingPlan : undefined;
      const devCatId = (deviceCategoryId === "" || deviceCategoryId == null) ? null : Number(deviceCategoryId);

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
        if (plan !== undefined) existingCategory.testingPlan = plan;
        if (deviceCategoryId !== undefined) existingCategory.deviceCategoryId = devCatId;
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
          testingPlan: plan || [],
          deviceCategoryId: devCatId,
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
