const formatDurationHHMMSS = (totalMs) => {
  const ms = Math.max(0, Number(totalMs) || 0);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
};

const normalizeText = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeText(value).toLowerCase().replace(/\s+/g, " ");

const getOperatorName = (record = {}) =>
  normalizeText(
    record?.operatorName ||
      record?.operatorId?.name ||
      record?.operatorId?.employeeCode ||
      "",
  );

const getRecordStart = (record = {}) => {
  const start = record?.startTime || record?.createdAt;
  const date = new Date(start);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getRecordEnd = (record = {}) => {
  const end = record?.endTime || record?.createdAt;
  const date = new Date(end);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseDurationLabelMs = (value) => {
  const text = normalizeText(value);
  if (!text) return 0;
  const match = text.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (
    ![hours, minutes, seconds].every((part) => Number.isFinite(part) && part >= 0) ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return 0;
  }
  return ((hours * 3600) + minutes * 60 + seconds) * 1000;
};

const getRecordDurationMs = (record = {}) => {
  const fromTimeConsumed = parseDurationLabelMs(record?.timeConsumed);
  const fromStoredMs = Number(record?.testDurationMs || 0);
  const start = getRecordStart(record);
  const end = getRecordEnd(record);
  const fromRange =
    start && end
      ? Math.max(0, end.getTime() - start.getTime())
      : 0;

  if (fromTimeConsumed > 0) {
    if (fromStoredMs > fromTimeConsumed * 2 || fromRange > fromTimeConsumed * 2) {
      return fromTimeConsumed;
    }
    return fromTimeConsumed;
  }
  if (fromStoredMs > 0) return fromStoredMs;
  return fromRange;
};

const attemptLabel = (attemptNumber) => {
  const n = Number(attemptNumber || 1);
  if (n === 1) return "1st Attempt";
  if (n === 2) return "2nd Attempt";
  if (n === 3) return "3rd Attempt";
  return `${n}th Attempt`;
};

const collectAutoNgRetryLogs = (record = {}) => {
  const sources = [];
  if (Array.isArray(record?.logData?.retryAttempts)) {
    sources.push(...record.logData.retryAttempts);
  }
  if (Array.isArray(record?.logs)) {
    record.logs.forEach((log) => {
      if (Array.isArray(log?.logData?.retryAttempts)) {
        sources.push(...log.logData.retryAttempts);
      }
    });
  }
  if (sources.length === 0) return [];

  const byNumber = new Map();
  sources.forEach((entry, index) => {
    const attemptNumber = Number(entry?.attemptNumber || index + 1);
    byNumber.set(attemptNumber, { ...entry, attemptNumber });
  });
  return Array.from(byNumber.values()).sort(
    (left, right) => Number(left.attemptNumber || 0) - Number(right.attemptNumber || 0),
  );
};

const getAutoNgAttemptCount = (record = {}) => collectAutoNgRetryLogs(record).length;

const parseAttemptTimestamp = (value) => {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date;
};

const buildAutoNgSessionAttemptRows = (
  record = {},
  { stageName = "", operatorName = "", recordId = "" } = {},
) => {
  const retryLogs = collectAutoNgRetryLogs(record);
  if (retryLogs.length === 0) return null;

  const { start: sessionStart, end: sessionEnd } = resolveRecordTimelineTimes(record);
  const sessionEndDate = sessionEnd || getRecordEnd(record);
  const autoNgMeta =
    record?.logData?.autoNgMeta ||
    record?.logs?.find((log) => log?.logData?.autoNgMeta)?.logData?.autoNgMeta;

  return retryLogs.map((log, index) => {
    const intraAttempt = Number(log.attemptNumber || index + 1);
    const sessionAttemptBase = Math.max(
      0,
      Number(record?.attemptNumber || 0) - 1,
    );
    const attemptNumber = sessionAttemptBase + intraAttempt;
    const isLast = index === retryLogs.length - 1;

    let attemptStart = parseAttemptTimestamp(log.startedAt);
    if (!attemptStart) {
      if (index === 0) {
        attemptStart = sessionStart;
      } else {
        attemptStart =
          parseAttemptTimestamp(retryLogs[index - 1]?.timestamp) || sessionStart;
      }
    }

    let attemptEnd = parseAttemptTimestamp(log.timestamp);
    if (isLast) {
      attemptEnd = sessionEndDate || attemptEnd;
    }
    if (!attemptEnd && attemptStart) {
      attemptEnd = attemptStart;
    }

    const durationMs =
      attemptStart && attemptEnd
        ? Math.max(0, attemptEnd.getTime() - attemptStart.getTime())
        : 0;
    const failureReason = normalizeText(
      log.failureReason || record?.reason || record?.logData?.reason || "",
    );
    const recordForStatus = {
      ...record,
      attemptNumber,
      __effectiveAttempt: attemptNumber,
    };

    return {
      attemptNumber,
      operatorName,
      startTime: attemptStart?.toISOString() || "",
      endTime: attemptEnd?.toISOString() || "",
      durationMs,
      durationLabel: formatDurationHHMMSS(durationMs),
      status: isLast
        ? statusLabel(recordForStatus)
        : statusLabel({ ...recordForStatus, status: "NG" }),
      rawStatus: isLast ? normalizeText(record?.status || "NG") : "NG",
      reason:
        failureReason ||
        (isLast ? buildDetails(record) : `Auto-retry (${log.phase || "failure"})`),
      stageName: record?.stageName || stageName || "",
      recordId,
    };
  });
};

const buildDetails = (record = {}) => {
  if (record?.assignedDeviceTo) {
    return `Assigned: ${record.assignedDeviceTo}`;
  }
  if (record?.reattemptReason) {
    return String(record.reattemptReason);
  }
  if (record?.reason) {
    return String(record.reason);
  }
  if (record?.ngDescription) {
    return String(record.ngDescription);
  }
  return "";
};

const getRecordAttemptKey = (record = {}, fallbackStage = "") => {
  const serial = normalizeText(record?.serialNo || record?.serial);
  const stage = normalizeKey(record?.stageName || fallbackStage);
  return `${serial}::${stage}`;
};

const getRecordLookupKey = (record = {}, index = 0) =>
  String(record?._id || record?.__index || `${getRecordAttemptKey(record)}-${index}`);

const buildAttemptMetaByRecord = (records = [], stageName = "") => {
  const grouped = new Map();

  (Array.isArray(records) ? records : []).forEach((record, index) => {
    const serial = normalizeText(record?.serialNo || record?.serial);
    if (!serial) return;
    const key = getRecordAttemptKey(record, stageName);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ...record, __index: record?.__index ?? index });
  });

  const metaByRecord = new Map();

  grouped.forEach((groupRecords) => {
    const sorted = [...groupRecords].sort((left, right) => {
      const leftStart = resolveRecordTimelineTimes(left).start?.getTime() || 0;
      const rightStart = resolveRecordTimelineTimes(right).start?.getTime() || 0;
      if (leftStart !== rightStart) return leftStart - rightStart;
      return String(left?._id || left?.__index || "").localeCompare(
        String(right?._id || right?.__index || ""),
      );
    });

    const maxStoredAttempt = sorted.reduce(
      (max, record) => Math.max(max, Number(record?.attemptNumber || 0)),
      0,
    );
    const maxAutoNgAttempts = sorted.reduce((max, record) => {
      const autoNgCount = getAutoNgAttemptCount(record);
      const sessionBase = Math.max(0, Number(record?.attemptNumber || 0) - 1);
      return Math.max(max, sessionBase + autoNgCount, autoNgCount);
    }, 0);
    const totalAttempts = Math.max(
      sorted.length,
      maxStoredAttempt > 0 ? maxStoredAttempt : sorted.length,
      maxAutoNgAttempts,
    );

    sorted.forEach((record, index) => {
      const derivedAttempt = index + 1;
      const storedAttempt = Number(record?.attemptNumber || 0);
      const autoNgAttempts = getAutoNgAttemptCount(record);
      const sessionBase = Math.max(0, storedAttempt - 1);
      const autoNgTotal =
        autoNgAttempts > 0 ? sessionBase + autoNgAttempts : autoNgAttempts;
      const effectiveAttempt =
        autoNgTotal > 0
          ? Math.max(
              autoNgTotal,
              storedAttempt > 0 ? storedAttempt : autoNgTotal,
            )
          : Math.max(
              derivedAttempt,
              storedAttempt > 0 ? storedAttempt : derivedAttempt,
            );
      metaByRecord.set(getRecordLookupKey(record, index), {
        effectiveAttempt,
        totalAttempts,
      });
    });
  });

  return metaByRecord;
};

