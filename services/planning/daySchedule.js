// Custom day-wise schedule (replaces the fixed shift when a plan uses scheduleMode "custom").
// PURE: no database, no clock. See PLANNING_CUSTOM_DAY_SCHEDULE_APPROACH.md.
//
// A plan's schedule is a list of day entries:
//   { dayKey:"2026-10-12", startTime:"09:30", endTime:"18:30", breaks:[{startTime,endTime}],
//     unplacedBreakMinutes:0, working:true, edited:false, note:"" }
//
// An end time at or before the start time means the day runs past midnight. The production day is
// the day it STARTS (same convention as dayGenerator). A shift is only an optional TEMPLATE: it
// supplies default hours, weekly days off and breaks (templateFromShift).
//
// Exports: time and break maths, buildDaySchedule (generate/regenerate the table),
// validateDaySchedule (the SCH-* checks), and normalisers for untrusted input.

const {
  buildWindow,
  toMinutes,
  dayNumber,
  dayKeyFromNumber,
  weekdayOfKey,
  isWorkingDayKey,
} = require("../../utils/planDates");
const { getProductiveMinutes } = require("./capacity");

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_RANGE_DAYS = 366;
const MAX_BREAKS_PER_DAY = 6;
const MAX_NOTE_LENGTH = 200;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const problem = (code, severity, message, extra = {}) => ({ code, severity, message, ...extra });

// ---- times ----------------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");

// "9:30", "09:30:00" -> "09:30"; anything unparsable -> "".
const normTime = (text) => {
  const minutes = toMinutes(text);
  return Number.isFinite(minutes) ? `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}` : "";
};

// A day's window in minutes since its own midnight; `end` may exceed 1440 for an overnight day.
const windowOf = (entry) => buildWindow(entry?.startTime, entry?.endTime);

// ---- breaks ---------------------------------------------------------------------------------

// The pieces of one break that fall inside a window. A break is HH:mm to HH:mm; one that is
// "before" the window start in clock terms (01:00 inside a 21:00-05:00 day) belongs to the next
// morning, so both the break and the break + 24h are tried.
const breakPieces = (brk, window) => {
  const start = toMinutes(brk?.startTime);
  let end = toMinutes(brk?.endTime);
  if (!window || !Number.isFinite(start) || !Number.isFinite(end)) return [];
  if (end <= start) end += 1440;
  const pieces = [];
  [0, 1440].forEach((shift) => {
    const lo = Math.max(start + shift, window.start);
    const hi = Math.min(end + shift, window.end);
    if (hi > lo) pieces.push([lo, hi]);
  });
  return pieces;
};

const mergeIntervals = (intervals) => {
  const sorted = intervals.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  sorted.forEach(([a, b]) => {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  });
  return out;
};

// Minutes of the day's breaks that lie inside its window (overlapping breaks are not counted twice).
const breakMinutesInside = (window, breaks) => {
  if (!window) return 0;
  const pieces = [];
  (Array.isArray(breaks) ? breaks : []).forEach((b) => breakPieces(b, window).forEach((p) => pieces.push(p)));
  return mergeIntervals(pieces).reduce((sum, [a, b]) => sum + (b - a), 0);
};

// Working minutes of a day: the window minus the breaks inside it (and any unplaced break minutes,
// used when a template shift only records a break total, not break times).
const productiveMinutesOf = (entry) => {
  const window = windowOf(entry);
  if (!window) return 0;
  const length = window.end - window.start;
  const unplaced = Number(entry?.unplacedBreakMinutes) > 0 ? Number(entry.unplacedBreakMinutes) : 0;
  return Math.max(0, length - breakMinutesInside(window, entry?.breaks) - unplaced);
};

// ---- the optional template shift -------------------------------------------------------------

