const MODULE_KEYS = require("./moduleKeys");

/**
 * moduleKey -> other moduleKeys it functionally requires READ access to, so a
 * role granted the former doesn't hit an unexpected 403 on an endpoint the
 * latter's page/action quietly depends on.
 *
 * This mirrors OR-array authorize() groups already declared in
 * constants/authorizationModules.js and individual routes.js entries (the
 * fixes for /esim-master/ccid/:ccid, /esim-profile/view,
 * /devices/searchByJigFields, and the Carton/Dispatch/Operator-Work scope
 * gaps) — those backend fallbacks still stand as defense-in-depth, but this
 * registry lets the Configure Permissions editor proactively grant the same
 * access explicitly, so the admin can see and control it instead of relying
 * on an invisible backend OR-array.
 *
 * Consumed by GET /menu/get (returned alongside the menu tree) and by the
 * frontend editor's auto-cascade toggle. Keep both authorize() OR-arrays and
 * this registry in sync when either changes.
 */
const MODULE_DEPENDENCIES = {
  // Jig/device-test flow — a role that can run operator tasks needs these
  // even though they're not the "ESIM Master Data" admin page.
  [MODULE_KEYS.VIEW_TASK]: [
    MODULE_KEYS.ESIM_MASTER_VIEW,
    MODULE_KEYS.ESIM_MASTER_PROFILES,
    MODULE_KEYS.FIND_DEVICE,
  ],

  // Packaging/dispatch operational flows, gated on VIEW_TASK/FG_TO_STORE at
  // the route level so the live workflow was never actually blocked, but an
  // admin explicitly granting Carton/Dispatch access should see the real
  // prerequisite spelled out.
  [MODULE_KEYS.CARTON_MANAGEMENT]: [MODULE_KEYS.VIEW_TASK],
  [MODULE_KEYS.DISPATCH_MANAGEMENT]: [MODULE_KEYS.VIEW_TASK, MODULE_KEYS.FG_TO_STORE],

  // "Generate Serials" (viewPlaning page) opens this page's route.
  [MODULE_KEYS.ADD_MULTIPLE_DEVICES]: [MODULE_KEYS.VIEW_TASK],

  // Process/Planning read APIs are shared across these modules' pages
  // (PROCESS_AND_PLANNING_READ_MODULES in authorizationModules.js).
  [MODULE_KEYS.OPERATOR_ASSIGNMENT]: [MODULE_KEYS.VIEW_PROCESS],
  [MODULE_KEYS.PLANNING_SCHEDULING_MANAGEMENT]: [MODULE_KEYS.VIEW_PROCESS],
  [MODULE_KEYS.VIEW_PLANNING_SCHEDULING]: [MODULE_KEYS.VIEW_PROCESS],
  [MODULE_KEYS.KIT_TRANSFER]: [MODULE_KEYS.VIEW_PROCESS],
  [MODULE_KEYS.TRANSFER_REQUESTS]: [MODULE_KEYS.VIEW_PROCESS],
  [MODULE_KEYS.FG_TO_STORE]: [MODULE_KEYS.VIEW_PROCESS],

  // Device read APIs shared across these (DEVICE_READ_MODULE_LABELS).
  [MODULE_KEYS.REPACKAGING]: [MODULE_KEYS.FIND_DEVICE],
  [MODULE_KEYS.NG_DEVICES_VIEW]: [MODULE_KEYS.FIND_DEVICE],
  [MODULE_KEYS.NG_DEVICES_REPORT]: [MODULE_KEYS.FIND_DEVICE],
};

module.exports = MODULE_DEPENDENCIES;
