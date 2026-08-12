const express = require('express');
const router = express.Router();
const authController = require('../controller/authController');
const { upload } = require('../controller/uploadController');
const userController = require('../controller/userController');
const productController = require('../controller/productController');
const productCategoryController = require('../controller/productCategoryController');
const jigController = require("../controller/jigController");
const roomPlanController = require("../controller/roomPlanController");
const userRolesController = require('../controller/userRolesController');
const menuController = require('../controller/menuController');
const shiftController = require('../controller/shiftController');
const processController = require('../controller/processController');
const planningAndSchedulingController = require('../controller/planningAndSchedulingController');
const holidayController = require('../controller/holidayController');
const assignedOperatorsToPlan = require('../controller/operatorTaskController');
const operatorWorkController = require('../controller/operatorWorkController');
const deviceController = require(`../controller/deviceController`);
const multer = require('multer');
const connectDB = require('../config/db');
const RoomPlan = require('../models/roomPlan');
const reportController = require('../controller/reportController');
const stickerController = require('../controller/stickerController');
const stickerFormatMasterController = require('../controller/stickerFormatMasterController');
const inventoryController = require('../controller/inventoryController');
const inventory = require('../models/inventoryManagement');
const productionManagerController = require('../controller/productionManagerController');
const skillManagementController = require('../controller/skillController');
const kitsController = require('../controller/kitsController');
const kitTransferController = require('../controller/kitTransferController');
const ccidTransferController = require('../controller/ccidTransferController');
const OrderConfirmationController = require('../controller/orderConfirmationController');
const CartonController = require('../controller/cartonController');
const cartonController = require('../controller/cartonController');
const esimMasterController = require('../controller/esimMasterController');
const esimMakeController = require('../controller/esimMakeController');
const esimProfileController = require('../controller/esimProfileController');
const dispatchController = require('../controller/dispatchController');
const device = require('../models/device');
const {
  PROCESS_AND_PLANNING_READ_MODULES,
  DEVICE_READ_MODULE_LABELS,
} = require('../constants/authorizationModules');
const MODULE_KEYS = require('../constants/moduleKeys');
const { submitDeduplicationMiddleware } = require('../middleware/requestDeduplication');
const { createRequestTimeoutMiddleware } = require('../middleware/requestTimeout');
connectDB();

/** Parses multipart/form-data for API routes that receive FormData from the frontend. */
const formDataParser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
}).any();

const MULTIPART_SKIP_PREFIXES = ["/upload-image/", "/upload-cover-image/"];

router.use((req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    return next();
  }
  if (MULTIPART_SKIP_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    return next();
  }
  return formDataParser(req, res, next);
});

