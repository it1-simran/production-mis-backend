const createRequestTimeoutMiddleware = (timeoutMs = 15000) => (req, res, next) => {
  const timer = setTimeout(() => {
    if (res.headersSent) return;

    // If the handler exposed a live `timings` object (see deviceController's
    // createDeviceTestEntry), snapshot it here — this is the only place we can
    // see which phases had completed and which was still in flight when the
    // budget ran out, since a hard timeout skips the handler's own
    // completion-time timing log entirely.
    const partialTimings = req.timings ? { ...req.timings } : undefined;
    const elapsedMs = req.timingsStartedAt ? Date.now() - req.timingsStartedAt : undefined;

    console.warn("[SLOW_REQUEST]", JSON.stringify({
      method: req.method,
      path: req.originalUrl || req.url,
      requestId: req.requestId || "",
      timeoutMs,
      elapsedMs,
      partialTimings,
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
