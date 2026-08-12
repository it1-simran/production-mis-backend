/**
 * Consolidated role-bypass lists for authController.js. Previously each of
 * the three authorizers below declared its own inline Set, independently —
 * two different security postures existed by accident (general authorize()
 * was narrowed to admin-only, but these two device-write authorizers still
 * granted a wider set of roles unrestricted access, with no shared source).
 * This file makes the exception intentional and single-sourced.
 */

/** authController.authorize() / authorizeProcessUpdate — blanket bypass. */
const ADMIN_ONLY_BYPASS = new Set(["admin", "administrator"]);

/**
 * authController.evaluateNgPortalDeviceWrite() / authorizeUpdateStageByDeviceId
 * — deliberately wider than ADMIN_ONLY_BYPASS for the live device-test/NG-mark
 * write flow (production_manager / store variants / operator need unrestricted device
 * writes on the floor). Kept as its own list rather than reusing
 * ADMIN_ONLY_BYPASS — narrowing it would be a behavior change, not a
 * refactor.
 */
const DEVICE_WRITE_BYPASS = new Set([
  "admin",
  "production_manager",
  "store_manager",
  "store_manger",
  "store",
  "operator",
]);

module.exports = { ADMIN_ONLY_BYPASS, DEVICE_WRITE_BYPASS };
