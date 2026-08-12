const AuthService = require("../services/authService");
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(process.cwd(), "debug_auth.log");
const logToFile = (msg) => {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
};
const UserService = require("../services/userService");
const authService = new AuthService(
  process.env.JWT_SECRET || "your-secret-key"
);
const userService = new UserService();
const User = require("../models/User");
const UserTypes = require("../models/userType");
const { NG_PORTAL_DEVICE_WRITE_MODULE_LABELS } = require("../constants/authorizationModules");
const MODULE_KEYS = require("../constants/moduleKeys");
const LEGACY_MODULE_LABELS = require("../constants/legacyModuleLabels");
const { ADMIN_ONLY_BYPASS, DEVICE_WRITE_BYPASS } = require("../constants/permissionBypass");

function normalizeUserTypeKey(userType) {
  return String(userType || "").toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * REVERTED: an in-memory, per-process TTL cache used to live here to cut
 * down on repeated `UserTypes.findOne` calls on polling endpoints. Removed
 * because this backend can run as more than one Node process (PM2 cluster
 * mode / multiple instances behind a load balancer) — each process has its
 * own separate copy of an in-memory Map, so `invalidateRoleCache()` only
 * ever cleared the cache on whichever single process handled the save
 * request. Any other process kept serving stale permissions for up to the
 * TTL window after an admin change, which is exactly the "admin enabled a
 * permission but the app still shows the old one" bug this caused in
 * production. Correctness matters more than the modest per-request latency
 * saved here — a proper fix (shared cache invalidation across processes, or
 * caching at a layer that's actually process-safe) can be revisited later
 * if the polling load becomes a real problem again.
 */
async function getCachedRoleForUserType(userType) {
  return UserTypes.findOne({ name: new RegExp(`^${userType}$`, "i") });
}

/** No-op now that the cache above is gone — kept so existing call sites (userRolesController) don't need to change. */
function invalidateRoleCache() {}

function getPerm(permissions, moduleKey) {
  if (!permissions) return null;
  return permissions instanceof Map ? permissions.get(moduleKey) : permissions[moduleKey];
}

/**
 * Checks a role's permission map for `action` on `moduleKey`. Looks up the
 * stable moduleKey directly first. A parent-level grant (namespace separator
 * is "__" — see constants/moduleKeys.js) always cascades to its children on
 * top of that, by design — mirrors the frontend's resolveStoredModulePermissions.ts,
 * keep both in sync.
 *
 * Legacy derived-label keys (constants/legacyModuleLabels.js) are consulted
 * ONLY when the role has no explicit entry at all for this moduleKey. This
 * matters: once the Configure Permission editor has written a real value for
 * a moduleKey — even an explicit "false" to intentionally downgrade a grant
 * — that value is authoritative. Falling back to a legacy key whenever the
 * requested action happened to be false would mean a role that was ever
 * granted full access under the old key format could never be downgraded
 * through the new editor: unchecking the new box would appear to work but
 * the stale legacy grant (never cleared, since migration is additive-only)
 * would keep silently winning.
 */
function hasModuleLabelAction(permissions, moduleKey, action) {
  const direct = getPerm(permissions, moduleKey);
  if (direct && direct[action] === true) return true;

  if (moduleKey.includes("__")) {
    const parentKey = moduleKey.split("__")[0];
    const parentPerm = getPerm(permissions, parentKey);
    if (parentPerm && parentPerm[action] === true) return true;
  }

  if (direct) return false; // explicit entry exists for this moduleKey — authoritative, no legacy fallback

  const legacyLabels = LEGACY_MODULE_LABELS[moduleKey] || [moduleKey];
  return legacyLabels.some((label) => {
    const legacyKey = String(label || "").toLowerCase().replace(/[\s-]+/g, "_");
    const p = getPerm(permissions, legacyKey);
    return Boolean(p && p[action] === true);
  });
}

function hasAnyNgPortalWriteModuleUpdate(permissions) {
  return NG_PORTAL_DEVICE_WRITE_MODULE_LABELS.some((label) =>
    hasModuleLabelAction(permissions, label, "update")
  );
}

/**
 * Shared policy for mark-as-resolved and restricted PATCH /updateStageByDeviceId (NG portal).
 */
async function evaluateNgPortalDeviceWrite(user) {
  const checkedModules = ["View Task", ...NG_PORTAL_DEVICE_WRITE_MODULE_LABELS, "NG Devices(read)"];
  const t = normalizeUserTypeKey(user.userType);
  const portalTypes = new Set(["trc", "qc", "quality_control"]);
  if (DEVICE_WRITE_BYPASS.has(t) || portalTypes.has(t)) {
    return { allowed: true, checkedModules };
  }
  const role = await getCachedRoleForUserType(user.userType);
  if (!role) {
    return { allowed: false, checkedModules, reason: "role_not_found" };
  }
  const permissions = role.permissions || new Map();
  if (hasAnyNgPortalWriteModuleUpdate(permissions)) {
    return { allowed: true, checkedModules };
  }
  const ngDevices = getPerm(permissions, MODULE_KEYS.NG_DEVICES);
  if (ngDevices && ngDevices.read === true) {
    return { allowed: true, checkedModules };
  }
  return { allowed: false, checkedModules, reason: "no_ng_portal_access" };
}

const PORTAL_PATCH_ALLOWED_BODY_KEYS = new Set([
  "currentStage",
  "status",
  "assignedDeviceTo",
  "imeiNo",
  "ccid",
  "serialNumber",
  "serialNo",
  "deviceId",
]);

module.exports = {
  invalidateRoleCache,
  login: async (req, res) => {
    try {
      const result = await userService.authenticate(req.body);

      return res.status(result.status).json({
        success: result.success,
        user: result.user,
        message: result.message,
        token: result.token || null,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  },
  logout: async (req, res) => {
    res.clearCookie("token");
    res.clearCookie("userDetails");
    res.json({ message: "Logged out successfully" });
  },
  register: async (req, res) => {
    const data = req.body;
    const result = await userService.register(data);
    res.json(result);
  },
  getProtectedData: (req, res) => {
    res.json({
      message: `Hello, ${req.user.username}. You have accessed a protected route!`,
    });
  },
  authenticateToken: async (req, res, next) => {
    try {
      console.log(`>>> [AUTH_TRACE] authenticateToken started for ${req.method} ${req.url}`);
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];
      if (!token) {
        console.log(">>> [AUTH_TRACE] No token provided");
        return res.status(401).json({ error: "No token provided" });
      }

      const decoded = await authService.verifyToken(token);
      const user = await User.findById(decoded.id);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized - User no longer exists" });
      }
      req.user = user;
      next();
    } catch (error) {
      console.error(">>> [AUTH_TRACE] Error verifying token:", error);
      return res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
    }
  },
  /**
   * For system-structural operations (e.g. recreating the menu document)
   * that should never be grantable to any role via the permission editor —
   * unlike authorize(), there is no moduleKey a non-admin could ever be
   * given to pass this.
   */
  authorizeAdminOnly: async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ error: "Unauthorized - No user identity" });
      }
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }
      const normalizedUserType = normalizeUserTypeKey(user.userType);
      if (ADMIN_ONLY_BYPASS.has(normalizedUserType)) {
        return next();
      }
      return res.status(403).json({ error: "Forbidden", message: "This action requires an administrator account." });
    } catch (error) {
      console.error(">>> [AUTH] authorizeAdminOnly error:", error);
      return res.status(500).json({ error: "Internal Server Authorization Error" });
    }
  },
  authorize: (moduleNames, action) => {
    const modules = Array.isArray(moduleNames) ? moduleNames : [moduleNames];
    return async (req, res, next) => {
      try {
        if (!req.user || !req.user.id) {
          return res.status(401).json({ error: "Unauthorized - No user identity" });
        }

        const user = await User.findById(req.user.id);
        if (!user) {
          console.log(`>>> [AUTH_TRACE] User not found: ${req.user.id}`);
          return res.status(401).json({ message: "User not found" });
        }

        const normalizedUserType = normalizeUserTypeKey(user.userType);
        logToFile(
          `>>> [AUTH_TRACE] Authorizing user: ${user.email}, role: "${user.userType}", normalized: "${normalizedUserType}"`
        );

        if (ADMIN_ONLY_BYPASS.has(normalizedUserType)) {
          logToFile(`>>> [AUTH_TRACE] Full access bypass granted for role: ${normalizedUserType}`);
          return next();
        }

        const role = await getCachedRoleForUserType(user.userType);
        if (!role) {
          logToFile(`>>> [AUTH] Role ${user.userType} not found for user ${user.email}`);
          return res.status(403).json({ error: `Forbidden - Role '${user.userType}' not configured` });
        }

        const permissions = role.permissions || new Map();

        const hasPermission = modules.some((moduleKey) =>
          hasModuleLabelAction(permissions, moduleKey, action)
        );

        if (!hasPermission) {
          logToFile(
            `>>> [AUTH] Access denied for ${user.email} on modules: ${modules.join("/")}, action: ${action}`
          );
          return res.status(403).json({
            error: "Forbidden",
            message: `You do not have permission to ${action} in ${modules[0]}`,
            checkedModules: modules,
            requiredAction: action,
            requestId: req.requestId,
          });
        }

        next();
      } catch (error) {
        console.error(">>> [AUTH] Authorization error:", error);
        return res.status(500).json({ error: "Internal Server Authorization Error" });
      }
    };
  },
  /**
   * PUT /process/update/:id
   * - Normal process edit: requires View Process update.
   * - Product "Clone into Process": allow View Product update when req.body.isCloning === "true".
   */
  authorizeProcessUpdate: async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ error: "Unauthorized - No user identity" });
      }

      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      const normalizedUserType = normalizeUserTypeKey(user.userType);
      if (ADMIN_ONLY_BYPASS.has(normalizedUserType)) {
        return next();
      }

      const role = await getCachedRoleForUserType(user.userType);
      if (!role) {
        return res.status(403).json({ error: `Forbidden - Role '${user.userType}' not configured` });
      }

      const permissions = role.permissions || new Map();
      const hasProcessUpdate = hasModuleLabelAction(permissions, MODULE_KEYS.VIEW_PROCESS, "update");
      const hasProductUpdate = hasModuleLabelAction(permissions, MODULE_KEYS.VIEW_PRODUCT, "update");
      const isCloningRequest = String(req?.body?.isCloning || "").toLowerCase() === "true";

      if (hasProcessUpdate || (isCloningRequest && hasProductUpdate)) {
        return next();
      }

      return res.status(403).json({
        error: "Forbidden",
        message: isCloningRequest
          ? "You do not have permission to clone stages. Grant View Product update (or View Process update)."
          : "You do not have permission to update in View Process",
        checkedModules: isCloningRequest ? ["View Product", "View Process"] : ["View Process"],
        requiredAction: "update",
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(">>> [AUTH] authorizeProcessUpdate error:", error);
      return res.status(500).json({ error: "Internal Server Authorization Error" });
    }
  },
  /**
   * POST /devices/markAsResolved — NG Devices detail (TRC/QC resolve).
   */
  authorizeMarkDeviceResolved: async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ error: "Unauthorized - No user identity" });
      }
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }
      const decision = await evaluateNgPortalDeviceWrite(user);
      if (!decision.allowed) {
        logToFile(
          `[AUTH] markAsResolved denied for ${user.email} (${user.userType}) — ${decision.reason || "policy"}`
        );
        return res.status(403).json({
          error: "Forbidden",
          message:
            "You do not have permission to mark this device resolved. Use a TRC/QC account, or grant NG Devices read/update (or Find Device update).",
          checkedModules: decision.checkedModules,
          requiredCapability: "ng_portal_device_write",
          requestId: req.requestId,
        });
      }
      return next();
    } catch (error) {
      console.error("[AUTH] authorizeMarkDeviceResolved error:", error);
      return res.status(500).json({ error: "Internal Server Authorization Error" });
    }
  },
  /**
   * PATCH /updateStageByDeviceId — operators may send full payloads; TRC/QC/NG-read users
   * only allowlisted fields (same write policy as markAsResolved).
   */
  authorizeUpdateStageByDeviceId: async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ error: "Unauthorized - No user identity" });
      }
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }
      const normalizedUserType = normalizeUserTypeKey(user.userType);
      if (DEVICE_WRITE_BYPASS.has(normalizedUserType)) {
        return next();
      }

      const role = await getCachedRoleForUserType(user.userType);
      if (!role) {
        return res.status(403).json({
          error: "Forbidden",
          message: `Forbidden - Role '${user.userType}' not configured`,
          requestId: req.requestId,
        });
      }
      const permissions = role.permissions || new Map();
      if (hasModuleLabelAction(permissions, MODULE_KEYS.VIEW_TASK, "update")) {
        return next();
      }

      const decision = await evaluateNgPortalDeviceWrite(user);
      if (!decision.allowed) {
        logToFile(`[AUTH] updateStageByDeviceId denied for ${user.email} (${user.userType})`);
        return res.status(403).json({
          error: "Forbidden",
          message:
            "You do not have permission to update this device. Grant View Task update, or NG portal access (same as mark resolved).",
          checkedModules: decision.checkedModules,
          requiredCapability: "operator_task_update or ng_portal_device_write",
          requestId: req.requestId,
        });
      }

      const bodyKeys = Object.keys(req.body || {}).filter((k) => !String(k).startsWith("$"));
      const extra = bodyKeys.filter((k) => !PORTAL_PATCH_ALLOWED_BODY_KEYS.has(k));
      if (extra.length) {
        return res.status(403).json({
          error: "Forbidden",
          message: `For your role, only these fields are allowed on this endpoint: ${[
            ...PORTAL_PATCH_ALLOWED_BODY_KEYS,
          ].join(", ")}. Remove: ${extra.join(", ")}`,
          checkedModules: decision.checkedModules,
          requestId: req.requestId,
        });
      }
      if (Array.isArray(req.files) && req.files.length > 0) {
        return res.status(403).json({
          error: "Forbidden",
          message: "File uploads on this endpoint require View Task update permission.",
          requestId: req.requestId,
        });
      }

      return next();
    } catch (error) {
      console.error("[AUTH] authorizeUpdateStageByDeviceId error:", error);
      return res.status(500).json({ error: "Internal Server Authorization Error" });
    }
  },
  getItems: (req, res) => {
    const sampleData = [
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
    ];
    res.json(sampleData);
  },
};