const statusLabel = (record = {}) => {
  const status = normalizeKey(record?.status);
  const attempt = Number(
    record?.__effectiveAttempt || record?.attemptNumber || 1,
  );
  if (status === "pass" || status === "completed") {
    return attempt > 1 ? attemptLabel(attempt) : "Pass";
  }
  if (status === "ng" || status === "fail" || status === "failed") {
    return attempt > 1 ? attemptLabel(attempt) : "NG";
  }
  return record?.status || "-";
};

const IDLE_THRESHOLD_MS = 5000;

const formatDateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;

const parseClockOnDate = (dateKey, timeStr) => {
  const [hours = 0, minutes = 0] = String(timeStr || "00:00")
    .split(":")
    .map((part) => Number(part));
  const date = new Date(`${dateKey}T00:00:00`);
  date.setHours(
    Number.isFinite(hours) ? hours : 0,
    Number.isFinite(minutes) ? minutes : 0,
    0,
    0,
  );
  return date;
};

const listDateKeysInRange = (from = "", to = "") => {
  const fromTrim = normalizeText(from);
  const toTrim = normalizeText(to);
  if (!fromTrim && !toTrim) {
    return [formatDateKey(new Date())];
  }
  const start = new Date(`${fromTrim || toTrim}T00:00:00`);
  const end = new Date(`${toTrim || fromTrim}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }
  const keys = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    keys.push(formatDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
};

const buildWindowOnDate = (dateKey, startTime, endTime) => {
  const start = parseClockOnDate(dateKey, startTime);
  let end = parseClockOnDate(dateKey, endTime);
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  return { start, end };
};

const buildShiftSessions = (shiftTiming) => {
  if (!shiftTiming) return [];
  const dateKeys = listDateKeysInRange(
    shiftTiming.filterDateStart,
    shiftTiming.filterDateEnd,
  );
  const intervals = Array.isArray(shiftTiming.intervals) ? shiftTiming.intervals : [];
  const productiveIntervals = intervals.filter((interval) => !interval?.breakTime);
  const breakIntervals = intervals.filter((interval) => interval?.breakTime);
  const fallbackProductive =
    productiveIntervals.length > 0
      ? productiveIntervals
      : shiftTiming.startTime && shiftTiming.endTime
        ? [{ startTime: shiftTiming.startTime, endTime: shiftTiming.endTime, breakTime: false }]
        : [];

  if (fallbackProductive.length === 0) return [];

  const sessions = [];
  dateKeys.forEach((dateKey) => {
    fallbackProductive.forEach((interval, index) => {
      sessions.push({
        key: `${dateKey}::${index}`,
        dateKey,
        productiveWindows: [buildWindowOnDate(dateKey, interval.startTime, interval.endTime)],
        breakWindows: breakIntervals.map((breakInterval) =>
          buildWindowOnDate(dateKey, breakInterval.startTime, breakInterval.endTime),
        ),
      });
    });
  });
  return sessions;
};

const timestampWithinWindow = (timestamp, window) =>
  timestamp >= window.start && timestamp <= window.end;

const findSessionForTimestamp = (timestamp, sessions) => {
  if (!timestamp || Number.isNaN(timestamp.getTime())) return null;
  return (
    sessions.find((session) =>
      session.productiveWindows.some((window) => timestampWithinWindow(timestamp, window)),
    ) || null
  );
};

const subtractBreakOverlapMs = (from, to, breakWindows) => {
  let idleMs = Math.max(0, to.getTime() - from.getTime());
  breakWindows.forEach((breakWindow) => {
    const overlapStart = Math.max(from.getTime(), breakWindow.start.getTime());
    const overlapEnd = Math.min(to.getTime(), breakWindow.end.getTime());
    if (overlapEnd > overlapStart) {
      idleMs -= overlapEnd - overlapStart;
    }
  });
  return Math.max(0, idleMs);
};

const getPerTestDurationMs = (record) =>
  Number(record.__durationMs || getRecordDurationMs(record) || 0);

const resolveRecordTimelineTimes = (record) => {
  const durationMs = getPerTestDurationMs(record);
  const end = getRecordEnd(record);
  let start = getRecordStart(record);

  const rangeMs =
    start && end ? Math.max(0, end.getTime() - start.getTime()) : 0;
  const isInconsistent =
    durationMs > 0 &&
    end &&
    (!start || rangeMs > durationMs * 2 || rangeMs < durationMs * 0.5);

  if (isInconsistent && end) {
    start = new Date(end.getTime() - durationMs);
  }

  return { start, end, durationMs };
};

const clipRangeToProductiveShiftMs = (start, end, sessions, asOf) => {
  const cap = asOf ? asOf.getTime() : Number.POSITIVE_INFINITY;
  let ms = 0;
  sessions.forEach((session) => {
    session.productiveWindows.forEach((window) => {
      const overlapStart = Math.max(start.getTime(), window.start.getTime());
      const overlapEnd = Math.min(end.getTime(), window.end.getTime(), cap);
      if (overlapEnd > overlapStart) {
        ms += overlapEnd - overlapStart;
      }
    });
  });
  return ms;
};

const computeElapsedProductiveShiftMs = (sessions, asOf = new Date()) => {
  const asOfMs = asOf.getTime();
  const todayKey = formatDateKey(asOf);
  return sessions.reduce(
    (sum, session) =>
      sum +
      session.productiveWindows.reduce((windowSum, window) => {
        if (window.start.getTime() > asOfMs) return windowSum;
        if (session.dateKey > todayKey) return windowSum;
        const effectiveEnd =
          session.dateKey < todayKey
            ? window.end.getTime()
            : Math.min(window.end.getTime(), asOfMs);
        const effectiveStart = window.start.getTime();
        if (effectiveEnd <= effectiveStart) return windowSum;
        return windowSum + (effectiveEnd - effectiveStart);
      }, 0),
    0,
  );
};

const getShiftScopedDurationMs = (record, sessions, asOf) => {
  const { start, end, durationMs } = resolveRecordTimelineTimes(record);
  const timerMs = Number(record.__durationMs || durationMs || 0);
  if (!start || !end) {
    const session =
      findSessionForTimestamp(getRecordEnd(record), sessions) ||
      findSessionForTimestamp(getRecordStart(record), sessions);
    if (!session) return 0;
    return timerMs;
  }

  const inShift = sessions.some((session) =>
    session.productiveWindows.some(
      (window) =>
        timestampWithinWindow(start, window) ||
        timestampWithinWindow(end, window) ||
        (start <= window.start && end >= window.end),
    ),
  );
  if (!inShift) return 0;

  const clippedMs = clipRangeToProductiveShiftMs(start, end, sessions, asOf);
  if (clippedMs <= 0) return 0;
  if (timerMs > 0 && clippedMs > timerMs * 1.5) {
    return timerMs;
  }
  return timerMs > 0 ? Math.min(clippedMs, timerMs) : clippedMs;
};

const computeShiftIdleMs = (previousEnd, nextStart, session) =>
  session.productiveWindows.reduce((sum, window) => {
    const gapStart = new Date(Math.max(previousEnd.getTime(), window.start.getTime()));
    const gapEnd = new Date(Math.min(nextStart.getTime(), window.end.getTime()));
    if (gapEnd <= gapStart) return sum;
    return sum + subtractBreakOverlapMs(gapStart, gapEnd, session.breakWindows);
  }, 0);

const buildTestingAnalytics = ({
  records = [],
  attemptContextRecords,
  stageName = "",
  seatKey = "",
  targetUph = 0,
  productiveHours = 1,
  shiftTiming,
} = {}) => {
  const normalizedStage = normalizeKey(stageName);
  const normalizedSeat = normalizeKey(seatKey);

  const filtered = (Array.isArray(records) ? records : [])
    .filter((record) => {
      const recordStage = normalizeKey(record?.stageName || record?.currentStage || "");
      const recordSeat = normalizeKey(record?.seatNumber || record?.currentSeatKey || "");
      if (normalizedStage && recordStage && recordStage !== normalizedStage) return false;
      if (normalizedSeat && recordSeat && recordSeat !== normalizedSeat) return false;
      return true;
    })
    .map((record, index) => {
      const resolved = resolveRecordTimelineTimes(record);
      return {
        ...record,
        __sortStart:
          resolved.start?.getTime() || resolved.end?.getTime() || 0,
        __durationMs: getRecordDurationMs(record),
        __operatorName: getOperatorName(record),
        __attemptNumber: Number(record?.attemptNumber || 1),
        __index: index,
      };
    });

  const chronological = [...filtered].sort((left, right) => left.__sortStart - right.__sortStart);
  const attemptMetaByRecord = buildAttemptMetaByRecord(
    attemptContextRecords && attemptContextRecords.length > 0
      ? attemptContextRecords
      : filtered,
    stageName,
  );
  const shiftSessions = buildShiftSessions(shiftTiming);
  const useShiftTiming = shiftSessions.length > 0;
  const shiftAsOf = new Date();
  const elapsedShiftMs = useShiftTiming
    ? computeElapsedProductiveShiftMs(shiftSessions, shiftAsOf)
    : 0;
  const timeline = [];

  chronological.forEach((record, index) => {
    const { start, end, durationMs } = resolveRecordTimelineTimes(record);
    const operatorName = record.__operatorName || "N/A";
    const serial = normalizeText(record?.serialNo || record?.serial || "");

    if (index > 0) {
      const previous = chronological[index - 1];
      const previousResolved = resolveRecordTimelineTimes(previous);
      const previousEnd = previousResolved.end;
      const previousOperator = previous.__operatorName;
      if (
        previousEnd &&
        start &&
        previousOperator &&
        previousOperator === operatorName
      ) {
        let idleMs = start.getTime() - previousEnd.getTime();
        if (useShiftTiming) {
          const previousSession = findSessionForTimestamp(previousEnd, shiftSessions);
          const nextSession = findSessionForTimestamp(start, shiftSessions);
          idleMs =
            previousSession &&
            nextSession &&
            previousSession.key === nextSession.key
              ? computeShiftIdleMs(previousEnd, start, previousSession)
              : 0;
        }
        if (idleMs >= IDLE_THRESHOLD_MS) {
          timeline.push({
            rowType: "idle",
            startTime: previousEnd.toISOString(),
            endTime: start.toISOString(),
            durationMs: idleMs,
            durationLabel: formatDurationHHMMSS(idleMs),
            stageName: stageName || record?.stageName || "",
            serialNo: "",
            status: "idle",
            operatorName,
            attemptNumber: 0,
            totalAttemptsForDevice: 0,
            details: "Idle between devices",
          });
        }
      }
    }

    const attemptMeta = attemptMetaByRecord.get(getRecordLookupKey(record, index)) || {
      effectiveAttempt: record.__attemptNumber,
      totalAttempts: record.__attemptNumber,
    };
    const recordForStatus = {
      ...record,
      __effectiveAttempt: attemptMeta.effectiveAttempt,
      attemptNumber: attemptMeta.effectiveAttempt,
    };

    timeline.push({
      rowType: "test",
      startTime: start ? start.toISOString() : "",
      endTime: end ? end.toISOString() : "",
      durationMs,
      durationLabel: formatDurationHHMMSS(durationMs),
      stageName: record?.stageName || stageName || "",
      serialNo: serial,
      status: statusLabel(recordForStatus),
      rawStatus: record?.status || "",
      operatorName,
      attemptNumber: attemptMeta.effectiveAttempt,
      totalAttemptsForDevice: attemptMeta.totalAttempts,
      isRetryAttempt: Number(attemptMeta.effectiveAttempt || 1) > 1,
      details: buildDetails(record),
      recordId: String(record?._id || record?.__index || ""),
    });
  });

  timeline.reverse();

  const passCount = filtered.filter((record) =>
    ["pass", "completed"].includes(normalizeKey(record?.status)),
  ).length;
  const ngCount = filtered.filter((record) =>
    ["ng", "fail", "failed"].includes(normalizeKey(record?.status)),
  ).length;
  const resolveActiveMs = (record) =>
    useShiftTiming
      ? getShiftScopedDurationMs(record, shiftSessions, shiftAsOf)
      : getPerTestDurationMs(record);
  const timingRecords = useShiftTiming
    ? filtered.filter((record) => {
        const { start, end } = resolveRecordTimelineTimes(record);
        return Boolean(
          findSessionForTimestamp(end, shiftSessions) ||
            findSessionForTimestamp(start, shiftSessions),
        );
      })
    : filtered;
  let totalActiveMs = timingRecords.reduce(
    (sum, record) => sum + resolveActiveMs(record),
    0,
  );
  let idleMs = timeline
    .filter((row) => row.rowType === "idle")
    .reduce((sum, row) => sum + Number(row.durationMs || 0), 0);
  if (useShiftTiming && elapsedShiftMs > 0) {
    const accountedMs = totalActiveMs + idleMs;
    if (accountedMs > elapsedShiftMs) {
      totalActiveMs = Math.max(0, elapsedShiftMs - idleMs);
    }
  }
  const avgDurationMs =
    timingRecords.length > 0
      ? Math.round(
          timingRecords.reduce((sum, record) => sum + getPerTestDurationMs(record), 0) /
            timingRecords.length,
        )
      : 0;
  const achievedUph =
    productiveHours > 0 ? Number((passCount / productiveHours).toFixed(2)) : 0;

  const operatorMap = new Map();
  filtered.forEach((record) => {
    const name = record.__operatorName || "Unknown";
    const current = operatorMap.get(name) || {
      operatorName: name,
      devicesProcessed: 0,
      passCount: 0,
      ngCount: 0,
      activeMs: 0,
      idleMs: 0,
      timedDevices: 0,
      durationSumMs: 0,
      initialTestMs: 0,
      retryMs: 0,
      retryAttempts: 0,
    };
    current.devicesProcessed += 1;
    const inShift =
      !useShiftTiming ||
      Boolean(
        (() => {
          const { start, end } = resolveRecordTimelineTimes(record);
          return (
            findSessionForTimestamp(end, shiftSessions) ||
            findSessionForTimestamp(start, shiftSessions)
          );
        })(),
      );
    if (inShift) {
      const perTestMs = useShiftTiming
        ? getShiftScopedDurationMs(record, shiftSessions, shiftAsOf)
        : getPerTestDurationMs(record);
      const autoNgRows = buildAutoNgSessionAttemptRows(record, {
        stageName,
        operatorName: name,
        recordId: String(record?._id || record?.__index || ""),
      });
      current.activeMs += perTestMs;
      current.durationSumMs += perTestMs;
      current.timedDevices += 1;
      if (autoNgRows && autoNgRows.length > 1) {
        current.initialTestMs += Number(autoNgRows[0]?.durationMs || 0);
        const retryMs = autoNgRows
          .slice(1)
          .reduce((sum, row) => sum + Number(row.durationMs || 0), 0);
        current.retryMs += retryMs;
        current.retryAttempts += autoNgRows.length - 1;
      } else {
        const attemptMeta = attemptMetaByRecord.get(
          getRecordLookupKey(record, record.__index),
        ) || {
          effectiveAttempt: record.__attemptNumber,
          totalAttempts: record.__attemptNumber,
        };
        if (Number(attemptMeta.effectiveAttempt || 1) > 1) {
          current.retryMs += perTestMs;
          current.retryAttempts += 1;
        } else {
          current.initialTestMs += perTestMs;
        }
      }
    }
    const status = normalizeKey(record?.status);
    if (status === "pass" || status === "completed") current.passCount += 1;
    if (["ng", "fail", "failed"].includes(status)) current.ngCount += 1;
    operatorMap.set(name, current);
  });

  timeline
    .filter((row) => row.rowType === "idle")
    .forEach((row) => {
      const current = operatorMap.get(row.operatorName);
      if (current) current.idleMs += Number(row.durationMs || 0);
    });

  if (useShiftTiming && elapsedShiftMs > 0) {
    operatorMap.forEach((operator) => {
      const accountedMs = operator.activeMs + operator.idleMs;
      if (accountedMs > elapsedShiftMs) {
        operator.activeMs = Math.max(0, elapsedShiftMs - operator.idleMs);
      }
    });
  }

  const deviceMap = new Map();
  filtered.forEach((record) => {
    const serial = normalizeText(record?.serialNo || record?.serial);
    if (!serial) return;
    if (!deviceMap.has(serial)) {
      deviceMap.set(serial, {
        serialNo: serial,
        attempts: [],
        totalAttempts: 0,
        finalStatus: "",
      });
    }
    const bucket = deviceMap.get(serial);
    const attemptMeta = attemptMetaByRecord.get(getRecordLookupKey(record, record.__index)) || {
      effectiveAttempt: record.__attemptNumber,
      totalAttempts: record.__attemptNumber,
    };
    const recordId = String(record?._id || record?.__index || "");
    const resolvedTimes = resolveRecordTimelineTimes(record);
    const autoNgRows = buildAutoNgSessionAttemptRows(record, {
      stageName,
      operatorName: record.__operatorName,
      recordId,
    });

    if (autoNgRows && autoNgRows.length > 0) {
      bucket.attempts.push(...autoNgRows);
    } else {
      const recordForStatus = {
        ...record,
        __effectiveAttempt: attemptMeta.effectiveAttempt,
        attemptNumber: attemptMeta.effectiveAttempt,
      };
      bucket.attempts.push({
        attemptNumber: attemptMeta.effectiveAttempt,
        operatorName: record.__operatorName,
        startTime: resolvedTimes.start?.toISOString() || "",
        endTime: resolvedTimes.end?.toISOString() || "",
        durationMs: resolvedTimes.durationMs,
        durationLabel: formatDurationHHMMSS(resolvedTimes.durationMs),
        status: statusLabel(recordForStatus),
        rawStatus: record?.status || "",
        reason: buildDetails(record),
        stageName: record?.stageName || stageName || "",
        recordId,
      });
    }
    bucket.totalAttempts = Math.max(bucket.totalAttempts, attemptMeta.totalAttempts);
    const resolvedEndMs = resolvedTimes.end?.getTime() || 0;
    const previousEndMs = bucket.__latestEndMs || 0;
    if (resolvedEndMs >= previousEndMs) {
      bucket.finalStatus = record?.status || bucket.finalStatus;
      bucket.__latestEndMs = resolvedEndMs;
    }
  });

  const deviceAttempts = Array.from(deviceMap.values())
    .map((bucket) => {
      const attempts = [...bucket.attempts].sort(
        (left, right) => left.attemptNumber - right.attemptNumber,
      );
      const totalConsumedMs = attempts.reduce(
        (sum, attempt) => sum + Number(attempt.durationMs || 0),
        0,
      );
      const retryAttempts = attempts.filter((attempt) => Number(attempt.attemptNumber || 1) > 1);
      const initialAttempt =
        attempts.find((attempt) => Number(attempt.attemptNumber || 1) === 1) || attempts[0];
      const retryConsumedMs = retryAttempts.reduce(
        (sum, attempt) => sum + Number(attempt.durationMs || 0),
        0,
      );
      const initialConsumedMs = Number(initialAttempt?.durationMs || 0);
      const totalAttempts = Math.max(
        bucket.totalAttempts,
        attempts.length,
        attempts[attempts.length - 1]?.attemptNumber || 0,
      );
      return {
        serialNo: bucket.serialNo,
        totalAttempts,
        retryCount: Math.max(0, totalAttempts - 1),
        finalStatus: bucket.finalStatus,
        firstAttemptTime: attempts[0]?.startTime || "",
        latestAttemptTime: attempts[attempts.length - 1]?.endTime || "",
        totalConsumedMs,
        totalConsumedLabel: formatDurationHHMMSS(totalConsumedMs),
        initialConsumedMs,
        initialConsumedLabel: formatDurationHHMMSS(initialConsumedMs),
        retryConsumedMs,
        retryConsumedLabel: formatDurationHHMMSS(retryConsumedMs),
        attempts,
      };
    })
    .sort((left, right) => right.totalAttempts - left.totalAttempts);

  const retryDeviceCount = deviceAttempts.filter((device) => device.totalAttempts > 1).length;
  const retryAttemptCount = deviceAttempts.reduce((sum, device) => sum + device.retryCount, 0);
  const totalRetryConsumedMs = deviceAttempts.reduce(
    (sum, device) => sum + device.retryConsumedMs,
    0,
  );
  const averageRetryDurationMs =
    retryAttemptCount > 0 ? Math.round(totalRetryConsumedMs / retryAttemptCount) : 0;
  const retryPercentage =
    deviceAttempts.length > 0
      ? Number(((retryDeviceCount / deviceAttempts.length) * 100).toFixed(1))
      : 0;

  const retryAttemptLog = deviceAttempts
    .flatMap((device) =>
      device.attempts
        .filter((attempt) => Number(attempt.attemptNumber || 1) > 1)
        .map((attempt) => ({
          serialNo: device.serialNo,
          stageName: attempt.stageName || stageName || "",
          attemptNumber: attempt.attemptNumber,
          totalAttemptsForDevice: device.totalAttempts,
          startTime: attempt.startTime,
          endTime: attempt.endTime,
          durationMs: attempt.durationMs,
          durationLabel: attempt.durationLabel,
          status: attempt.status,
          operatorName: attempt.operatorName,
          details: attempt.reason || "",
          recordId: attempt.recordId,
        })),
    )
    .sort(
      (left, right) =>
        new Date(right.startTime).getTime() - new Date(left.startTime).getTime(),
    );

  return {
    stageName,
    seatKey,
    summary: {
      totalRecords: filtered.length,
      passCount,
      ngCount,
      totalActiveMs,
      totalActiveLabel: formatDurationHHMMSS(totalActiveMs),
      totalIdleMs: idleMs,
      totalIdleLabel: formatDurationHHMMSS(idleMs),
      averageDurationMs: avgDurationMs,
      averageDurationLabel: formatDurationHHMMSS(avgDurationMs),
      totalRetryConsumedMs,
      totalRetryConsumedLabel: formatDurationHHMMSS(totalRetryConsumedMs),
      retryDeviceCount,
      retryAttemptCount,
      averageRetryDurationMs,
      averageRetryDurationLabel: formatDurationHHMMSS(averageRetryDurationMs),
      retryPercentage,
      targetUph: Number(targetUph || 0),
      achievedUph,
      uphContribution: achievedUph,
    },
    operators: Array.from(operatorMap.values()).map((row) => ({
      ...row,
      activeLabel: formatDurationHHMMSS(row.activeMs),
      idleLabel: formatDurationHHMMSS(row.idleMs),
      averageDurationMs:
        row.timedDevices > 0 ? Math.round(row.durationSumMs / row.timedDevices) : 0,
      averageDurationLabel: formatDurationHHMMSS(
        row.timedDevices > 0 ? Math.round(row.durationSumMs / row.timedDevices) : 0,
      ),
      initialTestMs: row.initialTestMs,
      initialTestLabel: formatDurationHHMMSS(row.initialTestMs),
      retryMs: row.retryMs,
      retryLabel: formatDurationHHMMSS(row.retryMs),
    })),
    deviceAttempts,
    retryAttemptLog,
    timeline,
  };
};

module.exports = {
  buildTestingAnalytics,
  formatDurationHHMMSS,
  resolveRecordTimelineTimes,
};
