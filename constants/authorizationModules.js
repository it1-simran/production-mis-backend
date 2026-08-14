const MODULE_KEYS = require("./moduleKeys");

/**
 * Modules whose users may load process + planning read APIs together (dashboards, calendar,
 * operator fallbacks). Keep in sync with any client-side permission checks that mirror this.
 *
 * VIEW_PLANNING_SCHEDULING is included alongside its parent PLANNING_SCHEDULING_MANAGEMENT
 * because the frontend page guards/usePermission calls for this feature all key off the child
 * — a role granted only the child (the common case) must still pass here.
 *
 * Used by: GET /process/view, GET /planing/view, GET /planingAndScheduling/* read routes.
 */
const PROCESS_AND_PLANNING_READ_MODULES = [
  MODULE_KEYS.VIEW_PROCESS,
  MODULE_KEYS.TRANSFER_REQUESTS,
  MODULE_KEYS.KIT_TRANSFER,
  MODULE_KEYS.INVENTORY_STORE,
  MODULE_KEYS.FG_TO_STORE,
  MODULE_KEYS.PLANNING_SCHEDULING_MANAGEMENT,
  MODULE_KEYS.VIEW_PLANNING_SCHEDULING,
  // NG Devices list page looks up process names via this same read path.
  MODULE_KEYS.NG_DEVICES,
  MODULE_KEYS.NG_DEVICES_VIEW,
  // Operator Assignment page's process dropdown uses this same read path too.
  MODULE_KEYS.OPERATOR_ASSIGNMENT,
  // CCID Transfer / CCID Transfer Requests pages' process dropdown/list uses
  // this same read path too.
  MODULE_KEYS.ESIM_REMOVAL,
  MODULE_KEYS.ESIM_REMOVAL_REQUESTS,
];

/**
 * GET /device/get/:id — any role that legitimately opens a device from these
 * menus. Includes both NG_DEVICES (parent) and NG_DEVICES_VIEW (child) since
 * a role granted only the child (the common case — that's what the NG
 * Devices menu's nested "View NG Devices" row actually sets) must still pass.
 */
const DEVICE_READ_MODULE_LABELS = [
  MODULE_KEYS.FIND_DEVICE,
  MODULE_KEYS.VIEW_TASK,
  MODULE_KEYS.TRANSFER_REQUESTS,
  MODULE_KEYS.REPACKAGING,
  MODULE_KEYS.NG_DEVICES,
  MODULE_KEYS.NG_DEVICES_VIEW,
  MODULE_KEYS.NG_DEVICES_REPORT,
  // FG Store Management page opens devices from its carton cards via this
  // same read path too.
  MODULE_KEYS.FG_TO_STORE,
];

/** RBAC labels for NG portal write flows (OR semantics with `authorize(modules, "update")`). */
const NG_PORTAL_DEVICE_WRITE_MODULE_LABELS = [
  MODULE_KEYS.FIND_DEVICE,
  MODULE_KEYS.NG_DEVICES,
  MODULE_KEYS.NG_DEVICES_VIEW,
  MODULE_KEYS.NG_DEVICES_REPORT,
];

/**
 * For OR semantics across menu modules, pass the exported arrays into
 * `authController.authorize(MODULE_KEY_ARRAY, "read"|"update"|...)` — no extra wrapper required.
 */

module.exports = {
  PROCESS_AND_PLANNING_READ_MODULES,
  DEVICE_READ_MODULE_LABELS,
  NG_PORTAL_DEVICE_WRITE_MODULE_LABELS,
};
