/**
 * Stable permission module keys — the canonical identifier for every menu
 * item, decoupled from its display label. Use these instead of literal label
 * strings when calling authController.authorize(...) / hasModuleLabelAction /
 * evaluateNgPortalDeviceWrite, so a future menu-label rename can never again
 * silently break a role's permissions (the root cause behind the ESIM
 * Removal / View Task / Planning & Scheduling 403 bugs).
 *
 * Namespace separator is "__" (double underscore), not ".": UserType.permissions
 * is a Mongoose Map, and Mongoose Maps reject keys containing "." outright.
 *
 * Must stay in sync with the moduleKey values assigned in
 * controller/menuController.js (seed data + auto-migration blocks).
 */

const MODULE_KEYS = {
  DASHBOARD: "dashboard",
  PRODUCTION_CALENDAR: "production_calendar",

  USER_ROLES: "user_role_management__user_roles",
  USER_MANAGEMENT: "user_role_management",
  VIEW_USER: "user_role_management__view_user",
  ADD_USER: "user_role_management__add_user",

  STICKER_MANAGEMENT: "sticker_management",
  STICKER_FIELDS: "sticker_management__fields",
  STICKER_FORMAT_MASTER: "sticker_management__format_master",

  KIT_TRANSFER_MANAGEMENT: "kit_management",
  RETURNED_KITS: "kit_management__returned_kits",
  REMAINING_KITS: "kit_management__remaining_kits",
  KIT_TRANSFER: "kit_management__kit_transfer",
  TRANSFER_REQUESTS: "kit_management__transfer_requests",

  OC_MANAGEMENT: "oc_management",

  PROCESS_MANAGEMENT: "process_management",
  VIEW_PROCESS: "process_management__view",
  ADD_PROCESS: "process_management__add",
  OPERATOR_ASSIGNMENT: "process_management__operator_assignment",
  PLANNING_SCHEDULING_MANAGEMENT: "process_management__planning_scheduling",
  VIEW_PLANNING_SCHEDULING: "process_management__view_planning_scheduling",
  ADD_PLANNING_SCHEDULING: "process_management__add_planning_scheduling",

  JIG_MANAGEMENT: "jig_management",
  JIG_VIEW: "jig_management__view",
  JIG_CATEGORIES: "jig_management__categories",

  DEVICE_MANAGEMENT: "device_management",
  VIEW_IMEI: "device_management__view_imei",
  ADD_MULTIPLE_IMEI: "device_management__add_imei",
  ADD_MULTIPLE_DEVICES: "device_management__add_devices",
  BULK_DELETE_DEVICES: "device_management__bulk_delete",
  DELETION_HISTORY: "device_management__deletion_history",
  FIND_DEVICE: "device_management__find_device",

  ROOM_MANAGEMENT: "room_management",
  VIEW_ROOMS: "room_management__view",
  ADD_ROOM: "room_management__add",

  INVENTORY_STORE: "inventory_store",
  VIEW_PRODUCT_INVENTORY: "inventory_store__view_product",
  VIEW_PROCESS_INVENTORY: "inventory_store__view_process",
  FG_TO_STORE: "inventory_store__fg_to_store",
  STORE_PORTAL: "inventory_store__store_portal",

  TASK_WORKFORCE: "task_workforce",
  VIEW_TASK: "task_workforce__view_task",
  REPACKAGING: "task_workforce__repackaging",

  PRODUCT_MANAGEMENT: "product_management",
  VIEW_PRODUCT: "product_management__view",
  ADD_PRODUCT: "product_management__add",
  PRODUCT_CATEGORY: "product_management__category",

  SHIFT_MANAGEMENT: "shift_management",
  HOLIDAY_MANAGEMENT: "shift_management__holiday",
  VIEW_SHIFTS: "shift_management__view",
  ADD_SHIFT: "shift_management__add",

  SKILL_MANAGEMENT: "skill_management",
  VIEW_SKILLS: "skill_management__view",

  NG_DEVICES: "ng_devices",
  NG_DEVICES_VIEW: "ng_devices__view",
  NG_ISSUE_MASTER: "ng_devices__issue_master",

  ESIM_REMOVAL: "esim_removal__removal",
  ESIM_REMOVAL_REQUESTS: "esim_removal__requests",

  REPORTS: "reports",
  NG_DEVICES_REPORT: "reports__ng_devices",
  CCID_REASSIGNMENT_LOG: "reports__ccid_reassignment_log",

  // Live in the production Menu document but not yet in menuController.js's
  // seed data (added by some other, untracked migration) — discovered via
  // the moduleKey backfill's "no known mapping" warnings. Not yet referenced
  // by any authorize() call (their backend routes are currently
  // authenticateToken-only), but still need real keys so the Menu doc
  // doesn't carry permanent `legacy.*` fallback keys for real modules.
  // (NG_ISSUE_MASTER itself is defined above, nested under ng_devices.)
  CARTON_MANAGEMENT: "carton_management",
  DISPATCH_MANAGEMENT: "dispatch_management",

  // ESIM Master Data — these pages existed with ProtectedRoute moduleName only
  // (no moduleKey, no real menu entry), so no role could ever be granted or
  // denied them independently and the backend routes had zero authorization.
  ESIM_MASTER_DATA: "esim_master_data",
  ESIM_MASTER_VIEW: "esim_master_data__view_master",
  ESIM_MASTER_BULK_UPLOAD: "esim_master_data__bulk_upload",
  ESIM_MASTER_MAKES: "esim_master_data__makes",
  ESIM_MASTER_PROFILES: "esim_master_data__profiles",
  ESIM_MASTER_APNS: "esim_master_data__apns",
};

module.exports = MODULE_KEYS;