// Default hours, weekly days off and breaks taken from a shift record.
const templateFromShift = (shift) => {
  if (!shift) return null;
  const intervals = Array.isArray(shift.intervals) ? shift.intervals : [];
  const breaks = intervals
    .filter((i) => i && i.breakTime)
    .map((i) => ({ startTime: normTime(i.startTime), endTime: normTime(i.endTime) }))
    .filter((b) => b.startTime && b.endTime);
  return {
    startTime: normTime(shift.startTime),
    endTime: normTime(shift.endTime),
    weekDays: shift.weekDays && typeof shift.weekDays === "object" ? { ...shift.weekDays } : null,
    breaks,
    // A shift that records only a break total (no break times) still has to lose those minutes.
    unplacedBreakMinutes: breaks.length === 0 ? Math.max(0, Number(shift.totalBreakTime) || 0) : 0,
    productiveMinutes: getProductiveMinutes(shift),
  };
};

// ---- normalising untrusted input ------------------------------------------------------------

const normalizeBreak = (raw) => ({ startTime: normTime(raw?.startTime), endTime: normTime(raw?.endTime) });

const normalizeDayEntry = (raw) => {
  const unplaced = Number(raw?.unplacedBreakMinutes);
  return {
    dayKey: String(raw?.dayKey || "").trim(),
    startTime: normTime(raw?.startTime),
    endTime: normTime(raw?.endTime),
    breaks: (Array.isArray(raw?.breaks) ? raw.breaks : []).slice(0, MAX_BREAKS_PER_DAY).map(normalizeBreak),
    unplacedBreakMinutes: Number.isFinite(unplaced) && unplaced > 0 ? Math.min(unplaced, 1440) : 0,
    working: raw?.working !== false && raw?.working !== "false" && raw?.working !== 0,
    edited: raw?.edited === true || raw?.edited === "true",
    note: String(raw?.note || "").slice(0, MAX_NOTE_LENGTH),
  };
};

// Accepts an array (or a JSON string of one). Order and duplicates are kept so validation can report them.
const normalizeDaySchedule = (input) => {
  let list = input;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e === "object")
    .slice(0, MAX_RANGE_DAYS + 50)
    .map(normalizeDayEntry);
};

// ---- calendar -------------------------------------------------------------------------------

const dayOffReason = (dayKey, weekDays, holidayKeys) => {
  if (weekDays && typeof weekDays === "object") {
    const name = DAY_NAMES[weekdayOfKey(dayKey)];
    if (name && !weekDays[name]) return "weekly_off";
  }
  if (holidayKeys && holidayKeys.has(dayKey)) return "holiday";
  return null;
};

// ---- building the table ---------------------------------------------------------------------

