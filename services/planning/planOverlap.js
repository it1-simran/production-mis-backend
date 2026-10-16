// Do two plans clash in time? PURE.
//
// Until now a plan had ONE daily window, so two plans clashed when their date ranges overlapped and
// their windows overlapped. A custom day-wise schedule has a different window on every day, so the
// test becomes: does any day of one plan overlap any day of the other?
//
//   plansOverlap(a, b, { ignoreRange })
//     a, b   a validator "computed" object or a planSummary.summarizePlan() result:
//              { custom, dayWindows:[{absStart,absEnd,start,end}], startDay, endDay, window }
//     ignoreRange  true for a plan that already ENDED but still holds its seats (an "overrun"):
//              only the time of day matters then, not the dates.
//
// When NEITHER plan is custom this is exactly the test the validator has always used, so existing
// results do not change.

const { rangesOverlap, windowsOverlap } = require("../../utils/planDates");

const MAX_EXPANDED_DAYS = 3700;

// A shift plan holds its window on every calendar day of its range (what the range test meant).
const windowsFromRange = (startDay, endDay, window) => {
  if (!Number.isFinite(startDay) || !Number.isFinite(endDay) || endDay < startDay) return [];
  const out = [];
  const last = Math.min(endDay, startDay + MAX_EXPANDED_DAYS);
  for (let day = startDay; day <= last; day += 1) {
    const start = window ? window.start : 0;
    const end = window ? window.end : 1440;
    out.push({ absStart: day * 1440 + start, absEnd: day * 1440 + end, start, end });
  }
  return out;
};

const dayWindowsOf = (plan) => (plan.custom ? plan.dayWindows || [] : windowsFromRange(plan.startDay, plan.endDay, plan.window));

// Both lists are sorted by start and each list's windows do not overlap each other (a plan cannot
// clash with itself), so one forward sweep is enough.
const anyWindowsOverlap = (listA, listB) => {
  let i = 0;
  let j = 0;
  while (i < listA.length && j < listB.length) {
    const a = listA[i];
    const b = listB[j];
    if (a.absStart < b.absEnd && b.absStart < a.absEnd) return true;
    if (a.absEnd <= b.absEnd) i += 1;
    else j += 1;
  }
  return false;
};

const plansOverlap = (a, b, { ignoreRange = false } = {}) => {
  if (!a.custom && !b.custom) {
    return (ignoreRange || rangesOverlap(a.startDay, a.endDay, b.startDay, b.endDay)) && windowsOverlap(a.window, b.window);
  }
  if (ignoreRange) {
    // the other plan is finished; compare the time of day of every day of this one with its window
    return dayWindowsOf(a).some((w) => windowsOverlap({ start: w.start, end: w.end }, b.window));
  }
  return anyWindowsOverlap(dayWindowsOf(a), dayWindowsOf(b));
};

module.exports = { plansOverlap, dayWindowsOf, windowsFromRange, anyWindowsOverlap };
