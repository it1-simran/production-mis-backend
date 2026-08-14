const MODULE_KEYS = require("./moduleKeys");

/**
 * moduleKey -> other moduleKeys it functionally requires access to, so a role
 * granted the former doesn't hit an unexpected 403 on an endpoint the
 * latter's page/action quietly depends on.
 *
 * Each dependency entry is either a plain moduleKey string (implies the
 * default action "read" — covers the vast majority of cases, like a shared
 * read-only lookup endpoint) or `{ moduleKey, action }` when the dependency
 * needs a stronger action (e.g. "create", because the dependent route itself
 * requires create, not just read, on the prerequisite module).
 *
 * This mirrors OR-array authorize() groups already declared in
 * constants/authorizationModules.js and individual routes.js entries (the
 * fixes for /esim-master/ccid/:ccid, /esim-profile/view,
 * /devices/searchByJigFields, and /devices/create) — those backend fallbacks
 * still stand as defense-in-depth, but this registry lets the Configure
 * Permissions editor proactively grant the same access explicitly, so the
 * admin can see and control it instead of relying on an invisible backend
 * OR-array.
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

  // "Add Multiple Devices" (device/addDevices) and "Generate Serials"
  // (device/generate-serials) both gate their own page on ADD_MULTIPLE_DEVICES,
  // but the actual save (createDevice -> POST /devices/create) is backend-gated
  // on FIND_DEVICE create — see routes/api.js:283. Needs "create", not "read".
  [MODULE_KEYS.ADD_MULTIPLE_DEVICES]: [
    { moduleKey: MODULE_KEYS.FIND_DEVICE, action: "create" },
  ],

  // NOTE: CARTON_MANAGEMENT and DISPATCH_MANAGEMENT are fully orphaned keys —
  // no menu entry, no frontend page, no authorize() call anywhere in the app.
  // Deliberately no entries for them here until those modules actually exist;
  // an entry pointing at a key nothing can grant or check is dead weight.

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