// Generates one entry per calendar day from startKey to endKey, filled from `defaults`.
//   defaults  { startTime, endTime, weekDays?, breaks?, unplacedBreakMinutes? }  (e.g. from templateFromShift)
// Weekly days off and holidays come out as working:false (still listed, so the planner can switch
// them on). With includeHolidays a holiday is scheduled instead. `existing` is the table so far:
// entries the planner edited by hand (edited:true) are kept exactly; the rest are regenerated.
const buildDaySchedule = ({ startKey, endKey, defaults, holidayKeys = new Set(), existing = [], includeHolidays = false } = {}) => {
  const problems = [];
  const first = dayNumber(startKey);
  const last = dayNumber(endKey);
  if (!DAY_KEY.test(String(startKey || "")) || !DAY_KEY.test(String(endKey || "")) || !Number.isFinite(first) || !Number.isFinite(last)) {
    problems.push(problem("SCH-004", "error", "The start and end dates must be valid dates."));
    return { ok: false, days: [], dropped: [], problems };
  }
  if (last < first) {
    problems.push(problem("CAL-005", "error", "The end date is before the start date."));
    return { ok: false, days: [], dropped: [], problems };
  }
  if (last - first + 1 > MAX_RANGE_DAYS) {
    problems.push(problem("SCH-010", "error", `The schedule can cover at most ${MAX_RANGE_DAYS} days.`));
    return { ok: false, days: [], dropped: [], problems };
  }
  const startTime = normTime(defaults?.startTime);
  const endTime = normTime(defaults?.endTime);
  if (!startTime || !endTime) {
    problems.push(problem("SCH-001", "error", "The default start and end times must be valid HH:mm values.", { field: "scheduleDefaults" }));
    return { ok: false, days: [], dropped: [], problems };
  }

  const keptByKey = new Map();
  normalizeDaySchedule(existing).forEach((e) => {
    if (e.edited && DAY_KEY.test(e.dayKey) && !keptByKey.has(e.dayKey)) keptByKey.set(e.dayKey, e);
  });

  const defaultBreaks = (Array.isArray(defaults?.breaks) ? defaults.breaks : []).map(normalizeBreak).filter((b) => b.startTime && b.endTime);
  const defaultUnplaced = Number(defaults?.unplacedBreakMinutes) > 0 ? Number(defaults.unplacedBreakMinutes) : 0;

  const days = [];
  for (let n = first; n <= last; n += 1) {
    const dayKey = dayKeyFromNumber(n);
    const kept = keptByKey.get(dayKey);
    if (kept) {
      days.push({ ...kept, breaks: kept.breaks.map((b) => ({ ...b })), offReason: dayOffReason(dayKey, defaults?.weekDays, holidayKeys) });
      continue;
    }
    const reason = dayOffReason(dayKey, defaults?.weekDays, holidayKeys);
    days.push({
      dayKey,
      startTime,
      endTime,
      breaks: defaultBreaks.map((b) => ({ ...b })),
      unplacedBreakMinutes: defaultUnplaced,
      working: !reason || (reason === "holiday" && includeHolidays),
      edited: false,
      note: "",
      offReason: reason,
    });
  }

  const dropped = Array.from(keptByKey.keys()).filter((k) => dayNumber(k) < first || dayNumber(k) > last);
  return { ok: true, days, dropped, problems };
};

// ---- the SCH-* checks -----------------------------------------------------------------------

