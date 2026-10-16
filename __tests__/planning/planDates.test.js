const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parsePlanDate,
  formatPlanDate,
  dayKeyLocal,
  buildHolidayKeys,
  isWorkingDay,
  addWorkingDays,
  buildWindow,
  windowsOverlap,
  toMinutes,
  rangesOverlap,
  dayNumber,
} = require("../../utils/planDates");

const WEEKDAYS_ONLY = { sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false };

test("parsePlanDate accepts the client format, 4-digit years, ISO and Date", () => {
  const a = parsePlanDate("05/10/26 08:30:15");
  assert.equal(dayKeyLocal(a), "2026-10-05");
  assert.equal(a.getHours(), 8);
  assert.equal(dayKeyLocal(parsePlanDate("05/10/2026")), "2026-10-05");
  assert.equal(dayKeyLocal(parsePlanDate("2026-10-05T00:00:00")), "2026-10-05");
  const d = new Date(2026, 9, 5);
  assert.equal(parsePlanDate(d), d);
});

test("parsePlanDate rejects garbage and impossible dates", () => {
  assert.equal(parsePlanDate(""), null);
  assert.equal(parsePlanDate(null), null);
  assert.equal(parsePlanDate("Invalid Date"), null);
  assert.equal(parsePlanDate("31/02/26"), null);
  assert.equal(parsePlanDate("5/10"), null);
  assert.equal(parsePlanDate("NaN/NaN/NaN"), null);
});

test("formatPlanDate is the inverse of parsePlanDate", () => {
  assert.equal(formatPlanDate(parsePlanDate("05/10/26 08:30:15")), "05/10/26 08:30:15");
  assert.equal(formatPlanDate(null), "");
});

test("isWorkingDay honours shift weekdays and holidays", () => {
  const holidays = buildHolidayKeys([{ holidayDate: new Date("2026-10-07T00:00:00.000Z") }]);
  assert.equal(isWorkingDay(new Date(2026, 9, 5), WEEKDAYS_ONLY, holidays), true); // Mon
  assert.equal(isWorkingDay(new Date(2026, 9, 10), WEEKDAYS_ONLY, holidays), false); // Sat
  assert.equal(isWorkingDay(new Date(2026, 9, 7), WEEKDAYS_ONLY, holidays), false); // holiday Wed
  assert.equal(isWorkingDay(new Date(2026, 9, 10), undefined, holidays), true); // no weekDays map
});

test("addWorkingDays does not count the start day and skips days off (legacy behaviour)", () => {
  const start = new Date(2026, 9, 5); // Mon
  const holidays = buildHolidayKeys([]);
  // 1 working day after Monday is Tuesday
  assert.equal(dayKeyLocal(addWorkingDays(start, 1, { weekDays: WEEKDAYS_ONLY, holidayKeys: holidays })), "2026-10-06");
  // fractional days round up to the next working day
  assert.equal(dayKeyLocal(addWorkingDays(start, 0.2, { weekDays: WEEKDAYS_ONLY, holidayKeys: holidays })), "2026-10-06");
  // 5 working days after Monday skips the weekend -> next Monday
  assert.equal(dayKeyLocal(addWorkingDays(start, 5, { weekDays: WEEKDAYS_ONLY, holidayKeys: holidays })), "2026-10-12");
});

test("addWorkingDays skips holidays and returns null when no day ever works", () => {
  const start = new Date(2026, 9, 5);
  const holiday = buildHolidayKeys([{ holidayDate: new Date("2026-10-06T00:00:00.000Z") }]);
  assert.equal(dayKeyLocal(addWorkingDays(start, 1, { weekDays: WEEKDAYS_ONLY, holidayKeys: holiday })), "2026-10-07");
  const never = { sun: false, mon: false, tue: false, wed: false, thu: false, fri: false, sat: false };
  assert.equal(addWorkingDays(start, 1, { weekDays: never, holidayKeys: buildHolidayKeys([]) }), null);
  assert.equal(addWorkingDays(start, 0, {}), null);
  assert.equal(addWorkingDays(null, 3, {}), null);
});

test("shift windows handle overnight shifts", () => {
  assert.equal(toMinutes("09:30"), 570);
  assert.ok(Number.isNaN(toMinutes("25:00")));
  assert.deepEqual(buildWindow("21:00", "05:00"), { start: 1260, end: 1740 });
  assert.deepEqual(buildWindow("09:00", "18:00"), { start: 540, end: 1080 });
  assert.equal(buildWindow("bad", "18:00"), null);
});

