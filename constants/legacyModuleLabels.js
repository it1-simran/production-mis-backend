/**
 * moduleKey -> the pre-migration display label(s) that used to be
 * lowercased/underscored into a role's permission-map key for that module.
 *
 * Used only as a read fallback in authController.js: a role document saved
 * before the moduleKey migration (scripts/migratePermissionKeysToModuleKey.js)
 * still has its grants stored under the old derived-label key. Checking both
 * the new moduleKey and every legacy label here means an un-migrated role
 * keeps working exactly as before, with no behavior change, until the
 * migration script has run.
 *
 * "inventory_store__fg_to_store" intentionally lists both historical labels
 * ("FG to Store" nested under Inventory, and the flat "FG Store Management"
 * duplicate) since both used to resolve to grants for the same module.
 *
 * Must stay in sync with constants/moduleKeys.js and the moduleKey values
 * assigned in controller/menuController.js. Namespace separator is "__", not
 * ".", because UserType.permissions is a Mongoose Map and Mongoose Maps
 * reject keys containing ".".
 */

module.exports = {
  "dashboard": ["Dashboard"],
  "production_calendar": ["Production"],
  "user_role_management__user_roles": ["User Roles"],
  "sticker_management": ["Sticker Management"],
  "sticker_management__fields": ["Sticker Fields"],
  "sticker_management__format_master": ["Sticker Format Master"],
  "kit_management__returned_kits": ["Returned Kits"],
  "kit_management__remaining_kits": ["Remaining Kits"],
  "oc_management": ["OC Management"],
  "process_management": ["Process"],
  "process_management__view": ["View Process"],
  "process_management__add": ["Add Process"],
  "process_management__operator_assignment": ["Operator Assignment"],
  "jig_management": ["JIG Management"],
  "jig_management__view": ["JIG"],
  "jig_management__categories": ["JIG Categories"],
  "device_management": ["Device Management"],
  "device_management__view_imei": ["View IMEI"],
  "device_management__add_imei": ["Add Multiple IMEI"],
  "device_management__add_devices": ["Add Multiple Devices"],
  "device_management__bulk_delete": ["Bulk Delete Devices"],
  "device_management__deletion_history": ["Deletion History"],
  "device_management__find_device": ["Find Device"],
  "room_management": ["Room Management"],
  "room_management__view": ["View Rooms"],
  "room_management__add": ["Add Room"],
  "inventory_store": ["Inventory"],
  "inventory_store__view_product": ["View Product Inventory"],
  "inventory_store__view_process": ["View Process Inventory"],
  "inventory_store__fg_to_store": ["FG to Store", "FG Store Management"],
  "inventory_store__store_portal": ["Store Portal"],
  "task_workforce": ["Task Management"],
  "task_workforce__view_task": ["View Task"],
  "task_workforce__repackaging": ["Repackaging"],
  "product_management": ["Product Management"],
  "product_management__view": ["View Product"],
  "product_management__add": ["Add Product"],
  "product_management__category": ["Product Category"],
  "shift_management": ["Shift Management", "Shift Mangement"],
  "shift_management__holiday": ["Holiday Management"],
  "shift_management__view": ["View Shifts"],
  "shift_management__add": ["Add Shift"],
  "skill_management": ["Skill Management"],
  "skill_management__view": ["View Skills"],
  "user_role_management": ["User Management"],
  "user_role_management__view_user": ["View User"],
  "user_role_management__add_user": ["Add User"],
  "process_management__planning_scheduling": [
    "Planning & Scheduling Management",
    "Planing & Scheduling Management",
  ],
  "process_management__view_planning_scheduling": ["View Planning & Scheduling"],
  "process_management__add_planning_scheduling": ["Add Planning & Scheduling"],
  "ng_devices": ["NG Devices"],
  "kit_management__kit_transfer": ["Kit Transfer"],
  // "CCID Transfer" / "CCID Transfer Requests" were the pre-rename labels for
  // these two modules — both were still live as separate, duplicate
  // top-level menu items (same routes as ESIM Removal / ESIM Removal
  // Requests) until the moduleKey backfill unified them under one key.
  "esim_removal__removal": ["ESIM Removal", "CCID Transfer"],
  "esim_removal__requests": ["ESIM Removal Requests", "CCID Transfer Requests"],
  "reports": ["Reports"],
  "reports__ng_devices": ["NG Devices Report"],
  "reports__ccid_reassignment_log": ["CCID Reassignment Log"],
  "kit_management__transfer_requests": ["Transfer Requests"],
  "ng_devices__issue_master": ["NG Issue Master"],
  "ng_devices__view": ["NG Devices"],
  "carton_management": ["Carton Management"],
  "dispatch_management": ["Dispatch Management"],
  "esim_master_data": ["ESIM Master Data"],
  "esim_master_data__view_master": ["View ESIM Master"],
  "esim_master_data__bulk_upload": ["Bulk Upload ESIM Master"],
  "esim_master_data__makes": ["Manage ESIM Makes"],
  "esim_master_data__profiles": ["Manage ESIM Profiles"],
  "esim_master_data__apns": ["Manage ESIM APNs"],
};
