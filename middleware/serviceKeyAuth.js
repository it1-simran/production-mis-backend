/**
 * Machine-to-machine auth for trusted integration callers (e.g. GPS CPanel
 * pushing/reading Purchase Orders). Unlike authenticateToken, there is no user
 * identity — access is granted purely by a shared secret carried in the
 * `x-api-key` header, matched against process.env.CPANEL_API_KEY.
 */
module.exports = function serviceKeyAuth(req, res, next) {
  const expected = process.env.CPANEL_API_KEY;

  if (!expected) {
    return res.status(503).json({
      status: 503,
      message: "Integration is not configured on the server (CPANEL_API_KEY missing).",
    });
  }

  const provided = req.get("x-api-key");
  if (!provided || provided !== expected) {
    return res.status(401).json({
      status: 401,
      message: "Unauthorized - invalid or missing API key.",
    });
  }

  next();
};