test("windowsOverlap: day vs night do not overlap, night vs night and day vs day do", () => {
  const day = buildWindow("09:00", "18:00");
  const night = buildWindow("21:00", "05:00");
  assert.equal(windowsOverlap(day, night), false);
  assert.equal(windowsOverlap(day, buildWindow("08:00", "17:00")), true);
  assert.equal(windowsOverlap(night, buildWindow("22:00", "06:00")), true);
  // an early-morning window overlaps the tail of a night shift that crossed midnight
  assert.equal(windowsOverlap(night, buildWindow("03:00", "08:00")), true);
  // unknown windows are treated conservatively
  assert.equal(windowsOverlap(day, null), true);
});

test("rangesOverlap is inclusive", () => {
  const n = (k) => dayNumber(k);
  assert.equal(rangesOverlap(n("2026-10-05"), n("2026-10-09"), n("2026-10-09"), n("2026-10-12")), true);
  assert.equal(rangesOverlap(n("2026-10-05"), n("2026-10-09"), n("2026-10-10"), n("2026-10-12")), false);
});

test("countWorkingDaysBetween counts (start, end], skipping days off and holidays", () => {
  const { countWorkingDaysBetween } = require("../../utils/planDates");
  const opts = { weekDays: WEEKDAYS_ONLY, holidayKeys: buildHolidayKeys([]) };
  const mon = new Date(2026, 9, 5);
  assert.equal(countWorkingDaysBetween(mon, new Date(2026, 9, 9), opts), 4); // Tue-Fri
  assert.equal(countWorkingDaysBetween(mon, new Date(2026, 9, 12), opts), 5); // weekend skipped
  assert.equal(countWorkingDaysBetween(mon, mon, opts), 0);
  assert.equal(countWorkingDaysBetween(new Date(2026, 9, 9), mon, opts), 0);
  assert.equal(countWorkingDaysBetween(null, mon, opts), 0);
  const holiday = { weekDays: WEEKDAYS_ONLY, holidayKeys: buildHolidayKeys([{ holidayDate: new Date("2026-10-07T00:00:00.000Z") }]) };
  assert.equal(countWorkingDaysBetween(mon, new Date(2026, 9, 9), holiday), 3);
  // inverse of addWorkingDays
  const end = addWorkingDays(mon, 6, opts);
  assert.equal(countWorkingDaysBetween(mon, end, opts), 6);
});

test("dayKeyFromNumber is the inverse of dayNumber", () => {
  const { dayKeyFromNumber } = require("../../utils/planDates");
  assert.equal(dayKeyFromNumber(dayNumber("2026-10-05")), "2026-10-05");
  assert.equal(dayKeyFromNumber(dayNumber("2026-12-31") + 1), "2027-01-01");
  assert.equal(dayKeyFromNumber(NaN), "");
});

test("listWorkingDayKeys includes both ends, skips days off and holidays, and reports truncation", () => {
  const { listWorkingDayKeys } = require("../../utils/planDates");
  const holidayKeys = buildHolidayKeys([{ holidayDate: new Date("2026-10-07T00:00:00.000Z") }]);
  const opts = { weekDays: WEEKDAYS_ONLY, holidayKeys };
  assert.deepEqual(listWorkingDayKeys("2026-10-05", "2026-10-13", opts), {
    keys: ["2026-10-05", "2026-10-06", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"],
    truncated: false,
  });
  assert.deepEqual(listWorkingDayKeys("2026-10-10", "2026-10-11", opts).keys, [], "a weekend has none");
  assert.deepEqual(listWorkingDayKeys("2026-10-09", "2026-10-05", opts), { keys: [], truncated: false }, "reversed range");
  assert.deepEqual(listWorkingDayKeys("", "2026-10-05", opts), { keys: [], truncated: false });
  const cut = listWorkingDayKeys("2026-10-05", "2026-10-30", { ...opts, limit: 3 });
  assert.equal(cut.keys.length, 3);
  assert.equal(cut.truncated, true);
  assert.equal(listWorkingDayKeys("2026-10-05", "2026-10-09", { weekDays: WEEKDAYS_ONLY, limit: 5 }).truncated, false, "exactly at the limit is not truncated");
});
