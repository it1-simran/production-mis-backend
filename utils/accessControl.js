const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(process.cwd(), "debug_access.log");
const logToFile = (msg) => {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
};

/**
 * Generates a database filter object based on the user's role and identity.
 * Admin users get an empty filter (access all).
 * Non-admin users are restricted by department or their own createdBy identity.
 * 
 * @param {Object} req - The Express request object containing the user context.
 * @param {Object} options - Configuration for the filter.
 * @param {string} options.createdByField - The field name for the creator ID (default: "createdBy").
 * @param {string} options.departmentField - The field name for the department (default: "department").
 * @returns {Object} The filter object for MongoDB queries.
 */
const getDataAccessFilter = (req, options = {}) => {
  const { createdByField = "createdBy", departmentField = "department" } = options;
  const userRole = (req.user?.userType || "").toLowerCase().replace(/[\s-]+/g, "_");
  
  logToFile(`>>> [ACCESS_CONTROL] userRole: "${userRole}", department: "${req.user?.department}", id: "${req.user?.id}"`);

  // Admin, Production Manager, and Store Manager always have full access
  if (
    userRole === "admin" || 
    userRole === "administrator" || 
    userRole === "production_manager" ||
    userRole === "store_manager" ||
    userRole === "store_manger" ||
    userRole === "store"
  ) {
    logToFile(`>>> [ACCESS_CONTROL] Full access granted for role: ${userRole}`);
    return {};
  }

  const filter = {};

  // Apply department filter if present, otherwise fallback to createdBy
  if (req.user?.department) {
    filter[departmentField] = req.user.department;
  } else if (req.user?.id) {
    filter[createdByField] = new mongoose.Types.ObjectId(req.user.id);
  }

  logToFile(`>>> [ACCESS_CONTROL] Generated filter: ${JSON.stringify(filter)}`);
  return filter;
};

module.exports = {
  getDataAccessFilter,
};
