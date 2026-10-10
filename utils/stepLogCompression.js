const zlib = require("zlib");

// Compresses each step's heavy logData (terminalLogs/parsedData/configuredFields
// from the jig) into a gzip Buffer before it's saved on deviceTestRecords.logs.
// logDataCompressed marks which steps were stored this way, so old records
// (saved before this existed) are left untouched and still read back as plain
// objects - see decompressStepLogs below.
function compressStepLogsForStorage(steps) {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step) => {
    if (!step || step.logData === undefined || step.logData === null) return step;
    try {
      const json = JSON.stringify(step.logData);
      const gzipped = zlib.gzipSync(Buffer.from(json, "utf8"));
      return { ...step, logData: gzipped, logDataCompressed: true };
    } catch (err) {
      console.error("[LOG-COMPRESS] Failed to compress step logData, storing uncompressed:", err.message);
      return step;
    }
  });
}

// Restores a step's logData to its original object shape. Safe to call on
// steps that were never compressed (logDataCompressed falsy) - returned as-is.
function decompressStepLogs(step) {
  if (!step || !step.logDataCompressed || step.logData === undefined || step.logData === null) return step;
  try {
    const buf = Buffer.isBuffer(step.logData)
      ? step.logData
      : Buffer.from(step.logData.buffer || step.logData);
    step.logData = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
    step.logDataCompressed = false;
  } catch (err) {
    console.error("[LOG-DECOMPRESS] Failed to decompress step logData:", err.message);
  }
  return step;
}

// Mutates doc.logs in place, decompressing every compressed step. Safe on
// docs with no logs field (queries that projected it out) - no-op.
function decompressDocLogs(doc) {
  if (doc && Array.isArray(doc.logs)) {
    doc.logs.forEach(decompressStepLogs);
  }
  return doc;
}

module.exports = { compressStepLogsForStorage, decompressStepLogs, decompressDocLogs };
