/**
 * Modules whose users may load process + planning read APIs together (dashboards, calendar,
 * operator fallbacks). Keep in sync with any client-side permission checks that mirror this.
 *
 * Used by: GET /process/view, GET /planing/view, GET /planingAndScheduling/* read routes.
 */
const PROCESS_AND_PLANNING_READ_MODULES = [
  "View Process",
  "Transfer Requests",
  "Kit Transfer",
  "Inventory",
  "FG Store Management",
  "Planning & Scheduling Management",
];

/** GET /device/get/:id — any role that legitimately opens a device from these menus. */
const DEVICE_READ_MODULE_LABELS = [
  "Find Device",
  "Operator Task",
  "Transfer Requests",
  "Repackaging",
  "NG Devices",
  "NG Devices Report",
];

/** RBAC labels for NG portal write flows (OR semantics with `authorize(modules, "update")`). */
const NG_PORTAL_DEVICE_WRITE_MODULE_LABELS = ["Find Device", "NG Devices", "NG Devices Report"];

/**
 * For OR semantics across menu modules, pass the exported arrays into
 * `authController.authorize(LABEL_ARRAY, "read"|"update"|...)` — no extra wrapper required.
 */

module.exports = {
  PROCESS_AND_PLANNING_READ_MODULES,
  DEVICE_READ_MODULE_LABELS,
  NG_PORTAL_DEVICE_WRITE_MODULE_LABELS,
};
