const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 500);

const wrapHandlerWithSlowRequestLogging = (handler, label = "handler") => async (req, res, next) => {
  const startedAt = Date.now();
  try {
    await handler(req, res, next);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (durationMs >= SLOW_REQUEST_MS) {
      console.warn("[SLOW_REQUEST]", JSON.stringify({
        label,
        durationMs,
        method: req.method,
        path: req.originalUrl || req.url,
        requestId: req.requestId || "",
        error: error?.message || String(error),
      }));
    }
    throw error;
  } finally {
    if (!res.headersSent) {
      const durationMs = Date.now() - startedAt;
      if (durationMs >= SLOW_REQUEST_MS) {
        console.warn("[SLOW_REQUEST]", JSON.stringify({
          label,
          durationMs,
          method: req.method,
          path: req.originalUrl || req.url,
          requestId: req.requestId || "",
        }));
      }
    }
  }
};

module.exports = {
  SLOW_REQUEST_MS,
  wrapHandlerWithSlowRequestLogging,
};
