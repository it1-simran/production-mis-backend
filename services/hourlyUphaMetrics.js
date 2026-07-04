/**
 * Hourly UPHA (Units Per Hour Achieved) calculator — backend counterpart of
 * src/components/PlaningScheduling/viewPlaning/hourlyUphaMetrics.ts on the
 * frontend. Kept as a small, dependency-free module (no shared build step
 * exists between the two apps) but implements the identical formulas so the
 * operator task page and the planning page never disagree.
 *
 * Formulas:
 *   Target UPHA        = 3600 / Target Cycle Time (sec)
 *   Devices Produced    = count of pass events in the hour
 *   Average Cycle Time  = mean(consecutive pass timestamp deltas), first device excluded
 *   Theoretical UPHA    = 3600 / Average Cycle Time
 *   Actual UPHA         = Devices Produced / Hour Length (hours)
 *   Efficiency %        = (Actual UPHA / Target UPHA) * 100
 */

const round2 = (value) => Math.round(value * 100) / 100;

const toSortedValidEpochs = (timestamps) =>
  (Array.isArray(timestamps) ? timestamps : [])
    .map((value) => (value instanceof Date ? value.getTime() : new Date(value).getTime()))
    .filter((epochMs) => Number.isFinite(epochMs))
    .sort((a, b) => a - b);

/**
 * Computes the full hourly-UPHA KPI set from a raw list of pass timestamps
 * that already belong to a single hour bucket (filtering by hour/seat/stage
 * is the caller's job). See hourlyUphaMetrics.ts for the full rule set.
 */
const computeHourlyUpha = (passTimestamps, targetUpha, hourLengthHours = 1) => {
  const sortedEpochs = toSortedValidEpochs(passTimestamps);
  const devicesProduced = sortedEpochs.length;

  const cycleTimesSec = [];
  for (let i = 1; i < sortedEpochs.length; i += 1) {
    const deltaSec = (sortedEpochs[i] - sortedEpochs[i - 1]) / 1000;
    if (Number.isFinite(deltaSec) && deltaSec > 0) {
      cycleTimesSec.push(deltaSec);
    }
  }

  const averageCycleTimeSec =
    cycleTimesSec.length > 0
      ? round2(cycleTimesSec.reduce((sum, value) => sum + value, 0) / cycleTimesSec.length)
      : null;

  const theoreticalUpha =
    averageCycleTimeSec && averageCycleTimeSec > 0 ? round2(3600 / averageCycleTimeSec) : null;

  const safeHourLength = hourLengthHours > 0 ? hourLengthHours : 1;
  const actualUpha = round2(devicesProduced / safeHourLength);

  const targetUphaSafe = Number(targetUpha) || 0;
  const targetCycleTimeSec = targetUphaSafe > 0 ? round2(3600 / targetUphaSafe) : null;
  const efficiencyPct = targetUphaSafe > 0 ? round2((actualUpha / targetUphaSafe) * 100) : null;

  return {
    devicesProduced,
    averageCycleTimeSec,
    theoreticalUpha,
    actualUpha,
    targetUpha: targetUphaSafe,
    targetCycleTimeSec,
    efficiencyPct,
  };
};

const parseClockTimeOnDay = (dayStartMoment, timeStr) => {
  const match = String(timeStr || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return dayStartMoment.clone().hour(hours).minute(minutes).second(0).millisecond(0);
};

/**
 * Builds the shift's active (non-break) hour-long buckets anchored to
 * `dayStartMoment` (midnight, plant timezone). Buckets start from the
 * interval's OWN start time (e.g. 09:30-18:30 -> 09:30-10:30, 10:30-11:30, …)
 * matching the frontend Hourly Tracking table's bucketing, not wall-clock
 * 00-minute-aligned hours. An interval ending at/before its own start time is
 * treated as crossing midnight.
 */
const buildShiftHourBucketsForDay = (shift, dayStartMoment) => {
  const rawIntervals =
    Array.isArray(shift?.intervals) && shift.intervals.length > 0
      ? shift.intervals
      : [{ startTime: shift?.startTime, endTime: shift?.endTime, breakTime: false }];

  const buckets = [];
  rawIntervals.forEach((interval) => {
    if (interval?.breakTime) return;
    const start = parseClockTimeOnDay(dayStartMoment, interval?.startTime);
    let end = parseClockTimeOnDay(dayStartMoment, interval?.endTime);
    if (!start || !end) return;
    if (!end.isAfter(start)) end = end.clone().add(1, "day");

    let cursor = start.clone();
    while (cursor.isBefore(end)) {
      let next = cursor.clone().add(1, "hour");
      if (next.isAfter(end)) next = end.clone();
      buckets.push({ start: cursor.toDate(), end: next.toDate() });
      cursor = next;
    }
  });
  return buckets;
};

/**
 * Finds the shift-aligned hour bucket (plant timezone) containing
 * `referenceDate`, or null when it falls outside the shift's active window
 * entirely — before the shift starts, after it ends, or inside a configured
 * break. Checks both today's and yesterday's shift occurrence so a shift
 * crossing midnight (e.g. 22:00-06:00) resolves correctly in the small hours.
 */
const getCurrentShiftHourBoundsInTimezone = (moment, timezone, shift, referenceDate = new Date()) => {
  const hasSchedule =
    Boolean(shift?.startTime) || (Array.isArray(shift?.intervals) && shift.intervals.length > 0);
  if (!hasSchedule) return null;

  const referenceMoment = moment.tz(referenceDate, timezone);
  const todayStart = referenceMoment.clone().startOf("day");
  const yesterdayStart = todayStart.clone().subtract(1, "day");

  for (const dayStart of [todayStart, yesterdayStart]) {
    const buckets = buildShiftHourBucketsForDay(shift, dayStart);
    const match = buckets.find(
      (bucket) => referenceDate >= bucket.start && referenceDate < bucket.end,
    );
    if (match) return match;
  }
  return null;
};

const isPassTestRecordStatus = (status) => {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "pass" || normalized === "completed";
};

/** Pulls pass timestamps out of a raw record array, scoped to an hour window. */
const collectPassTimestampsInHour = (records, bounds, matchesRecord) => {
  const timestamps = [];
  (Array.isArray(records) ? records : []).forEach((record) => {
    if (!record?.createdAt) return;
    if (!isPassTestRecordStatus(record?.status)) return;
    const epochMs = new Date(record.createdAt).getTime();
    if (!Number.isFinite(epochMs)) return;
    if (epochMs < bounds.start.getTime() || epochMs >= bounds.end.getTime()) return;
    if (!matchesRecord(record)) return;
    timestamps.push(new Date(record.createdAt));
  });
  return timestamps;
};

module.exports = {
  computeHourlyUpha,
  getCurrentShiftHourBoundsInTimezone,
  isPassTestRecordStatus,
  collectPassTimestampsInHour,
};
