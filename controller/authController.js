const AuthService = require("../services/authService");
const UserService = require("../services/userService");
const authService = new AuthService(
  process.env.JWT_SECRET || "your-secret-key"
);
const userService = new UserService();

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
      
      const user = await authService.verifyToken(token);
      console.log(">>> [AUTH_TRACE] Token verified for", user?.id || user?._id || "unknown");
      req.user = user;
      next();
    } catch (error) {
      console.error(">>> [AUTH_TRACE] Error verifying token:", error);
      return res.status(403).json({ error });
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