// `weekDays` and `holidayKeys` describe the plant calendar (usually the template shift's weekdays).
// `template` (templateFromShift) is optional and only used for SCH-008.
const validateDaySchedule = ({ days = [], startKey, endKey, weekDays = null, holidayKeys = new Set(), template = null, maxDayHours = 16 } = {}) => {
  const problems = [];
  const first = dayNumber(startKey);
  const last = dayNumber(endKey);
  const seen = new Set();
  const working = [];

  days.forEach((entry) => {
    const key = entry.dayKey;
    if (!DAY_KEY.test(key) || !Number.isFinite(dayNumber(key))) {
      problems.push(problem("SCH-004", "error", `"${key || "(blank)"}" is not a valid day.`, { dayKey: key }));
      return;
    }
    if (seen.has(key)) {
      problems.push(problem("SCH-004", "error", `${key} is listed more than once.`, { dayKey: key }));
      return;
    }
    seen.add(key);
    const n = dayNumber(key);
    if (Number.isFinite(first) && Number.isFinite(last) && (n < first || n > last)) {
      problems.push(problem("SCH-004", "error", `${key} is outside the plan's start and end dates.`, { dayKey: key }));
      return;
    }
    if (!entry.working) return;

    const window = windowOf(entry);
    if (!window) {
      problems.push(problem("SCH-001", "error", `${key} needs a valid start and end time (HH:mm).`, { dayKey: key }));
      return;
    }
    const length = window.end - window.start;
    if (length >= 1440) {
      problems.push(problem("SCH-002", "error", `${key} starts and ends at the same time, which is a 24-hour day. Check the times.`, { dayKey: key }));
      return;
    }
    if (length > maxDayHours * 60) {
      problems.push(problem("SCH-002", "warning", `${key} is ${Math.round((length / 60) * 10) / 10} hours long, more than the usual ${maxDayHours}.`, { dayKey: key }));
    }

    const reason = dayOffReason(key, weekDays, holidayKeys);
    if (reason) {
      problems.push(
        problem("SCH-005", "warning", `${key} is ${reason === "holiday" ? "a plant holiday" : "a weekly day off"} but is scheduled to work.`, { dayKey: key, reason }),
      );
    }

    // breaks
    const pieceSets = [];
    (entry.breaks || []).forEach((b, i) => {
      const startOk = toMinutes(b.startTime);
      const endOk = toMinutes(b.endTime);
      if (!Number.isFinite(startOk) || !Number.isFinite(endOk)) {
        problems.push(problem("SCH-006", "warning", `${key}: break ${i + 1} needs valid start and end times.`, { dayKey: key }));
        return;
      }
      const pieces = breakPieces(b, window);
      const raw = (() => {
        let e = endOk;
        if (e <= startOk) e += 1440;
        return e - startOk;
      })();
      const inside = mergeIntervals(pieces).reduce((sum, [a, c]) => sum + (c - a), 0);
      if (inside === 0) problems.push(problem("SCH-006", "warning", `${key}: break ${b.startTime}-${b.endTime} is outside the working hours.`, { dayKey: key }));
      else if (inside < raw) problems.push(problem("SCH-006", "warning", `${key}: break ${b.startTime}-${b.endTime} runs past the working hours.`, { dayKey: key }));
      pieceSets.push({ b, pieces });
    });
    for (let i = 0; i < pieceSets.length; i += 1) {
      for (let j = i + 1; j < pieceSets.length; j += 1) {
        const overlaps = pieceSets[i].pieces.some(([a1, b1]) => pieceSets[j].pieces.some(([a2, b2]) => a1 < b2 && a2 < b1));
        if (overlaps) {
          problems.push(
            problem("SCH-006", "warning", `${key}: breaks ${pieceSets[i].b.startTime}-${pieceSets[i].b.endTime} and ${pieceSets[j].b.startTime}-${pieceSets[j].b.endTime} overlap.`, { dayKey: key }),
          );
        }
      }
    }
    if (productiveMinutesOf(entry) <= 0) {
      problems.push(problem("SCH-006", "warning", `${key} has no productive time once the breaks are taken out.`, { dayKey: key }));
    }

    working.push({ key, n, window });
  });

  // a day must finish before the next scheduled day of the same plan starts
  working
    .sort((a, b) => a.n - b.n)
    .forEach((cur, i, arr) => {
      const next = arr[i + 1];
      if (!next) return;
      const curEnd = cur.n * 1440 + cur.window.end;
      const nextStart = next.n * 1440 + next.window.start;
      if (curEnd > nextStart) {
        problems.push(problem("SCH-003", "error", `${cur.key} runs until after ${next.key} starts, so the two days overlap.`, { dayKey: cur.key, otherDayKey: next.key }));
      }
    });

  // days the calendar says should work but are missing from the list (SCH-007)
  if (Number.isFinite(first) && Number.isFinite(last) && weekDays) {
    const missing = [];
    for (let n = first; n <= last; n += 1) {
      const key = dayKeyFromNumber(n);
      if (!seen.has(key) && isWorkingDayKey(key, weekDays, holidayKeys)) missing.push(key);
    }
    if (missing.length) {
      problems.push(problem("SCH-007", "info", `${missing.length} working day${missing.length === 1 ? " is" : "s are"} missing from the schedule (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " ..." : ""}).`, { dayKeys: missing }));
    }
  }

  // hours differing from the template shift (SCH-008, one summary)
  if (template && template.startTime && template.endTime) {
    const different = days.filter((e) => e.working && (normTime(e.startTime) !== template.startTime || normTime(e.endTime) !== template.endTime)).map((e) => e.dayKey);
    if (different.length) {
      problems.push(
        problem("SCH-008", "info", `${different.length} day${different.length === 1 ? " uses" : "s use"} hours different from the template shift (${template.startTime}-${template.endTime}).`, { dayKeys: different }),
      );
    }
  }

  return problems;
};

module.exports = {
  DAY_NAMES,
  MAX_RANGE_DAYS,
  normTime,
  windowOf,
  breakPieces,
  breakMinutesInside,
  productiveMinutesOf,
  templateFromShift,
  normalizeDayEntry,
  normalizeDaySchedule,
  dayOffReason,
  buildDaySchedule,
  validateDaySchedule,
};
