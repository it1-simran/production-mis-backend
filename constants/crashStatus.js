// Status written on a device (and its history row) when TRC crashes - scraps -
// an NG unit (POST /devices/trash). Older data may still carry the previous
// label "Trashed"; both values mean the same thing everywhere they are read.
const CRASHED_STATUS = "Crashed";
const CRASHED_STATUS_VALUES = ["Crashed", "Trashed"];
const CRASHED_STATUS_KEYS = new Set(CRASHED_STATUS_VALUES.map((value) => value.toLowerCase()));

const isCrashedStatus = (status) => CRASHED_STATUS_KEYS.has(String(status ?? "").trim().toLowerCase());

module.exports = { CRASHED_STATUS, CRASHED_STATUS_VALUES, isCrashedStatus };
