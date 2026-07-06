const crypto = require("crypto");

const inFlightRequests = new Map();
const ORPHAN_TTL_MS = 3000;

const buildSubmitSignature = (req) => {
  const body = req.body || {};
  const userId = String(req.user?.id || req.user?._id || "").trim();
  const deviceIdsSignature = Array.isArray(body.devices)
    ? body.devices
        .map((deviceId) => String(deviceId || "").trim())
        .filter(Boolean)
        .sort()
        .join(",")
    : "";
  const parts = [
    userId,
    String(body.deviceId || "").trim(),
    deviceIdsSignature,
    String(body.planId || "").trim(),
    String(body.processId || "").trim(),
    String(body.selectedCarton || "").trim(),
    String(body.stageName || body.currentLogicalStage || "").trim(),
    String(body.status || "").trim().toLowerCase(),
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
};

const releaseInFlight = (signature) => {
  if (!signature) return;
  const entry = inFlightRequests.get(signature);
  if (!entry) return;
  if (entry.timeoutId) {
    clearTimeout(entry.timeoutId);
  }
  inFlightRequests.delete(signature);
};

const submitDeduplicationMiddleware = (req, res, next) => {
  const signature = buildSubmitSignature(req);
  if (!signature || signature === crypto.createHash("sha256").update("").digest("hex")) {
    return next();
  }

  if (inFlightRequests.has(signature)) {
    return res.status(409).json({
      status: 409,
      message: "Submit already in progress. Please wait for the current submission to finish.",
    });
  }

  const timeoutId = setTimeout(() => {
    inFlightRequests.delete(signature);
  }, ORPHAN_TTL_MS);

  inFlightRequests.set(signature, { timeoutId, startedAt: Date.now() });

  res.on("finish", () => releaseInFlight(signature));
  res.on("close", () => releaseInFlight(signature));

  return next();
};

module.exports = {
  submitDeduplicationMiddleware,
};