router.get('/items', authController.getItems);
router.get('/product/view', authController.authenticateToken, authController.authorize([MODULE_KEYS.VIEW_PRODUCT, MODULE_KEYS.PRODUCT_CATEGORY], "read"), productController.view);
router.get('/product/get/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PRODUCT, "read"), productController.getProductByID);
router.get('/get-user-details', authController.authenticateToken, userController.getUserById);
router.delete('/product/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PRODUCT, "delete"), productController.delete);
router.post('/product/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PRODUCT, "delete"), productController.deleteMultiple);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.post('/register', authController.register);
router.post('/add/product', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PRODUCT, "create"), productController.create);
router.put('/product/update/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PRODUCT, "update"), productController.update);
router.put('/product/activate/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PRODUCT, "update"), productController.activate);

// Product Category Routes
router.post('/product-category/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.PRODUCT_CATEGORY, "create"), productCategoryController.create);
router.get('/product-category/view', authController.authenticateToken, authController.authorize([MODULE_KEYS.PRODUCT_CATEGORY, MODULE_KEYS.VIEW_PRODUCT], "read"), productCategoryController.view);
router.delete('/product-category/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.PRODUCT_CATEGORY, "delete"), productCategoryController.delete);
router.post('/product-category/delete-multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.PRODUCT_CATEGORY, "delete"), productCategoryController.deleteMultiple);
router.post('/upload-image/:userId', authController.authenticateToken, upload.single('profilePic'), userController.uploadProfilePicture);
router.post('/upload-cover-image/:userId', authController.authenticateToken, upload.single('coverPic'), userController.uploadCoverPicture);
router.get('/protected', authController.authenticateToken, authController.getProtectedData);
router.post('/jig/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_VIEW, "create"), jigController.createOrUpdate);
router.post('/jig/category/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_CATEGORIES, "create"), jigController.createOrUpdateJigCategory);
router.get('/jig/view', authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_VIEW, "read"), jigController.view);
router.get('/jig/category/view', authController.authenticateToken, authController.authorize([MODULE_KEYS.JIG_CATEGORIES, MODULE_KEYS.JIG_VIEW], "read"), jigController.viewCategory);
router.delete('/jig/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_VIEW, "delete"), jigController.delete);
router.delete('/jig/category/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_CATEGORIES, "delete"), jigController.deleteCategory);
router.post('/jig/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_VIEW, "delete"), jigController.deleteJigMultiple);
router.post('/jig/categories/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_CATEGORIES, "delete"), jigController.deleteCategoryMultiple);
router.get(`/fetchJigsById/:id`, authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_VIEW, "read"), jigController.fetchJigsById);
router.get(`/fetchJigByJigId/:id`, authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_VIEW, "read"), jigController.fetchJigByJigId);
router.post('/room-plan/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_ROOMS, "create"), roomPlanController.create);
router.get('/room-plan/view', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_ROOMS, "read"), roomPlanController.view);
router.delete('/room-plan/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_ROOMS, "delete"), roomPlanController.deleteRoomPlan);
router.post('/room-plan/deleteRoomPlan', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_ROOMS, "delete"), roomPlanController.deleteMultipleRoomPlan);
router.get('/room-plan/getRoomPlanByID/:id', authController.authenticateToken, authController.authorize([MODULE_KEYS.VIEW_ROOMS, MODULE_KEYS.OPERATOR_ASSIGNMENT], "read"), roomPlanController.getRoomPlanByID)
router.put('/room-plan/getRoomPlanByID/update/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_ROOMS, "update"), roomPlanController.update);
router.get('/user/generate-code', authController.authenticateToken, userController.generateEmployeeCode);
router.post('/user/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_USER, "create"), userController.createUser);
router.post('/user/bulk-create', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_USER, "create"), userController.bulkCreateUsers);
router.post('/user/check-duplicates', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_USER, "read"), userController.checkUserDuplicates);
router.get('/user/view', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_USER, "read"), userController.getUsers);
router.get('/user/operator-dashboard-stats', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_USER, "read"), userController.getOperatorDashboardStats);
router.put('/user/deboard/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_USER, "update"), userController.deboardOperator);
router.delete('/user/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_USER, "delete"), userController.deleteUser);
router.post('/user/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_USER, "delete"), userController.deleteUserMultiple);
router.put('/user/update/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_USER, "update"), userController.updateUser);
router.get('/analytics/users/registration-trends', authController.authenticateToken, userController.getUserRegistrationTrends);
// Role/permission management itself was reachable by any authenticated user of any
// role — nothing gated create/update/delete here, so a non-admin could rewrite any
// role's permissions (including their own) via PUT /roles/update/:id. Guarded on the
// same MODULE_KEYS.USER_ROLES module used by the frontend's Permissions editor. Left
// /user-type/get and /user-type/getPermissionByType unguarded below — every
// authenticated user (any role) calls those to bootstrap their OWN permission set,
// not to manage roles.
router.post('/user-roles/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.USER_ROLES, "create"), userRolesController.create);
router.get('/user-roles/view', authController.authenticateToken, authController.authorize(MODULE_KEYS.USER_ROLES, "read"), userRolesController.view);
router.delete('/user-roles/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.USER_ROLES, "delete"), userRolesController.deleteUserRole);
router.post('/user-roles/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.USER_ROLES, "delete"), userRolesController.deleteUserRoleMultiple);
router.get('/user-roles/get/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.USER_ROLES, "read"), userRolesController.getUserRolesByID);
router.put('/roles/update/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.USER_ROLES, "update"), userRolesController.update);
router.get('/user-type/get', authController.authenticateToken, userRolesController.getUserType);
router.get('/user-type/getPermissionByType', authController.authenticateToken, userRolesController.getUserTypeByType);
router.post('/menu/create', authController.authenticateToken, authController.authorizeAdminOnly, menuController.create);
router.get('/menu/get', authController.authenticateToken, menuController.view);
router.post('/shift/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SHIFTS, "create"), shiftController.create);
router.get('/shift/view', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SHIFTS, "read"), shiftController.view);
router.delete('/shift/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SHIFTS, "delete"), shiftController.delete);
router.post('/shift/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SHIFTS, "delete"), shiftController.deleteUserRoleMultiple);
router.get('/shift/get/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SHIFTS, "read"), shiftController.getShiftByID);
router.put('/shift/update/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SHIFTS, "update"), shiftController.updateshift);
router.post('/process/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PROCESS, "create"), processController.create);
router.get('/process/generate-iap-no', authController.authenticateToken, processController.generateIapNo);
router.get('/process/view', authController.authenticateToken, authController.authorize(PROCESS_AND_PLANNING_READ_MODULES, "read"), processController.view);
router.get(
  '/getProcessesByProductId/:id',
  authController.authenticateToken,
  authController.authorize([MODULE_KEYS.VIEW_PRODUCT, MODULE_KEYS.VIEW_PROCESS], "read"),
  processController.getProcessesByProductId,
);
router.delete('/process/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PROCESS, "delete"), processController.delete);
router.post('/process/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PROCESS, "delete"), processController.deleteProcessMultiple);
router.get('/process/get/:id', authController.authenticateToken, authController.authorize(PROCESS_AND_PLANNING_READ_MODULES, "read"), processController.getProcessByID);
router.put('/process/update/:id', authController.authenticateToken, authController.authorizeProcessUpdate, processController.update);
router.post('/planing/get', authController.authenticateToken, planningAndSchedulingController.checkAvailability);
router.get('/planing/view', authController.authenticateToken, authController.authorize(PROCESS_AND_PLANNING_READ_MODULES, "read"), planningAndSchedulingController.view);
router.delete('/planing/delete/:id', authController.authenticateToken, authController.authorize([MODULE_KEYS.PLANNING_SCHEDULING_MANAGEMENT, MODULE_KEYS.VIEW_PLANNING_SCHEDULING], "delete"), planningAndSchedulingController.delete);
router.post('/planing/delete/multiple', authController.authenticateToken, authController.authorize([MODULE_KEYS.PLANNING_SCHEDULING_MANAGEMENT, MODULE_KEYS.VIEW_PLANNING_SCHEDULING], "delete"), planningAndSchedulingController.deletePlaningMultiple);
router.get('/planingAndScheduling/get/:id', authController.authenticateToken, authController.authorize(PROCESS_AND_PLANNING_READ_MODULES, "read"), planningAndSchedulingController.getPlaningAnDschedulingByID);
router.get('/planingAndScheduling/insights/:id', authController.authenticateToken, authController.authorize(PROCESS_AND_PLANNING_READ_MODULES, "read"), planningAndSchedulingController.getPlanInsights);
router.get('/planingAndScheduling/testing-analytics/:id', authController.authenticateToken, authController.authorize(PROCESS_AND_PLANNING_READ_MODULES, "read"), planningAndSchedulingController.getSeatStageTestingAnalytics);
router.get('/planingAndScheduling/process-insights/:id', authController.authenticateToken, authController.authorize(PROCESS_AND_PLANNING_READ_MODULES, "read"), planningAndSchedulingController.getProcessInsights);
router.get('/planingAndScheduling/getPlaningAnDschedulingByProcessId/:id', authController.authenticateToken, authController.authorize(PROCESS_AND_PLANNING_READ_MODULES, "read"), planningAndSchedulingController.getPlaningAnDschedulingByProcessId);
router.put('/planingAndScheduling/update/:id', authController.authenticateToken, authController.authorize([MODULE_KEYS.PLANNING_SCHEDULING_MANAGEMENT, MODULE_KEYS.VIEW_PLANNING_SCHEDULING], "update"), planningAndSchedulingController.update);
router.get('/holiday/view', authController.authenticateToken, authController.authorize(MODULE_KEYS.HOLIDAY_MANAGEMENT, "read"), holidayController.view);
router.post('/holiday/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.HOLIDAY_MANAGEMENT, "create"), holidayController.create);
router.delete('/holiday/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.HOLIDAY_MANAGEMENT, "delete"), holidayController.delete);
router.post('/holiday/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.HOLIDAY_MANAGEMENT, "delete"), holidayController.deleteHolidayMultiple);
router.post('/planing/getFromCurrentDate', authController.authenticateToken, planningAndSchedulingController.checkAvailabilityFromCurrentDate);
router.get('/planing/getPlaningAndSchedulingModel', authController.authenticateToken, planningAndSchedulingController?.fetchAllPlaningModel);
router.post('/planing/create', authController.authenticateToken, authController.authorize([MODULE_KEYS.PLANNING_SCHEDULING_MANAGEMENT, MODULE_KEYS.VIEW_PLANNING_SCHEDULING], "create"), planningAndSchedulingController.create);
router.post('/process/log/create', authController.authenticateToken, processController.processLogs);
router.get('/process/logs/getLogsByProcessID/:id', authController.authenticateToken, planningAndSchedulingController.getProcessLogsByProcessId);
router.post('/assignPlanToOperator/create', authController.authenticateToken, assignedOperatorsToPlan.create);
router.get(`/assignPlanToOperator/view/:id`, authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_TASK, "read"), assignedOperatorsToPlan.getTaskByUserID);
router.get(`/assignPlanToOperator/get/:id`, authController.authenticateToken, assignedOperatorsToPlan.getOperatorTaskByUserID);
router.get('/operator-task/bootstrap/:planId/:operatorId', authController.authenticateToken, assignedOperatorsToPlan.getOperatorTaskBootstrap);
router.get('/operator-task/refresh/:planId/:operatorId', authController.authenticateToken, assignedOperatorsToPlan.getOperatorTaskRefresh);
router.get('/operator-task/device/:planId/:operatorId', authController.authenticateToken, assignedOperatorsToPlan.getOperatorTaskDevice);

// Operator work tracking (session + breaks + event logs) — self-service
// endpoints an operator uses on their own current task, gated on the same
// View Task permission that governs task execution elsewhere.
router.post(
  "/operator-work/sessions/start",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "update"),
  operatorWorkController.startSession
);
router.get(
  "/operator-work/sessions/active",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "read"),
  operatorWorkController.getActiveSession
);
router.get(
  "/operator-work/sessions/:sessionId",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "read"),
  operatorWorkController.getSessionById
);
router.post(
  "/operator-work/sessions/:sessionId/stop",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "update"),
  operatorWorkController.stopSession
);
router.post(
  "/operator-work/sessions/:sessionId/breaks/start",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "update"),
  operatorWorkController.startBreak
);
router.post(
  "/operator-work/sessions/:sessionId/breaks/end",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "update"),
  operatorWorkController.endBreak
);
router.post(
  "/operator-work/sessions/:sessionId/events",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "update"),
  operatorWorkController.logEvent
);
router.get(
  "/operator-work/operator/:operatorId/sessions",
  authController.authenticateToken,
  // Also called from the operator logs page (View User), not just the
  // operator's own task page.
  authController.authorize([MODULE_KEYS.VIEW_TASK, MODULE_KEYS.VIEW_USER], "read"),
  operatorWorkController.getSessionsByOperator
);

router.get(
  "/operator-work/sessions/:sessionId/work-details",
  authController.authenticateToken,
  authController.authorize([MODULE_KEYS.VIEW_TASK, MODULE_KEYS.VIEW_USER], "read"),
  operatorWorkController.getSessionWorkDetails
);
router.post(
  "/operator-work/sessions/expire-stale",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "update"),
  operatorWorkController.expireStaleSessionsAdmin
);
router.post(
  "/operator-work/idle-pending",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "update"),
  operatorWorkController.setPendingIdle
);
router.post(
  "/operator-work/idle-logs",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "update"),
  operatorWorkController.createIdleLog
);
router.get(
  "/operator-work/idle-logs",
  authController.authenticateToken,
  // Also called from the Planning & Scheduling view's shared IdleTimeLogPanel
  // (viewed by roles like Production Manager who have planning access but no
  // View Task grant), not just the operator task page.
  authController.authorize([MODULE_KEYS.VIEW_TASK, MODULE_KEYS.VIEW_PLANNING_SCHEDULING], "read"),
  operatorWorkController.getIdleLogs
);
router.get(
  "/operator-work/idle-sync-status",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "read"),
  operatorWorkController.getIdleSyncStatus
);
router.get(
  "/operator-work/session-sync-status",
  authController.authenticateToken,
  authController.authorize(MODULE_KEYS.VIEW_TASK, "read"),
  operatorWorkController.getWorkSessionSyncStatus
);
router.get('/device/getLastEntryBasedOnPrefixAndSuffix', authController.authenticateToken, deviceController.getLastEntryBasedOnPrefixAndSuffix);
router.get('/device/get/:id', authController.authenticateToken, authController.authorize(DEVICE_READ_MODULE_LABELS, "read"), deviceController.getDeviceById);
router.get('/devices/devicesByProductID/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PRODUCT, "read"), deviceController.getDeviceByProductId);
router.get('/devices/countByProcessId/:processId', authController.authenticateToken, deviceController.getDeviceCountByProcessId);
router.get('/devices/by-process/:processId', authController.authenticateToken, authController.authorize([MODULE_KEYS.KIT_TRANSFER, MODULE_KEYS.ESIM_REMOVAL, MODULE_KEYS.ESIM_REMOVAL_REQUESTS, MODULE_KEYS.TRANSFER_REQUESTS, MODULE_KEYS.VIEW_PROCESS, MODULE_KEYS.STORE_PORTAL, MODULE_KEYS.CARTON_MANAGEMENT], "read"), deviceController.getDevicesByProcessId);
router.get('/ng-devices/queue', authController.authenticateToken, authController.authorize([MODULE_KEYS.NG_DEVICES, MODULE_KEYS.NG_DEVICES_VIEW], "read"), deviceController.getNgPortalQueue);
router.get('/ng-devices/process/:processId', authController.authenticateToken, authController.authorize([MODULE_KEYS.NG_DEVICES, MODULE_KEYS.NG_DEVICES_VIEW], "read"), deviceController.getNGDevicesByProcessId);
router.post('/devices/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.FIND_DEVICE, "create"), deviceController.create);
router.post('/deviceRecord/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_TASK, "create"), createRequestTimeoutMiddleware(15000), submitDeduplicationMiddleware, deviceController.createDeviceTestEntry);
router.post('/device/attempts/register', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_TASK, "create"), deviceController.registerDeviceAttempt);
router.post('/device/attempts/log-retry', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_TASK, "create"), deviceController.logDeviceRetryAttempt);
router.get('/getOverallDeviceTestEntry', authController.authenticateToken, authController.authorize([MODULE_KEYS.NG_DEVICES, MODULE_KEYS.NG_DEVICES_VIEW], "read"), deviceController.getOverallDeviceTestEntry);
router.get('/getDeviceTestEntryByOperatorId/:id', authController.authenticateToken, deviceController.getDeviceTestEntryByOperatorId);
router.get('/getDeviceTestHistoryByOperatorId/:id', authController.authenticateToken, deviceController.getDeviceTestHistoryByOperatorId);
router.get('/deviceTestHistoryByDeviceId/:deviceId', authController.authenticateToken, authController.authorize([MODULE_KEYS.NG_DEVICES, MODULE_KEYS.NG_DEVICES_VIEW, MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK, MODULE_KEYS.STORE_PORTAL], "read"), deviceController.getDeviceTestHistoryByDeviceId);
router.patch(
  '/updateStageByDeviceId/:deviceId',
  authController.authenticateToken,
  authController.authorizeUpdateStageByDeviceId,
  deviceController.updateStageByDeviceId
);
router.patch('/updateStageBySerialNo/:serialNo', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_TASK, "update"), deviceController.updateStageBySerialNo);
// Also the core lookup every operator's jig session uses to find a device by its scanned
// fields — not just the admin Find Device page — so VIEW_TASK must pass here too.
router.post('/devices/searchByJigFields', authController.authenticateToken, authController.authorize([MODULE_KEYS.FIND_DEVICE, MODULE_KEYS.VIEW_TASK], "read"), deviceController.searchByJigFields);
router.post('/devices/validate-identity-at-connection', authController.authenticateToken, deviceController.validateDeviceIdentityAtConnection);
router.post('/devices/markAsResolved', authController.authenticateToken, authController.authorizeMarkDeviceResolved, deviceController.markAsResolved);
router.post('/devices/seed-stage-history', authController.authenticateToken, deviceController.seedStageHistory);
router.get('/devices/search-history', authController.authenticateToken, authController.authorize(MODULE_KEYS.FIND_DEVICE, "read"), deviceController.getDeviceComprehensiveHistory);
router.post('/devices/sticker-reprint-log', authController.authenticateToken, deviceController.createStickerReprintLog);
router.get('/devices/sticker-reprint-log', authController.authenticateToken, deviceController.getStickerReprintLogs);
router.patch('/devices/sticker-reprint-log/:id/verify', authController.authenticateToken, deviceController.markStickerReprintVerified);
router.post('/createReport', authController.authenticateToken, reportController.create);
router.get('/getOverallProgressByOperatorId/:planId/:operatorId', authController.authenticateToken, deviceController.getOverallProcessByOperatorId);
router.post('/sticker/fields/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.STICKER_FIELDS, "create"), stickerController.createStickerField);
router.get('/sticker/fields/get', authController.authenticateToken, authController.authorize(MODULE_KEYS.STICKER_FIELDS, "read"), stickerController.getStickerField);
router.delete('/sticker/fields/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.STICKER_FIELDS, "delete"), stickerController.deleteStickerField);
router.post('/sticker/fields/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.STICKER_FIELDS, "delete"), stickerController.deleteStickerFieldMultiple);

// Sticker Format Master
router.post('/sticker/format/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.STICKER_FORMAT_MASTER, "create"), stickerFormatMasterController.create);
router.get('/sticker/format/list', authController.authenticateToken, authController.authorize(MODULE_KEYS.STICKER_FORMAT_MASTER, "read"), stickerFormatMasterController.getAll);
router.get('/sticker/format/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.STICKER_FORMAT_MASTER, "read"), stickerFormatMasterController.getById);
router.put('/sticker/format/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.STICKER_FORMAT_MASTER, "update"), stickerFormatMasterController.update);
router.delete('/sticker/format/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.STICKER_FORMAT_MASTER, "delete"), stickerFormatMasterController.delete);
router.post('/devices/createIMEI', authController.authenticateToken, authController.authorize(MODULE_KEYS.ADD_MULTIPLE_IMEI, "create"), deviceController.createIMEI);
router.get('/devices/viewIMEI', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_IMEI, "read"), deviceController.viewIMEI);
router.delete('/devices/deleteIMEI/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_IMEI, "delete"), deviceController.deleteIMEI);
router.post('/devices/deleteIMEI/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_IMEI, "delete"), deviceController.deleteMultipleIMEI);
router.post('/devices/bulk-delete-by-imei', authController.authenticateToken, authController.authorize(MODULE_KEYS.BULK_DELETE_DEVICES, "delete"), deviceController.bulkDeleteByImei);
router.get('/devices/deleted-devices', authController.authenticateToken, authController.authorize([MODULE_KEYS.DELETION_HISTORY, MODULE_KEYS.BULK_DELETE_DEVICES], "read"), deviceController.viewDeletedDevices);
router.get('/analytics/device-test/trends', authController.authenticateToken, deviceController.getDeviceTestTrends);
router.get('/analytics/device-test/ng-reasons', authController.authenticateToken, deviceController.getNGReasonDistribution);
router.get('/inventory/view', authController.authenticateToken, authController.authorize([MODULE_KEYS.INVENTORY_STORE, MODULE_KEYS.VIEW_PRODUCT_INVENTORY, MODULE_KEYS.VIEW_PROCESS_INVENTORY],"read"), inventoryController.view);
router.put('/inventory/update/:id', authController.authenticateToken, authController.authorize([MODULE_KEYS.INVENTORY_STORE, MODULE_KEYS.VIEW_PRODUCT_INVENTORY, MODULE_KEYS.VIEW_PROCESS_INVENTORY],"update"), inventoryController.updateInventoryQuantity);
router.get('/inventory/process/get', authController.authenticateToken, authController.authorize([MODULE_KEYS.INVENTORY_STORE, MODULE_KEYS.VIEW_PRODUCT_INVENTORY, MODULE_KEYS.VIEW_PROCESS_INVENTORY],"read"), inventoryController.getProcessInventory);
router.get('/inventory/dashboard', authController.authenticateToken, authController.authorize([MODULE_KEYS.INVENTORY_STORE, MODULE_KEYS.VIEW_PRODUCT_INVENTORY, MODULE_KEYS.VIEW_PROCESS_INVENTORY],"read"), inventoryController.dashboard);
router.get('/inventory/getProcessByProduct/:id', authController.authenticateToken, authController.authorize([MODULE_KEYS.INVENTORY_STORE, MODULE_KEYS.VIEW_PRODUCT_INVENTORY, MODULE_KEYS.VIEW_PROCESS_INVENTORY],"read"), inventoryController.getProcessByProductID);
router.put('/inventory/process/updateIssueKit', authController.authenticateToken, authController.authorize([MODULE_KEYS.INVENTORY_STORE, MODULE_KEYS.VIEW_PRODUCT_INVENTORY, MODULE_KEYS.VIEW_PROCESS_INVENTORY],"update"), inventoryController.updateIssueKit);
router.put('/inventory/process/updateIssueCarton', authController.authenticateToken, authController.authorize([MODULE_KEYS.INVENTORY_STORE, MODULE_KEYS.VIEW_PRODUCT_INVENTORY, MODULE_KEYS.VIEW_PROCESS_INVENTORY],"update"), inventoryController.updateCarton);
router.get('/analytics/inventory/stock-trends', authController.authenticateToken, authController.authorize([MODULE_KEYS.INVENTORY_STORE, MODULE_KEYS.VIEW_PRODUCT_INVENTORY, MODULE_KEYS.VIEW_PROCESS_INVENTORY],"read"), inventoryController.getInventoryTrends);
router.get('/production-manger/process/get', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PROCESS, "read"), productionManagerController.getProcesses);
router.get('/production-manger/getRemainingKit', authController.authenticateToken, authController.authorize(MODULE_KEYS.REMAINING_KITS, "read"), productionManagerController.getRemainingKitFromCompletedProcess);
router.put('/production-manager/process/updateProductionStatus', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PROCESS, "update"), productionManagerController.updateProductionStatus);
router.get('/production-manager/processStatics/get', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PROCESS, "read"), productionManagerController.processStatics);
router.get('/analytics/production/completion-trends', authController.authenticateToken, productionManagerController.getProcessCompletionAnalytics);
router.get('/analytics/mes/production-dashboard', authController.authenticateToken, productionManagerController.getMesProductionDashboard);
router.put('/operator/updateOperatorSkillSet/:id', authController.authenticateToken, userController.updateOperatorSkillSet);
router.post('/skill-management/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SKILLS, "create"), skillManagementController.create);
router.get('/skill-management/get', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SKILLS, "read"), skillManagementController.getSkills);
router.delete('/skill-management/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SKILLS, "delete"), skillManagementController.delete);
router.post('/skill-management/delete/multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_SKILLS, "delete"), skillManagementController.deleteMultiple);
router.put('/process/updateQuantity/:id', authController.authenticateToken, processController.updateMoreQuantity);
router.put('/process/updateMarkAsCompleted/:id', authController.authenticateToken, processController.updateMarkasCompletedProcess);
router.post('/production/returnKitsToStore', authController.authenticateToken, authController.authorize(MODULE_KEYS.RETURNED_KITS, "create"), kitsController.createKitsEntry);
router.put('/store/updateKitsStatus/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.RETURNED_KITS, "update"), kitsController.updateKitsStatus);
router.get('/process/viewReturnToStore', authController.authenticateToken, authController.authorize(MODULE_KEYS.RETURNED_KITS, "read"), kitsController.viewReturnKitStore);
router.get('/operators/getVacantOperator', authController.authenticateToken, authController.authorize(MODULE_KEYS.OPERATOR_ASSIGNMENT, "read"), processController.getVacantOperator);
router.post('/operators/reassign', authController.authenticateToken, authController.authorize(MODULE_KEYS.OPERATOR_ASSIGNMENT, "update"), processController.reassignOperator);
router.put('/operator/updateStatus/:id', authController.authenticateToken, processController.updateStatusAssignedOperator);
router.post('/operators/assign', authController.authenticateToken, authController.authorize(MODULE_KEYS.OPERATOR_ASSIGNMENT, "update"), processController.assignOperatorToProcess);
router.post('/operators/unassign', authController.authenticateToken, authController.authorize(MODULE_KEYS.OPERATOR_ASSIGNMENT, "update"), processController.unassignOperatorFromProcess);
router.post('/planing/createAssignedJigs', authController.authenticateToken, assignedOperatorsToPlan.createJigAssignedToPlan)
router.put('/jig/updateStatus/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.JIG_VIEW, "update"), jigController.updateJigStatus);
router.put("/process/updateIssueKitsToLine", authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PROCESS, "update"), processController.updateIssuedKitsToLine);
router.put("/process/updateStatusRecivedKit/:id", authController.authenticateToken, authController.authorize(MODULE_KEYS.VIEW_PROCESS, "update"), processController.updateStatusRecievedKit);
router.get("/process/getDeviceTestRecordsByProcessId/:id", authController.authenticateToken, processController.getDeviceTestRecordsByProcessId);
router.get("/devices/retry-logs/:id", authController.authenticateToken, deviceController.getDeviceRetryLogsByProcessId);
router.get("/process/getLatestDeviceTestsByPlanId/:planId", authController.authenticateToken, processController.getLatestDeviceTestsByPlanId);
router.post("/kit-transfer/request", authController.authenticateToken, authController.authorize([MODULE_KEYS.KIT_TRANSFER, MODULE_KEYS.TRANSFER_REQUESTS], "create"), kitTransferController.createRequest);
router.get("/kit-transfer/request", authController.authenticateToken, authController.authorize([MODULE_KEYS.KIT_TRANSFER, MODULE_KEYS.TRANSFER_REQUESTS], "read"), kitTransferController.listRequests);
router.get("/kit-transfer/request/:id", authController.authenticateToken, authController.authorize([MODULE_KEYS.KIT_TRANSFER, MODULE_KEYS.TRANSFER_REQUESTS], "read"), kitTransferController.getRequestById);
router.put("/kit-transfer/request/:id/approve", authController.authenticateToken, authController.authorize([MODULE_KEYS.KIT_TRANSFER, MODULE_KEYS.TRANSFER_REQUESTS], "update"), kitTransferController.approveRequest);
router.put("/kit-transfer/request/:id/reject", authController.authenticateToken, authController.authorize([MODULE_KEYS.KIT_TRANSFER, MODULE_KEYS.TRANSFER_REQUESTS], "update"), kitTransferController.rejectRequest);

// ESIM Removal (CCID Transfer) Routes — "CCID Transfer" was the pre-rename permission
// label; these routes back both the "ESIM Removal" and "ESIM Removal Requests" menu items.
router.post("/ccid-transfer/request", authController.authenticateToken, authController.authorize([MODULE_KEYS.ESIM_REMOVAL, MODULE_KEYS.ESIM_REMOVAL_REQUESTS, MODULE_KEYS.TRANSFER_REQUESTS], "create"), ccidTransferController.createRequest);
router.get("/ccid-transfer/request", authController.authenticateToken, authController.authorize([MODULE_KEYS.ESIM_REMOVAL, MODULE_KEYS.ESIM_REMOVAL_REQUESTS, MODULE_KEYS.TRANSFER_REQUESTS], "read"), ccidTransferController.listRequests);
router.get("/ccid-transfer/request/:id", authController.authenticateToken, authController.authorize([MODULE_KEYS.ESIM_REMOVAL, MODULE_KEYS.ESIM_REMOVAL_REQUESTS, MODULE_KEYS.TRANSFER_REQUESTS], "read"), ccidTransferController.getRequestById);
router.put("/ccid-transfer/request/:id/approve", authController.authenticateToken, authController.authorize([MODULE_KEYS.ESIM_REMOVAL, MODULE_KEYS.ESIM_REMOVAL_REQUESTS, MODULE_KEYS.TRANSFER_REQUESTS], "update"), ccidTransferController.approveRequest);
router.put("/ccid-transfer/request/:id/reject", authController.authenticateToken, authController.authorize([MODULE_KEYS.ESIM_REMOVAL, MODULE_KEYS.ESIM_REMOVAL_REQUESTS, MODULE_KEYS.TRANSFER_REQUESTS], "update"), ccidTransferController.rejectRequest);
router.get("/ccid-reassignment-log", authController.authenticateToken, authController.authorize([MODULE_KEYS.CCID_REASSIGNMENT_LOG, MODULE_KEYS.ESIM_REMOVAL, MODULE_KEYS.ESIM_REMOVAL_REQUESTS, MODULE_KEYS.TRANSFER_REQUESTS], "read"), deviceController.listCcidReassignmentLogs);

router.get("/process/orderConfirmation/get", authController.authenticateToken, authController.authorize([MODULE_KEYS.OC_MANAGEMENT, MODULE_KEYS.VIEW_PROCESS], "read"), OrderConfirmationController.view); // Also called from the Process view page's OC-numbers lookup, not just OC Management itself
router.post('/process/orderConfirmation/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.OC_MANAGEMENT, "create"), OrderConfirmationController.create);
router.delete('/process/orderConfirmation/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.OC_MANAGEMENT, "delete"), OrderConfirmationController.delete);
router.post('/process/orderConfirmation/delete-multiple', authController.authenticateToken, authController.authorize(MODULE_KEYS.OC_MANAGEMENT, "delete"), OrderConfirmationController.deleteMultiple);
router.put('/process/addDownTime/:id', authController.authenticateToken, planningAndSchedulingController.updateDownTime);
router.put('/process/addOvertime/:id', authController.authenticateToken, planningAndSchedulingController.addOvertime);
router.delete('/process/removeOvertime/:id/:windowId', authController.authenticateToken, planningAndSchedulingController.removeOvertime);
router.get('/process/overtime/:id', authController.authenticateToken, planningAndSchedulingController.getOvertime);
router.put('/process/updateProcessStatus/:id', authController.authenticateToken, planningAndSchedulingController.updateProcessStatus);
router.get('/process/getPlaningAndSchedulingDateWise/get', authController.authenticateToken, authController.authorize(PROCESS_AND_PLANNING_READ_MODULES, "read"), planningAndSchedulingController.getPlaningAndSchedulingDateWise);
router.get('/planing/downtime-reasons', authController.authenticateToken, planningAndSchedulingController.getDowntimeReasons);

router.get('/cartons/full', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"read"), cartonController.getFullCartons);
router.post('/carton/updatePrinting', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"update"), cartonController.updatePrinting);
router.put('/carton/updateWeight', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"update"), CartonController.updateWeight);
router.post('/carton/createCarton', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"create"), submitDeduplicationMiddleware, CartonController.createOrUpdate);
router.put('/carton/removeDevice', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"update"), CartonController.removeDevice);
router.post('/carton/verifySticker', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"update"), CartonController.verifySticker);
router.get("/cartons/:processId/partial", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"read"), CartonController.getPartialCarton);
router.get("/cartons/:processId/open", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"read"), CartonController.getOpenCartonsByProcessId);
// IMPORTANT: put the specific route before "/cartons/:processId" so it doesn't get treated as a processId param.
router.get("/cartons/store-portal", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK, MODULE_KEYS.STORE_PORTAL],"read"), cartonController.getStorePortalCartons);
router.get("/cartons/:processId/partial", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"read"), CartonController.getPartialCarton);
router.get("/cartons/:processId/open", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"read"), CartonController.getOpenCartonsByProcessId);
// IMPORTANT: put the specific route before "/cartons/:processId" so it doesn't get treated as a processId param.
router.get("/cartons/store-portal", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK, MODULE_KEYS.STORE_PORTAL],"read"), cartonController.getStorePortalCartons);
router.get("/cartons/:processId", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"read"), cartonController.getCartonByProcessId);
router.get("/cartonsProcessId/:processId", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"read"), cartonController.getCartonByProcessIdToPDI);
router.get("/cartonsIntoStore/:processId", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"read"), cartonController.getCartonsIntoStore);
router.put('/carton/close-loose', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"update"), cartonController.closeLooseCarton);
router.post("/cartons/shift-to-pdi", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"update"), cartonController.shiftToPDI);
router.post('/cartons/pdi-ng', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"update"), cartonController.markPdiCartonNg);
router.get('/carton/repackage/search/:cartonSerial', authController.authenticateToken, authController.authorize(MODULE_KEYS.REPACKAGING, "read"), cartonController.searchCartonForRepackaging);
router.get('/carton/repackage/validate-device/:serialNo', authController.authenticateToken, authController.authorize(MODULE_KEYS.REPACKAGING, "read"), cartonController.validateDeviceForRepackaging);
router.post('/carton/repackage/update', authController.authenticateToken, authController.authorize(MODULE_KEYS.REPACKAGING, "update"), cartonController.repackageCarton);
router.post('/carton/repackage/shuffle', authController.authenticateToken, authController.authorize(MODULE_KEYS.REPACKAGING, "update"), cartonController.shuffleDevices);
router.get('/cartons/:cartonSerial/history', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"read"), cartonController.getCartonHistory);
router.post('/cartons/:processId/shift', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"update"), cartonController.shiftToNextCommonStage);
router.post('/cartons/:processId/keep-in-store', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"update"), cartonController.keepInStore);
router.delete('/carton/discard/:cartonSerial', authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK],"delete"), cartonController.discardCarton);

