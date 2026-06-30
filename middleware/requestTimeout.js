const createRequestTimeoutMiddleware = (timeoutMs = 15000) => (req, res, next) => {
  const timer = setTimeout(() => {
    if (res.headersSent) return;

    console.warn("[SLOW_REQUEST]", JSON.stringify({
      method: req.method,
      path: req.originalUrl || req.url,
      requestId: req.requestId || "",
      timeoutMs,
    }));

    res.status(504).json({
      status: 504,
      message: "Request timed out. Please try again.",
    });
  }, timeoutMs);

  const clearTimer = () => clearTimeout(timer);
  res.on("finish", clearTimer);
  res.on("close", clearTimer);

  next();
};

module.exports = {
  createRequestTimeoutMiddleware,
};
