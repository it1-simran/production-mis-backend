const InventoryModel = require("../models/inventoryManagement");

/**
 * Create the Inventory row for a product if one doesn't already exist.
 * This is the single reusable unit shared by product create/activate and the
 * PO-driven product automation (previously the logic was copy-pasted). Idempotent:
 * uses productType as the natural key so it never duplicates an inventory row.
 *
 * @param {{_id:any, name:string}} product
 * @param {{id?:any, department?:string}} [user]
 * @returns the (existing or newly created) inventory document
 */
async function createInventoryForProduct(product, user = {}) {
  if (!product || !product._id) {
    throw new Error("createInventoryForProduct requires a saved product");
  }
  return InventoryModel.findOneAndUpdate(
    { productType: product._id },
    {
      $setOnInsert: {
        productName: product.name,
        productType: product._id,
        createdBy: user.id || null,
        department: user.department || "",
      },
    },
    { upsert: true, new: true }
  );
}

module.exports = { createInventoryForProduct };