router.get("/process/getFGInventory", authController.authenticateToken, authController.authorize([MODULE_KEYS.CARTON_MANAGEMENT, MODULE_KEYS.VIEW_TASK, MODULE_KEYS.VIEW_PRODUCT_INVENTORY],"read"), cartonController.fetchCurrentRunningProcessFG);
router.get("/dispatch/cartons/ready", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"read"), dispatchController.getReadyCartons);
router.get("/dispatch/summary/processes", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"read"), dispatchController.getProcessDispatchSummaries);
router.get("/dispatch/cartons/:cartonSerial", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"read"), dispatchController.getCartonBySerial);
router.post("/dispatch/invoices", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"create"), dispatchController.createInvoice);
router.get("/dispatch/invoices", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"read"), dispatchController.getInvoices);
router.get("/dispatch/invoices/:id", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"read"), dispatchController.getInvoiceById);
router.put("/dispatch/invoices/:id", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"update"), dispatchController.updateInvoice);
router.post("/dispatch/invoices/:id/cancel", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"delete"), dispatchController.cancelInvoice);
router.post("/dispatch/invoices/:id/confirm", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"update"), dispatchController.confirmInvoice);
router.get("/dispatch/invoices/:id/gate-pass", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"read"), dispatchController.getGatePass);
router.post("/dispatch/invoices/:id/gate-pass/pdf", authController.authenticateToken, authController.authorize([MODULE_KEYS.DISPATCH_MANAGEMENT, MODULE_KEYS.FG_TO_STORE, MODULE_KEYS.VIEW_PROCESS],"read"), dispatchController.generateGatePassPdf);
router.get("/warranty/check", authController.authenticateToken, dispatchController.checkWarranty);
router.delete("/devices/remove-duplicates", authController.authenticateToken, authController.authorize(MODULE_KEYS.BULK_DELETE_DEVICES, "delete"), async (req, res) => {
  try {
    const duplicates = await device.aggregate([
      {
        $group: {
          _id: "$serialNo",
          ids: { $push: "$_id" },
          count: { $sum: 1 }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ]);

    // Batch every group's extra ids into a single deleteMany instead of one
    // round trip per duplicate group.
    const idsToDelete = duplicates.flatMap((doc) => {
      doc.ids.shift(); // keep one
      return doc.ids;
    });
    if (idsToDelete.length > 0) {
      await device.deleteMany({ _id: { $in: idsToDelete } });
    }

    res.status(200).json({ message: "Duplicate devices removed", count: duplicates.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const esimApnController = require('../controller/esimApnController');

router.post('/esim-master/bulk-create', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_BULK_UPLOAD, "create"), esimMasterController.bulkCreate);
router.post('/esim-master/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_VIEW, "create"), esimMasterController.create);
router.get('/esim-master/view', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_VIEW, "read"), esimMasterController.view);
router.put('/esim-master/update/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_VIEW, "update"), esimMasterController.update);
router.delete('/esim-master/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_VIEW, "delete"), esimMasterController.delete);
router.post('/esim-master/bulk-delete', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_VIEW, "delete"), esimMasterController.bulkDelete);
router.post('/esim-master/bulk-delete-by-ccid', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_VIEW, "delete"), esimMasterController.bulkDeleteByCcid);
router.post('/esim-master/check-duplicates', authController.authenticateToken, authController.authorize([MODULE_KEYS.ESIM_MASTER_VIEW, MODULE_KEYS.ESIM_MASTER_BULK_UPLOAD], "read"), esimMasterController.checkDuplicates);
// Also used by the operator portal's jig ESIM Settings Validation step to look up
// eSIM master data by CCID — not just the admin ESIM Master Data page — so any role
// with VIEW_TASK (the operator task permission) must pass here too.
router.get('/esim-master/ccid/:ccid', authController.authenticateToken, authController.authorize([MODULE_KEYS.ESIM_MASTER_VIEW, MODULE_KEYS.VIEW_TASK], "read"), esimMasterController.getByCcid);

router.post('/esim-make/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_MAKES, "create"), esimMakeController.create);
router.get('/esim-make/view', authController.authenticateToken, authController.authorize([MODULE_KEYS.ESIM_MASTER_MAKES, MODULE_KEYS.ESIM_MASTER_APNS, MODULE_KEYS.ESIM_MASTER_VIEW], "read"), esimMakeController.view);
router.put('/esim-make/update/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_MAKES, "update"), esimMakeController.update);
router.delete('/esim-make/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_MAKES, "delete"), esimMakeController.delete);

router.post('/esim-profile/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_PROFILES, "create"), esimProfileController.create);
// Also hit by the operator portal's jig ESIM Settings Validation flow (viewEsimProfiles()),
// so VIEW_TASK must pass here too — see the analogous /esim-master/ccid/:ccid fix above.
router.get('/esim-profile/view', authController.authenticateToken, authController.authorize([MODULE_KEYS.ESIM_MASTER_PROFILES, MODULE_KEYS.ESIM_MASTER_APNS, MODULE_KEYS.ESIM_MASTER_VIEW, MODULE_KEYS.VIEW_TASK], "read"), esimProfileController.view);
router.get('/esim-profile/view/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_PROFILES, "read"), esimProfileController.esimProfileById);
router.put('/esim-profile/update/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_PROFILES, "update"), esimProfileController.update);
router.delete('/esim-profile/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_PROFILES, "delete"), esimProfileController.delete);

router.post('/esim-apn/create', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_APNS, "create"), esimApnController.create);
router.get('/esim-apn/view', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_APNS, "read"), esimApnController.view);
router.get('/esim-apn/view/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_APNS, "read"), esimApnController.viewAPNById);
router.put('/esim-apn/update/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_APNS, "update"), esimApnController.update);
router.delete('/esim-apn/delete/:id', authController.authenticateToken, authController.authorize(MODULE_KEYS.ESIM_MASTER_APNS, "delete"), esimApnController.delete);
// Not gated on ESIM_MASTER_APNS: called during general device/eSIM lookup flows outside the
// ESIM Master admin pages too (unconfirmed all callers), left open per existing session convention
// of not restricting shared lookup endpoints without verifying every caller first.
router.get('/esim-apn/getAPNByMakeAndProfile/:esimMake/:profile1', authController.authenticateToken, esimMasterController.getAPNByMakeAndProfile);
router.get("/process/orderconfirmation/:orderConfirmationNo(*)", authController.authenticateToken, processController.getOrderConfirmationByNo);

module.exports = router;




