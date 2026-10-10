// Date and calendar helpers for the v2 Planning & Scheduling flow.
//
// Conventions (kept identical to what the legacy Add page and `create` handler do so
// plans written by either flow are interchangeable):
//  - The client sends dates as "DD/MM/YY HH:mm:ss" (also accepted: "DD/MM/YYYY ...", ISO, Date).
//  - A plan date is turned into a Date using the server's LOCAL time, and its calendar day is read
//    back with local getters. Holidays are stored as instants, so their calendar day is read in the
//    plant timezone (TIMEZONE env, default Asia/Kolkata).
//  - "End date" is start + N working days, where the start day itself is not counted
//    (this is the legacy `calculateEstimatedEndDate` behaviour).

const momentTz = require("moment-timezone");

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, "0");

const validDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

// Returns a Date or null. Never throws.
const parsePlanDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return validDate(value) ? value : null;
  if (typeof value !== "string") {
    const d = new Date(value);
    return validDate(d) ? d : null;
  }
  const text = value.trim();
  if (!text || text === "Invalid Date" || text.includes("NaN")) return null;

  if (text.includes("/")) {
    const [datePart, timePart] = text.split(/\s+/);
    const parts = datePart.split("/");
    if (parts.length !== 3) return null;
    const day = Number(parts[0]);
    const month = Number(parts[1]);
    let year = Number(parts[2]);
    if (![day, month, year].every(Number.isFinite)) return null;
    if (year < 100) year += 2000;
    const [h, m, s] = (timePart || "0:0:0").split(":").map((x) => Number(x) || 0);
    const d = new Date(year, month - 1, day, h, m, s);
    // Reject roll-overs such as 31/02 -> 03/03.
    if (!validDate(d) || d.getDate() !== day || d.getMonth() !== month - 1) return null;
    return d;
  }

  const d = new Date(text);
  return validDate(d) ? d : null;
};

// "DD/MM/YY HH:mm:ss" using local getters (inverse of parsePlanDate).
const formatPlanDate = (date) => {
  if (!validDate(date)) return "";
  return (
    `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${String(date.getFullYear()).slice(-2)} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
};

// Calendar-day keys ("YYYY-MM-DD").
const dayKeyLocal = (date) =>
  validDate(date) ? `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` : "";

const dayKeyTz = (date) => (validDate(date) ? momentTz(date).tz(TZ).format("YYYY-MM-DD") : "");

// Integer day number for a key; lets ranges be compared without timezone arithmetic.
const dayNumber = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY);
};

// Inverse of dayNumber: integer day number -> "YYYY-MM-DD".
const dayKeyFromNumber = (n) => (Number.isFinite(n) ? new Date(n * MS_PER_DAY).toISOString().slice(0, 10) : "");

const weekdayOfKey = (key) => {
  const n = dayNumber(key);
  if (!Number.isFinite(n)) return -1;
  return new Date(n * MS_PER_DAY).getUTCDay();
};

const buildHolidayKeys = (holidays = []) => {
  const keys = new Set();
  (Array.isArray(holidays) ? holidays : []).forEach((h) => {
    const key = dayKeyTz(parsePlanDate(h?.holidayDate));
    if (key) keys.add(key);
  });
  return keys;
};

// weekDays is the shift's { sun..sat: boolean }. A missing map means "every day works".
const isWorkingDayKey = (key, weekDays, holidayKeys) => {
  if (!key) return false;
  if (weekDays && typeof weekDays === "object") {
    const name = DAY_NAMES[weekdayOfKey(key)];
    if (name && !weekDays[name]) return false;
  }
  if (holidayKeys && holidayKeys.has(key)) return false;
  return true;
};

const isWorkingDay = (date, weekDays, holidayKeys) => isWorkingDayKey(dayKeyLocal(date), weekDays, holidayKeys);

// Start + `days` working days (start day not counted; fractional days round up to the next
// working day, exactly like the legacy loop). Returns a Date at the start's time of day, or
// null when no working day can be found within ~10 years.
const addWorkingDays = (startDate, days, { weekDays, holidayKeys } = {}) => {
  if (!validDate(startDate) || !(days > 0)) return null;
  const cursor = new Date(startDate.getTime());
  let remaining = days;
  let guard = 0;
  while (remaining > 0 && guard < 4000) {
    guard += 1;
    cursor.setDate(cursor.getDate() + 1);
    if (isWorkingDay(cursor, weekDays, holidayKeys)) remaining -= 1;
  }
  return remaining > 0 ? null : cursor;
};

// Working days in (start, end]: the start day is not counted and the end day is, which is the
// inverse of addWorkingDays (start + N working days ends on the Nth counted day).
const countWorkingDaysBetween = (startDate, endDate, { weekDays, holidayKeys } = {}) => {
  if (!validDate(startDate) || !validDate(endDate)) return 0;
  const cursor = new Date(startDate.getTime());
  let count = 0;
  let guard = 0;
  while (guard < 4000) {
    guard += 1;
    cursor.setDate(cursor.getDate() + 1);
    if (dayKeyLocal(cursor) > dayKeyLocal(endDate)) break;
    if (isWorkingDay(cursor, weekDays, holidayKeys)) count += 1;
  }
  return count;
};

// Working-day keys from startKey to endKey, BOTH ends included (a day off at either end is simply
// absent). Unlike addWorkingDays this works purely on keys, so it has no time-of-day or local-time
// subtleties. Stops after `limit` keys; `truncated` tells the caller the range was longer.
const listWorkingDayKeys = (startKey, endKey, { weekDays, holidayKeys, limit = 4000 } = {}) => {
  const first = dayNumber(startKey);
  const last = dayNumber(endKey);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return { keys: [], truncated: false };
  const keys = [];
  for (let n = first; n <= last; n += 1) {
    const key = dayKeyFromNumber(n);
    if (!isWorkingDayKey(key, weekDays, holidayKeys)) continue;
    if (keys.length >= limit) return { keys, truncated: true };
    keys.push(key);
  }
  return { keys, truncated: false };
};

const nextWorkingDay = (date, { weekDays, holidayKeys } = {}) => {
  if (!validDate(date)) return null;
  const cursor = new Date(date.getTime());
  for (let i = 0; i < 366; i += 1) {
    if (isWorkingDay(cursor, weekDays, holidayKeys)) return cursor;
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
};

// ---- shift time windows (minutes since midnight, overnight aware) ----

const toMinutes = (text) => {
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(String(text || ""));
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
};

// { start, end } with end > start; an overnight shift gets end += 1440. Null if unparsable.
const buildWindow = (startTime, endTime) => {
  const start = toMinutes(startTime);
  let end = toMinutes(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) end += 1440;
  return { start, end };
};

// Do two daily windows overlap, allowing for either one crossing midnight?
const windowsOverlap = (a, b) => {
  if (!a || !b) return true; // unknown window: be conservative
  return [-1440, 0, 1440].some((shift) => a.start < b.end + shift && b.start + shift < a.end);
};

const rangesOverlap = (aStart, aEnd, bStart, bEnd) => aStart <= bEnd && bStart <= aEnd;

module.exports = {
  TZ,
  parsePlanDate,
  formatPlanDate,
  dayKeyLocal,
  dayKeyTz,
  dayNumber,
  dayKeyFromNumber,
  weekdayOfKey,
  buildHolidayKeys,
  isWorkingDayKey,
  isWorkingDay,
  addWorkingDays,
  countWorkingDaysBetween,
  listWorkingDayKeys,
  nextWorkingDay,
  toMinutes,
  buildWindow,
  windowsOverlap,
  rangesOverlap,
};
