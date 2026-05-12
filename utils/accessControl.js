const mongoose = require("mongoose");

/**
 * Generates a database filter object based on the user's role and identity.
 * Admin users get an empty filter (access all).
 * Non-admin users are restricted by department or their own createdBy identity.
 */
const getDataAccessFilter = (req, options = {}) => {
  const { createdByField = "createdBy", departmentField = "department" } = options;
  const userRole = (req.user?.userType || "").toLowerCase().replace(/[\s-]+/g, "_");

  if (
    userRole === "admin" ||
    userRole === "administrator" ||
    userRole === "production_manager" ||
    userRole === "store_manager" ||
    userRole === "store_manger" ||
    userRole === "store"
  ) {
    return {};
  }

  const filter = {};

  if (req.user?.department) {
    filter[departmentField] = req.user.department;
  } else if (req.user?.id) {
    filter[createdByField] = new mongoose.Types.ObjectId(req.user.id);
  }

  return filter;
};

/**
 * For GET list routes already protected by `authorize(..., "read")` (User Roles RBAC).
 * Do not merge legacy department/createdBy scoping here: roles such as Engineering with
 * only `view_process` would otherwise see zero rows while the page is "allowed".
 *
 * Controllers / handlers that merge this with route-specific predicates only (catalog reads):
 * - processController: view, getProcessesByProductId
 * - productController: view
 * - planningAndSchedulingController: view, getPlaningAnDschedulingByProcessId,
 *   getPlanInsights, fetchAllPlaningModel, getPlaningAndSchedulingDateWise ($match)
 * - inventoryController: view, getProcessInventory
 *
 * Do not use for user-owned lists (e.g. kit transfer requests by requesterId); those keep
 * getDataAccessFilter or dedicated query builders.
 *
 * Frontend smoke (non-PM role with View Product + View Process + Planning/Inventory read):
 * - Product edit Clone-into-Process, device add/generate serial: viewProcessByProductId
 * - Planning add/edit/viewPlaning and operator task fallbacks: viewProcess, viewPlaning,
 *   getPlaningAndSchedulingById, getPlaningAndSchedulingByProcessId, getPlaningAndSchedulingModel
 * - Inventory list and process-inventory grid: GET /inventory/view, /inventory/process/get
 */
const getUnscopedAuthorizedReadListFilter = () => ({});

module.exports = {
  getDataAccessFilter,
  getUnscopedAuthorizedReadListFilter,
};
