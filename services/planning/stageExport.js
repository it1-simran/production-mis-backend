// The stage drawer's CSV exports: the rows of a device bucket and the attempt history. PURE (the time zone comes from the engine's setting).

const { toCsv } = require("./csv");

const WIP_SOURCE = {
  resolved: "Resolved, back at this stage",
  passed_previous: "Passed the previous stage",
  untested: "Not tested yet",
  at_stage: "At this stage",
};

// "2026-10-07 09:15:00" in the plant's time zone; empty when there is no time
const plantTime = (value) => {
  if (!value) return "";
  const moment = require("moment-timezone");
  const { PLANNING_TIMEZONE } = require("../planInsightsService");
  const m = moment.tz(value, PLANNING_TIMEZONE);
  return m.isValid() ? m.format("YYYY-MM-DD HH:mm:ss") : "";
};
const seconds = (ms) => (ms && ms > 0 ? Math.round(ms / 1000) : "");

const devicesCsv = (bucket, rows) => {
  if (bucket === "wip") {
    return toCsv(
      [
        { header: "Serial", value: (r) => r.serialNo },
        { header: "Seat", value: (r) => r.seatKey },
        { header: "Why it is here", value: (r) => WIP_SOURCE[r.source] || r.source || "" },
        { header: "Since", value: (r) => plantTime(r.since) },
        { header: "From stage", value: (r) => r.fromStage },
        { header: "Operator", value: (r) => r.operator?.name },
      ],
      rows
    );
  }
  return toCsv(
    [
      { header: "Serial", value: (r) => r.serialNo },
      { header: "Seat", value: (r) => r.seatKey },
      { header: "Operator", value: (r) => r.operator?.name },
      { header: "Employee code", value: (r) => r.operator?.employeeCode },
      { header: "Result", value: (r) => r.status },
      { header: "When", value: (r) => plantTime(r.at) },
      { header: "Test time (seconds)", value: (r) => seconds(r.durationMs) },
      { header: "Attempt", value: (r) => r.attemptNumber },
      { header: "Reason", value: (r) => r.reason },
      { header: "Next stage", value: (r) => r.nextStage },
      { header: "Assigned to", value: (r) => r.assignedTo },
    ],
    rows
  );
};

const historyCsv = (rows) =>
  toCsv(
    [
      { header: "When", value: (r) => plantTime(r.at) },
      { header: "Serial", value: (r) => r.serialNo },
      { header: "Seat", value: (r) => r.seatKey },
      { header: "Operator", value: (r) => r.operator?.name },
      { header: "Employee code", value: (r) => r.operator?.employeeCode },
      { header: "Result", value: (r) => r.status },
      { header: "Outcome", value: (r) => r.outcome },
      { header: "Attempt", value: (r) => r.attempt },
      { header: "Attempts on this device", value: (r) => r.attemptsOnDevice },
      { header: "Test time (seconds)", value: (r) => seconds(r.durationMs) },
      { header: "Reason", value: (r) => r.reason },
      { header: "Retry reason", value: (r) => r.reattemptReason },
      { header: "Next stage", value: (r) => r.nextStage },
      { header: "Assigned to", value: (r) => r.assignedTo },
    ],
    rows
  );

module.exports = { devicesCsv, historyCsv, plantTime };
