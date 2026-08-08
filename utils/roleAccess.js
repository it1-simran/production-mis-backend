/**
 * Single source of truth for the "full access" role-name bypass list and the
 * key-normalization rule used everywhere a permission/module label or a
 * userType string is turned into a Map key. Previously duplicated (with drift —
 * one copy was missing "operator", two others were missing "administrator")
 * across authController.js, accessControl.js, and userRolesController.js.
 */
const FULL_ACCESS_ROLES = new Set([
  "admin",
  "administrator",
  "production_manager",
  "store_manager",
  "store_manger",
  "store",
  "operator",
]);

function normalizeUserTypeKey(userType) {
  return String(userType || "").toLowerCase().replace(/[\s-]+/g, "_");
}

function isFullAccessRole(userType) {
  return FULL_ACCESS_ROLES.has(normalizeUserTypeKey(userType));
}

module.exports = { FULL_ACCESS_ROLES, normalizeUserTypeKey, isFullAccessRole };
