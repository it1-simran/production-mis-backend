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

module.exports = {
  login: async (req, res) => {
       try {
        // Call the authenticate method and get the result
        const result = await userService.authenticate(req.body);
    
        // Send the response based on the result's status
        return res.status(result.status).json({
          success: result.success,
          user: result.user,
          message: result.message,
          token: result.token || null, // Include the token if available
        });
      } catch (error) {
        return res.status(500).json({ success: false, message: 'Internal server error' });
      }
  },
  logout: async (req,res) =>{
    res.clearCookie('token');
    res.clearCookie('userDetails');
    res.json({ message: 'Logged out successfully' });
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
      return res.status(403).json({ error });
    }
  },
  authorize: (moduleNames, action) => {
    const modules = Array.isArray(moduleNames) ? moduleNames : [moduleNames];
    return async (req, res, next) => {
      try {
        if (!req.user || !req.user.id) {
          return res.status(401).json({ error: "Unauthorized - No user identity" });
        }

        // Fetch user to get their userType (role)
        const user = await User.findById(req.user.id);
        if (!user) {
          console.log(`>>> [AUTH_TRACE] User not found: ${req.user.id}`);
          return res.status(401).json({ message: "User not found" });
        }

        const normalizedUserType = (user.userType || "").toLowerCase().replace(/[\s-]+/g, "_");
        logToFile(`>>> [AUTH_TRACE] Authorizing user: ${user.email}, role: "${user.userType}", normalized: "${normalizedUserType}"`);

        // Admin and Production Manager always have full access
        if (
          normalizedUserType === "admin" || 
          normalizedUserType === "production_manager" ||
          normalizedUserType === "store_manager" ||
          normalizedUserType === "store_manger" ||
          normalizedUserType === "store" ||
          normalizedUserType === "operator"
        ) {
          logToFile(`>>> [AUTH_TRACE] Full access bypass granted for role: ${normalizedUserType}`);
          return next();
        }

        // Fetch permissions for this role
        const role = await UserTypes.findOne({ name: new RegExp(`^${user.userType}$`, "i") });
        if (!role) {
          logToFile(`>>> [AUTH] Role ${user.userType} not found for user ${user.email}`);
          return res.status(403).json({ error: `Forbidden - Role '${user.userType}' not configured` });
        }

        const permissions = role.permissions || new Map();
        
        // Check if ANY of the modules provide the required permission
        const hasPermission = modules.some(moduleName => {
          const moduleKey = moduleName.toLowerCase().replace(/[\s-]+/g, "_");
          const permsObj = permissions instanceof Map ? permissions.get(moduleKey) : permissions[moduleKey];
          return permsObj && permsObj[action] === true;
        });

        if (!hasPermission) {
          logToFile(`>>> [AUTH] Access denied for ${user.email} on modules: ${modules.join("/")}, action: ${action}`);
          return res.status(403).json({ 
            error: "Forbidden", 
            message: `You do not have permission to ${action} in ${modules[0]}` 
          });
        }

        next();
      } catch (error) {
        console.error(">>> [AUTH] Authorization error:", error);
        return res.status(500).json({ error: "Internal Server Authorization Error" });
      }
    };
  },
  getItems: (req, res) => {
    const sampleData = [
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
    ];
    res.json(sampleData);
  },
};
