// Server mirror of src/lib/shift/breakEntitlements.ts — keep the two in sync.
// Classifies a shift's break intervals into lunch/tea entitlements so idle-log
// creation can enforce per-shift break limits (client limits are advisory).

const LUNCH_MIN_MINUTES = 25;
const LUNCH_MAX_MINUTES = 40;
const TEA_MIN_MINUTES = 8;
const TEA_MAX_MINUTES = 20;

/** Minutes between two "HH:MM" strings; handles a break that crosses midnight. */
function breakDurationMinutes(startTime, endTime) {
  const parse = (value) => {
    const match = String(value == null ? "" : value).trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  };
  const start = parse(startTime);
  const end = parse(endTime);
  if (start === null || end === null) return 0;
  let diff = end - start;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function computeBreakEntitlements(shift) {
  const intervals = Array.isArray(shift && shift.intervals) ? shift.intervals : [];
  const breakIntervals = intervals.filter((interval) => interval && interval.breakTime);

  if (breakIntervals.length === 0) {
    return { lunchAllowed: 0, teaAllowed: 0, hasConfig: false };
  }

  let lunchAllowed = 0;
  let teaAllowed = 0;
  for (const interval of breakIntervals) {
    const minutes = breakDurationMinutes(interval.startTime, interval.endTime);
    if (minutes >= LUNCH_MIN_MINUTES && minutes <= LUNCH_MAX_MINUTES) {
      lunchAllowed += 1;
    } else if (minutes >= TEA_MIN_MINUTES && minutes <= TEA_MAX_MINUTES) {
      teaAllowed += 1;
    }
  }

  return { lunchAllowed, teaAllowed, hasConfig: true };
}

module.exports = {
  LUNCH_MIN_MINUTES,
  LUNCH_MAX_MINUTES,
  TEA_MIN_MINUTES,
  TEA_MAX_MINUTES,
  breakDurationMinutes,
  computeBreakEntitlements,
};
