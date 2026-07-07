const mongoose = require("mongoose");
const moment = require("moment-timezone");
const deviceModel = require("../models/device");
const deviceTestRecordModel = require("../models/deviceTestModel");
const assignOperatorToPlanModel = require("../models/assignOperatorToPlan");
const OperatorWorkSession = require("../models/operatorWorkSession");
const OperatorWorkEvent = require("../models/operatorWorkEvent");

const normalizeValue = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeValue(value).toLowerCase().replace(/\s+/g, " ");

// Date-range boundaries must be interpreted in the plant's timezone, not the
// server's. On a UTC server, server-local parsing shifts "today" by 5.5 hours
// for IST operators, so records from the first hours of the shift fall outside
// the requested day.
const PLANNING_TIMEZONE = process.env.PLANNING_TIMEZONE || "Asia/Kolkata";

/** YYYY-MM-DD key of a timestamp in the plant timezone. */
const toPlanningDateKey = (value) => moment(value).tz(PLANNING_TIMEZONE).format("YYYY-MM-DD");

/** Start/end Date objects of a YYYY-MM-DD day (or day range) in the plant timezone. */
const getPlanningDayRange = (dateFrom = "", dateTo = "") => {
  const from = normalizeValue(dateFrom);
  const to = normalizeValue(dateTo);
  const start = from ? moment.tz(from, "YYYY-MM-DD", PLANNING_TIMEZONE).startOf("day").toDate() : null;
  const end = to ? moment.tz(to, "YYYY-MM-DD", PLANNING_TIMEZONE).endOf("day").toDate() : null;
  return { start, end };
};
const normalizeStageKeyFlexible = (value) =>
  normalizeValue(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildStageAliasLookup = ({ processStages = [], commonStages = [] } = {}) => {
  const lookup = new Map();
  const register = (canonical) => {
    const name = normalizeValue(canonical);
    if (!name) return;
    lookup.set(normalizeStageKeyFlexible(name), name);
    lookup.set(name.toLowerCase().replace(/[^a-z0-9]/g, ""), name);
  };

  [...(Array.isArray(processStages) ? processStages : []), ...(Array.isArray(commonStages) ? commonStages : [])]
    .forEach((stage) => {
      register(stage?.stageName || stage?.name || stage?.stage);
    });

  [
    "FG_TO_STORE",
    "FG to Store",
    "KEEP_IN_STORE",
    "KEPT_IN_STORE",
    "STOCKED",
    "PDI",
    "Dispatch",
    "Delivery",
  ].forEach(register);

  return lookup;
};

const resolveCanonicalStageName = (stageName, lookup = new Map()) => {
  const raw = normalizeValue(stageName);
  if (!raw) return "";
  const flex = normalizeStageKeyFlexible(raw);
  return (
    lookup.get(flex) ||
    lookup.get(raw.toLowerCase().replace(/[^a-z0-9]/g, "")) ||
    raw
  );
};

const mergeAliasedStageRows = (byStageMap = new Map(), lookup = new Map()) => {
  const merged = new Map();
  Array.from(byStageMap.values()).forEach((row) => {
    const canonical = resolveCanonicalStageName(row?.stageName, lookup);
    const key = normalizeKey(canonical);
    if (!key) return;
    if (!merged.has(key)) {
      merged.set(key, { ...row, stageName: canonical });
      return;
    }
    const existing = merged.get(key);
    existing.tested += Number(row?.tested || 0);
    existing.pass += Number(row?.pass || 0);
    existing.ng += Number(row?.ng || 0);
    existing.wip += Number(row?.wip || 0);
  });
  byStageMap.clear();
  merged.forEach((row, key) => byStageMap.set(key, row));
};

const POST_COMMON_STAGE_KEYS = new Set([
  "keep in store",
  "kept in store",
  "stocked",
  "dispatch",
  "dispatched",
  "delivery",
  "delivered",
]);

const resolveCommonStageIndex = (deviceStage = "", commonStageNames = []) => {
  const deviceFlex = normalizeStageKeyFlexible(deviceStage);
  if (!deviceFlex) return -1;

  for (let index = 0; index < commonStageNames.length; index += 1) {
    if (normalizeStageKeyFlexible(commonStageNames[index]) === deviceFlex) return index;
  }

  if (
    POST_COMMON_STAGE_KEYS.has(deviceFlex) ||
    deviceFlex.startsWith("dispatch") ||
    deviceFlex.startsWith("deliver")
  ) {
    return commonStageNames.length;
  }

  return -1;
};

const reconcileCommonStageMetrics = ({
  commonStages = [],
  devices = [],
  byStageMap = new Map(),
  upsertStage,
}) => {
  const stageNames = (Array.isArray(commonStages) ? commonStages : [])
    .map((stage) => normalizeValue(stage?.stageName || stage?.name || stage?.stage))
    .filter(Boolean);
  if (!stageNames.length || typeof upsertStage !== "function") return;

  const wipCounts = new Map(stageNames.map((name) => [normalizeKey(name), 0]));
  const passCounts = new Map(stageNames.map((name) => [normalizeKey(name), 0]));

  (Array.isArray(devices) ? devices : []).forEach((device) => {
    if (isDeviceTerminalNg(device)) return;
    const currentStage = normalizeValue(device?.currentStage || "");
    if (!currentStage) return;

    const stageIndex = resolveCommonStageIndex(currentStage, stageNames);
    if (stageIndex < 0) return;

    if (stageIndex < stageNames.length) {
      const wipKey = normalizeKey(stageNames[stageIndex]);
      wipCounts.set(wipKey, (wipCounts.get(wipKey) || 0) + 1);
      for (let index = 0; index < stageIndex; index += 1) {
        const passKey = normalizeKey(stageNames[index]);
        passCounts.set(passKey, (passCounts.get(passKey) || 0) + 1);
      }
      return;
    }

    stageNames.forEach((name) => {
      const passKey = normalizeKey(name);
      passCounts.set(passKey, (passCounts.get(passKey) || 0) + 1);
    });
  });

  stageNames.forEach((name) => {
    const row = upsertStage(name);
    if (!row) return;
    const key = normalizeKey(name);
    const pipelineWip = wipCounts.get(key) || 0;
    const pipelinePass = passCounts.get(key) || 0;
    row.wip = Math.max(Number(row?.wip || 0), pipelineWip);
    row.pass = Math.max(Number(row?.pass || 0), pipelinePass);
  });
};

const safeJsonParse = (raw, fallback = {}) => {
  if (!raw) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const sortSeatKeys = (seatKeys = []) =>
  [...seatKeys].sort((left, right) => {
    const [leftRow, leftSeat] = String(left || "").split("-").map((part) => Number(part));
    const [rightRow, rightSeat] = String(right || "").split("-").map((part) => Number(part));
    if ((leftRow || 0) !== (rightRow || 0)) return (leftRow || 0) - (rightRow || 0);
    return (leftSeat || 0) - (rightSeat || 0);
  });

const normalizeAssignedStagesPayload = (assignedStages = {}, processStages = [], commonStages = []) => {
  const stageOrderMap = new Map();
  [...(Array.isArray(processStages) ? processStages : []), ...(Array.isArray(commonStages) ? commonStages : [])]
    .forEach((stage, index) => {
      const stageName = normalizeKey(stage?.stageName || stage?.name || stage?.stage);
      if (stageName && !stageOrderMap.has(stageName)) {
        stageOrderMap.set(stageName, index);
      }
    });

  return sortSeatKeys(Object.keys(assignedStages || {})).reduce((acc, seatKey) => {
    const seatItems = Array.isArray(assignedStages?.[seatKey])
      ? assignedStages[seatKey]
      : assignedStages?.[seatKey]
        ? [assignedStages[seatKey]]
        : [];

    if (!seatItems.length) return acc;

    const [lineIndex] = String(seatKey || "").split("-").map((part) => Number(part));
    acc[seatKey] = seatItems.map((item, itemIndex) => {
      if (item?.reserved) {
        return { ...item, seatKey, lineIndex };
      }

      const stageName = normalizeValue(item?.stageName || item?.name || item?.stage);
      const normalizedStageName = normalizeKey(stageName);
      const sequenceIndex = stageOrderMap.has(normalizedStageName)
        ? Number(stageOrderMap.get(normalizedStageName))
        : itemIndex;
      const parallelGroupKey =
        item?.parallelGroupKey ||
        `line-${lineIndex}-seq-${sequenceIndex}-stage-${normalizedStageName.replace(/[^a-z0-9]+/g, "-")}`;
      const stageInstanceId =
        item?.stageInstanceId ||
        `${parallelGroupKey}-seat-${String(seatKey).replace(/[^0-9-]+/g, "")}`;

      return {
        ...item,
        name: stageName || item?.name || item?.stage || "",
        stageName: stageName || item?.stageName || item?.name || "",
        seatKey,
        lineIndex,
        sequenceIndex,
        parallelGroupKey,
        stageInstanceId,
      };
    });

    return acc;
  }, {});
};

const getSeatStageEntry = (assignedStages = {}, seatKey = "") => {
  const seatStages = Array.isArray(assignedStages?.[seatKey])
    ? assignedStages[seatKey]
    : assignedStages?.[seatKey]
      ? [assignedStages[seatKey]]
      : [];
  return seatStages.find((stage) => !stage?.reserved) || seatStages[0] || null;
};

const getShiftProductiveHours = (shift) => {
  if (!shift) return 0;
  if (!Array.isArray(shift?.intervals) || shift.intervals.length === 0) {
    if (!shift?.startTime || !shift?.endTime) return 0;
    const start = moment(shift.startTime, ["HH:mm", "HH:mm:ss", "h:mm A"], true);
    const end = moment(shift.endTime, ["HH:mm", "HH:mm:ss", "h:mm A"], true);
    if (!start.isValid() || !end.isValid()) return 0;
    let minutes = end.diff(start, "minutes");
    if (minutes <= 0) minutes += 24 * 60;
    const breakMinutes = Number(shift?.totalBreakTime || 0);
    return Math.max(0, (minutes - breakMinutes) / 60);
  }

  const minutes = shift.intervals.reduce((sum, interval) => {
    if (!interval?.startTime || !interval?.endTime || interval?.breakTime) return sum;
    const start = moment(interval.startTime, ["HH:mm", "HH:mm:ss", "h:mm A"], true);
    const end = moment(interval.endTime, ["HH:mm", "HH:mm:ss", "h:mm A"], true);
    if (!start.isValid() || !end.isValid()) return sum;
    let span = end.diff(start, "minutes");
    if (span <= 0) span += 24 * 60;
    return sum + span;
  }, 0);

  return Math.max(0, minutes / 60);
};

const getTargetUpha = ({ processStages = [], commonStages = [] }) => {
  const values = [...(Array.isArray(processStages) ? processStages : []), ...(Array.isArray(commonStages) ? commonStages : [])]
    .map((stage) => Number(stage?.upha))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return 0;
  return Math.min(...values);
};

const getDefaultStageRow = (stageName) => ({
  stageName,
  tested: 0,
  pass: 0,
  ng: 0,
  wip: 0,
});

const getDefaultSeatStageRow = (seatKey, stageName) => ({
  seatKey,
  stageName,
  tested: 0,
  pass: 0,
  ng: 0,
  wip: 0,
});

const COUNTABLE_STATUS_SET = new Set(["pass", "completed", "ng", "fail", "qc", "trc", "rework"]);
const PASS_STATUS_SET = new Set(["pass", "completed"]);
const NG_STATUS_SET = new Set(["ng", "fail", "qc", "trc", "rework"]);

const isRevertedEquivalentStatus = (status) => {
  const normalized = normalizeKey(status);
  return normalized === "reverted" || normalized === "removed";
};

const isCountableStatus = (status) => COUNTABLE_STATUS_SET.has(normalizeKey(status));

const isPassStatus = (status) => {
  return PASS_STATUS_SET.has(normalizeKey(status));
};

const isNgStatus = (status) => {
  return NG_STATUS_SET.has(normalizeKey(status));
};

const isResolvedStatus = (status) => normalizeKey(status).includes("resolved");

const DEPARTMENT_STAGE_KEYS = new Set(["qc", "trc"]);

const isDepartmentStage = (stageName) =>
  DEPARTMENT_STAGE_KEYS.has(normalizeKey(stageName));

const isActiveWipDeviceStatus = (status) => {
  const normalized = normalizeKey(status);
  return !normalized || normalized === "active";
};

const isDeviceTerminalNg = (device = {}) => {
  const status = normalizeKey(device?.status);
  const stage = normalizeKey(device?.currentStage);
  if (!status) return false;
  if (status === "rework") {
    return isDepartmentStage(stage);
  }
  return (
    status === "ng" ||
    status === "fail" ||
    status === "qc" ||
    status === "trc" ||
    status === "rejected"
  );
};

const getResolvedReturnStage = (record = {}) =>
  normalizeValue(record?.assignedDeviceTo || record?.currentStage || record?.stageName || "");

const buildDeviceFlowVersionMap = (devices = []) => {
  const map = new Map();
  (Array.isArray(devices) ? devices : []).forEach((device) => {
    const flowVersion = Number(device?.flowVersion || 1);
    const deviceId = String(device?._id || "").trim();
    const serialNo = normalizeValue(device?.serialNo);
    if (deviceId) map.set(deviceId, flowVersion);
    if (serialNo) map.set(serialNo, flowVersion);
  });
  return map;
};

const getRecordDeviceKey = (record = {}) =>
  String(record?.deviceId?._id || record?.deviceId || record?.serialNo || "").trim();

const shouldSkipRecordForFlowVersion = (record, deviceFlowVersions = new Map()) => {
  const deviceKey = getRecordDeviceKey(record);
  if (!deviceKey) return false;
  const currentFlowVersion = deviceFlowVersions.get(deviceKey);
  if (currentFlowVersion === undefined) return false;
  const recordFlowVersion = Number(record?.flowVersion || 1);
  return recordFlowVersion !== currentFlowVersion;
};

const replicateStageWipToParallelSeats = ({
  byStageMap = new Map(),
  bySeatStageMap = new Map(),
  stageSeatFallbackMap = new Map(),
}) => {
  byStageMap.forEach((stageRow) => {
    const stageName = normalizeValue(stageRow?.stageName);
    const stageKey = normalizeKey(stageName);
    const wip = Number(stageRow?.wip || 0);
    if (!stageKey || wip <= 0) return;

    const seats = stageSeatFallbackMap.get(stageKey) || [];
    seats.forEach((seatKey) => {
      const seat = normalizeValue(seatKey);
      if (!seat) return;
      const mapKey = `${seat}:${stageKey}`;
      if (!bySeatStageMap.has(mapKey)) {
        bySeatStageMap.set(mapKey, getDefaultSeatStageRow(seat, stageName));
      }
      const seatRow = bySeatStageMap.get(mapKey);
      const perSeatWip = Number(seatRow?.wip || 0);
      if (perSeatWip <= 0) {
        seatRow.wip = wip;
      }
    });
  });
};

const seedCommonStageRows = (commonStages = [], upsertStage) => {
  (Array.isArray(commonStages) ? commonStages : []).forEach((stage) => {
    const stageName = normalizeValue(stage?.stageName || stage?.name || stage?.stage);
    if (stageName) upsertStage(stageName);
  });
};

const getStageSeatFallbackMap = (assignedStages = {}) => {
  const stageSeatMap = new Map();
  sortSeatKeys(Object.keys(assignedStages || {})).forEach((seatKey) => {
    const seatEntry = getSeatStageEntry(assignedStages, seatKey);
    if (!seatEntry || seatEntry?.reserved) return;
    const stageName = normalizeValue(seatEntry?.stageName || seatEntry?.name || seatEntry?.stage);
    if (!stageName) return;
    const stageKey = normalizeKey(stageName);
    if (!stageSeatMap.has(stageKey)) stageSeatMap.set(stageKey, []);
    stageSeatMap.get(stageKey).push(seatKey);
  });
  return stageSeatMap;
};

const getDeviceSeatKeyForStage = ({ latestRecord = null, stageName = "", stageSeatFallbackMap = new Map() }) => {
  const normalizedStage = normalizeKey(stageName);
  if (latestRecord) {
    const directStage = normalizeKey(
      latestRecord?.currentLogicalStage ||
      latestRecord?.currentStage ||
      latestRecord?.stageName,
    );
    if (directStage === normalizedStage) {
      const directSeat = normalizeValue(
        latestRecord?.currentSeatKey ||
        latestRecord?.seatNumber ||
        latestRecord?.assignedSeatKey,
      );
      if (directSeat) return directSeat;
    }

    const routedStage = normalizeKey(
      latestRecord?.nextLogicalStage ||
      latestRecord?.currentLogicalStage ||
      latestRecord?.currentStage ||
      latestRecord?.stageName,
    );
    if (routedStage === normalizedStage) {
      const routedSeat = normalizeValue(
        latestRecord?.assignedSeatKey ||
        latestRecord?.currentSeatKey ||
        latestRecord?.seatNumber,
      );
      if (routedSeat) return routedSeat;
    }
  }

  const candidates = stageSeatFallbackMap.get(normalizedStage) || [];
  if (candidates.length === 1) return candidates[0];
  return "";
};

/** Seat attribution on test records (same precedence everywhere). */
const getRecordSeatKey = (record) =>
  normalizeValue(record?.seatNumber || record?.currentSeatKey || record?.assignedSeatKey);

const buildStageOrderMap = ({ processStages = [], commonStages = [] }) => {
  const order = new Map();
  [...(Array.isArray(processStages) ? processStages : []), ...(Array.isArray(commonStages) ? commonStages : [])]
    .forEach((stage, index) => {
      const key = normalizeKey(stage?.stageName || stage?.name || stage?.stage);
      if (key && !order.has(key)) {
        order.set(key, index);
      }
    });
  return order;
};

const sortStageRows = (rows = [], orderMap = new Map()) =>
  [...rows].sort((left, right) => {
    const leftKey = normalizeKey(left?.stageName);
    const rightKey = normalizeKey(right?.stageName);
    const leftIndex = orderMap.has(leftKey) ? Number(orderMap.get(leftKey)) : Number.MAX_SAFE_INTEGER;
    const rightIndex = orderMap.has(rightKey) ? Number(orderMap.get(rightKey)) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return String(left?.stageName || "").localeCompare(String(right?.stageName || ""));
  });

const sortSeatStageRows = (rows = [], orderMap = new Map()) =>
  [...rows].sort((left, right) => {
    const seatCompare = sortSeatKeys([left?.seatKey || "", right?.seatKey || ""])[0] === (left?.seatKey || "")
      ? -1
      : 1;
    if ((left?.seatKey || "") !== (right?.seatKey || "")) return seatCompare;
    const leftKey = normalizeKey(left?.stageName);
    const rightKey = normalizeKey(right?.stageName);
    const leftIndex = orderMap.has(leftKey) ? Number(orderMap.get(leftKey)) : Number.MAX_SAFE_INTEGER;
    const rightIndex = orderMap.has(rightKey) ? Number(orderMap.get(rightKey)) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return String(left?.stageName || "").localeCompare(String(right?.stageName || ""));
  });

// Newest-first scan cap for insight aggregations. The old 5000/2000 caps were
// already exceeded by large plans (2000 devices × 12 stages ≈ 24k records),
// silently dropping older stage records from the metrics.
const INSIGHTS_RECORD_SCAN_LIMIT = Number(process.env.PLAN_INSIGHTS_SCAN_LIMIT) || 50000;

const buildLatestRecordPipeline = (match = {}) => [
  { $match: match },
  { $sort: { createdAt: -1 } },
  { $limit: INSIGHTS_RECORD_SCAN_LIMIT },
  {
    $project: {
      _id: 1,
      planId: 1,
      processId: 1,
      operatorId: 1,
      deviceId: 1,
      serialNo: 1,
      seatNumber: 1,
      stageName: 1,
      status: 1,
      assignedSeatKey: 1,
      currentSeatKey: 1,
      nextLogicalStage: 1,
      currentLogicalStage: 1,
      currentStage: 1,
      assignedDeviceTo: 1,
      flowVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  },
];

// getOperatorTodayStats runs on EVERY insights request — including shared-cache
// hits — so with operators polling it becomes a steady stream of redundant
// aggregations. A short promise cache collapses them.
const OPERATOR_TODAY_CACHE_TTL_MS = 15000;
const operatorTodayStatsCache = new Map();
const getOperatorTodayStatsCached = (params = {}) => {
  const key = [params.operatorId || "", params.planId || "", params.processId || ""].join("|");
  const now = Date.now();
  const hit = operatorTodayStatsCache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;
  if (operatorTodayStatsCache.size > 500) {
    operatorTodayStatsCache.forEach((entry, entryKey) => {
      if (entry.expiresAt <= now) operatorTodayStatsCache.delete(entryKey);
    });
  }
  const promise = getOperatorTodayStats(params);
  promise.catch(() => operatorTodayStatsCache.delete(key));
  operatorTodayStatsCache.set(key, { promise, expiresAt: now + OPERATOR_TODAY_CACHE_TTL_MS });
  return promise;
};

const getOperatorTodayStats = async ({ operatorId = "", planId = "", processId = "" }) => {
  if (!operatorId || !mongoose.Types.ObjectId.isValid(String(operatorId))) {
    return { totalAttempts: 0, totalCompleted: 0, totalNg: 0 };
  }
  const start = moment.tz(PLANNING_TIMEZONE).startOf("day").toDate();
  const end = moment.tz(PLANNING_TIMEZONE).endOf("day").toDate();
  const match = {
    operatorId: new mongoose.Types.ObjectId(String(operatorId)),
    createdAt: { $gte: start, $lte: end },
  };
  if (planId && mongoose.Types.ObjectId.isValid(String(planId))) {
    match.planId = new mongoose.Types.ObjectId(String(planId));
  }
  if (processId && mongoose.Types.ObjectId.isValid(String(processId))) {
    match.processId = new mongoose.Types.ObjectId(String(processId));
  }

  const statsRows = await deviceTestRecordModel.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalAttempts: {
          $sum: {
            $cond: [
              {
                $in: [
                  { $toLower: { $ifNull: ["$status", ""] } },
                  ["pass", "completed", "ng", "fail"],
                ],
              },
              1,
              0,
            ],
          },
        },
        totalCompleted: {
          $sum: {
            $cond: [
              { $in: [{ $toLower: { $ifNull: ["$status", ""] } }, ["pass", "completed"]] },
              1,
              0,
            ],
          },
        },
        totalNg: {
          $sum: {
            $cond: [
              { $in: [{ $toLower: { $ifNull: ["$status", ""] } }, ["ng", "fail"]] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  const stats = statsRows?.[0] || {};
  return {
    totalAttempts: Number(stats.totalAttempts || 0),
    totalCompleted: Number(stats.totalCompleted || 0),
    totalNg: Number(stats.totalNg || 0),
  };
};

const getTodayLatestTestedCount = async ({ planId = "", processId = "" }) => {
  if (!planId || !mongoose.Types.ObjectId.isValid(String(planId))) return 0;
  const start = moment.tz(PLANNING_TIMEZONE).startOf("day").toDate();
  const end = moment.tz(PLANNING_TIMEZONE).endOf("day").toDate();

  const match = {
    planId: new mongoose.Types.ObjectId(String(planId)),
    createdAt: { $gte: start, $lte: end },
  };
  if (processId && mongoose.Types.ObjectId.isValid(String(processId))) {
    match.processId = new mongoose.Types.ObjectId(String(processId));
  }

  const rows = await deviceTestRecordModel
    .aggregate(buildLatestRecordPipeline(match));
  return Array.isArray(rows)
    ? rows.filter((row) => isCountableStatus(row?.status)).length
    : 0;
};

const filterRecordsByDateKey = (records = [], dateFrom = "", dateTo = "") => {
  const from = normalizeValue(dateFrom);
  const to = normalizeValue(dateTo);
  if (!from && !to) return Array.isArray(records) ? records : [];
  return (Array.isArray(records) ? records : []).filter((record) => {
    const createdAt = record?.createdAt ? new Date(record.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) return false;
    const key = toPlanningDateKey(createdAt);
    if (from && key < from) return false;
    if (to && key > to) return false;
    return true;
  });
};

const countInclusiveCalendarDays = (dateFrom = "", dateTo = "") => {
  const from = normalizeValue(dateFrom);
  const to = normalizeValue(dateTo);
  if (!from || !to) return 1;
  const start = moment(from, "YYYY-MM-DD", true);
  const end = moment(to, "YYYY-MM-DD", true);
  if (!start.isValid() || !end.isValid()) return 1;
  return Math.max(end.diff(start, "days") + 1, 1);
};

const computePlanInsightsUncached = async ({
  planId = "",
  processId = "",
  operatorId = "",
  assignedStages = {},
  processStages = [],
  commonStages = [],
  selectedProduct = "",
  quantity = 0,
  shift = null,
  issuedKits = 0,
  dateFrom = "",
  dateTo = "",
}) => {
  if (!planId || !mongoose.Types.ObjectId.isValid(String(planId))) {
    return {
      generatedAt: new Date().toISOString(),
      totals: {
        tested: 0,
        pass: 0,
        ng: 0,
        wip: 0,
        lineIssueKits: 0,
        kitsShortage: 0,
        operatorToday: { totalAttempts: 0, totalCompleted: 0, totalNg: 0 },
        efficiency: { process: 0, today: 0 },
      },
      byStage: [],
      bySeatStage: [],
      latestRecords: [],
      operatorActivityTimestamps: {
        stageAssignmentStart: null,
        operatorLogin: null,
        firstDeviceStart: null,
      },
    };
  }

  const normalizedAssignedStages = normalizeAssignedStagesPayload(
    assignedStages,
    processStages,
    commonStages,
  );
  const stageOrderMap = buildStageOrderMap({ processStages, commonStages });
  const stageSeatFallbackMap = getStageSeatFallbackMap(normalizedAssignedStages);
  const stageAliasLookup = buildStageAliasLookup({ processStages, commonStages });

  // Prioritize processId to match historical records exactly.
  // Many records might be created without a specific planId during testing or migration.
  const latestMatch = {};
  if (processId && mongoose.Types.ObjectId.isValid(String(processId))) {
    latestMatch.processId = new mongoose.Types.ObjectId(String(processId));
  } else if (planId && mongoose.Types.ObjectId.isValid(String(planId))) {
    latestMatch.planId = new mongoose.Types.ObjectId(String(planId));
  }
  const latestRecords = await deviceTestRecordModel
    .aggregate(buildLatestRecordPipeline(latestMatch));

  const byStageMap = new Map();
  const bySeatStageMap = new Map();

  const upsertStage = (stageName) => {
    const canonical = resolveCanonicalStageName(stageName, stageAliasLookup);
    const key = normalizeKey(canonical);
    if (!key) return null;
    if (!byStageMap.has(key)) {
      byStageMap.set(key, getDefaultStageRow(canonical));
    }
    return byStageMap.get(key);
  };

  const upsertSeatStage = (seatKey, stageName) => {
    const seat = normalizeValue(seatKey);
    const stage = resolveCanonicalStageName(stageName, stageAliasLookup);
    if (!seat || !stage) return null;
    const key = `${seat}:${normalizeKey(stage)}`;
    if (!bySeatStageMap.has(key)) {
      bySeatStageMap.set(key, getDefaultSeatStageRow(seat, stage));
    }
    return bySeatStageMap.get(key);
  };

  seedCommonStageRows(commonStages, upsertStage);

  const hasDateFilter = Boolean(normalizeValue(dateFrom) || normalizeValue(dateTo));
  const scopedLatestRecords = filterRecordsByDateKey(latestRecords, dateFrom, dateTo);

  const latestByDeviceStage = new Map();
  const latestBySerial = new Map();
  
  (Array.isArray(scopedLatestRecords) ? scopedLatestRecords : []).forEach((record) => {
    const deviceId = String(record?.deviceId?._id || record?.deviceId || record?.serialNo || "");
    const stageKey = normalizeKey(record?.stageName || record?.currentStage || "");
    if (!deviceId || !stageKey) return;
    
    // 1. DEDUPE: Only keep the LATEST record per device PER STAGE
    // Since latestRecords is sorted by createdAt DESC, the first one we find is the newest.
    const dsKey = `${deviceId}:${stageKey}`;
    if (!latestByDeviceStage.has(dsKey)) {
      latestByDeviceStage.set(dsKey, record);
    }
    
    // 2. Latest per device overall (for process-wide totals)
    const serial = normalizeValue(record?.serialNo || deviceId);
    if (!latestBySerial.has(serial)) {
       latestBySerial.set(serial, record);
    }
  });

  const dedupedRecords = Array.from(latestByDeviceStage.values());
  const processedDeviceIds = new Set();

  const planSerialsEarly = Array.from(latestBySerial.keys());
  const deviceFlowMatch = planSerialsEarly.length > 0 ? { serialNo: { $in: planSerialsEarly } } : {};
  if (processId && mongoose.Types.ObjectId.isValid(String(processId))) {
    deviceFlowMatch.processID = new mongoose.Types.ObjectId(String(processId));
  }

  const flowVersionDevices = planSerialsEarly.length > 0
    ? await deviceModel
        .find(deviceFlowMatch)
        .select("_id serialNo status currentStage flowVersion")
        .lean()
    : [];

  const deviceFlowVersions = buildDeviceFlowVersionMap(flowVersionDevices);

  const resolvedReturnByDevice = new Map();
  dedupedRecords.forEach((record) => {
    if (!isResolvedStatus(record?.status)) return;
    const deviceKey = getRecordDeviceKey(record);
    if (!deviceKey) return;
    const returnStage = getResolvedReturnStage(record);
    const existing = resolvedReturnByDevice.get(deviceKey);
    const recordTime = new Date(record?.createdAt || 0).getTime();
    if (!existing || recordTime >= existing.time) {
      resolvedReturnByDevice.set(deviceKey, {
        returnStage: normalizeKey(returnStage),
        time: recordTime,
      });
    }
  });

  dedupedRecords.forEach((record) => {
    if (shouldSkipRecordForFlowVersion(record, deviceFlowVersions)) return;

    const deviceId = String(record?.deviceId?._id || record?.deviceId || "");
    const deviceKey = getRecordDeviceKey(record);
    if (deviceId) processedDeviceIds.add(deviceId);

    const stageName = normalizeValue(record?.stageName || record?.currentStage || "");
    if (!stageName) return;

    const status = normalizeKey(record?.status);
    const isCountable = isCountableStatus(status);

    const resolvedCtx = deviceKey ? resolvedReturnByDevice.get(deviceKey) : null;
    if (
      isCountable &&
      isNgStatus(status) &&
      resolvedCtx &&
      normalizeKey(stageName) === resolvedCtx.returnStage
    ) {
      return;
    }
    
    if (isCountable) {
      const stageRow = upsertStage(stageName);
      if (stageRow) {
        stageRow.tested += 1;
        if (isPassStatus(status)) stageRow.pass += 1;
        if (isNgStatus(status)) stageRow.ng += 1;
      }

      const seatKey = getRecordSeatKey(record);
      if (seatKey) {
        const seatStageRow = upsertSeatStage(seatKey, stageName);
        if (seatStageRow) {
          seatStageRow.tested += 1;
          if (isPassStatus(status)) seatStageRow.pass += 1;
          if (isNgStatus(status)) seatStageRow.ng += 1;
        }
      }
    } else if (isResolvedStatus(record?.status)) {
      const returnStage = getResolvedReturnStage(record) || stageName;
      const stageRow = upsertStage(returnStage);
      if (stageRow) stageRow.wip += 1;

      const seatKey = getRecordSeatKey(record);
      if (seatKey) {
        const seatStageRow = upsertSeatStage(seatKey, returnStage);
        if (seatStageRow) seatStageRow.wip += 1;
      }
    }

    // Handle Stage Transition: Pass -> Next Stage WIP
    if (isPassStatus(status)) {
       const nextStageName = normalizeValue(record?.nextLogicalStage || "");
       if (nextStageName) {
          const deviceId = String(record?.deviceId?._id || record?.deviceId || "");
          const nextStageKey = normalizeKey(nextStageName);
          const dsKey = `${deviceId}:${nextStageKey}`;

          // Only count as WIP for the next stage if the device hasn't started that stage yet
          if (deviceId && !latestByDeviceStage.has(dsKey)) {
            const nextStageRow = upsertStage(nextStageName);
            if (nextStageRow) nextStageRow.wip += 1;

            const nextSeatKey = getDeviceSeatKeyForStage({
              latestRecord: record,
              stageName: nextStageName,
              stageSeatFallbackMap,
            });
            if (nextSeatKey) {
              const nextSeatStageRow = upsertSeatStage(nextSeatKey, nextStageName);
              if (nextSeatStageRow) nextSeatStageRow.wip += 1;
            }
          }
       }
    }
  });

  const firstProcessStage = normalizeValue(processStages?.[0]?.stageName || processStages?.[0]?.name || "");
  const planSerials = Array.from(latestBySerial.keys());
  
  const deviceMatch = { serialNo: { $in: planSerials } };
  if (processId && mongoose.Types.ObjectId.isValid(String(processId))) {
    deviceMatch.processID = new mongoose.Types.ObjectId(String(processId));
  }

  const deviceSnapshots = flowVersionDevices.length > 0
    ? flowVersionDevices
    : planSerials.length > 0
      ? await deviceModel.find(deviceMatch)
          .select("_id serialNo status currentStage processID imei imeiNo ccid flowVersion")
          .lean()
      : [];

  if (!deviceFlowVersions.size && deviceSnapshots.length > 0) {
    buildDeviceFlowVersionMap(deviceSnapshots).forEach((value, key) => {
      deviceFlowVersions.set(key, value);
    });
  }

  const deviceSnapshotMap = new Map();
  deviceSnapshots.forEach(d => {
    const s = normalizeValue(d.serialNo);
    if (s) deviceSnapshotMap.set(s, d);
  });

  const uniquePlanTotals = {
    tested: 0,
    pass: 0,
    ng: 0,
    wip: 0,
  };

  // Identify terminal units to exclude from active WIP
  const terminalDevicesInProcess = await deviceTestRecordModel.aggregate([
    { $match: { processId: new mongoose.Types.ObjectId(String(processId)) } },
    { $sort: { createdAt: -1 } },
    { $limit: INSIGHTS_RECORD_SCAN_LIMIT },
    {
      $group: {
        _id: "$deviceId",
        latestStatus: { $first: "$status" },
        latestAssignedTo: { $first: "$assignedDeviceTo" }
      }
    },
    {
      $match: {
        $or: [
          { latestStatus: { $in: ["NG", "Fail", "QC", "TRC", "Rework", "REJECTED"] } },
          { latestAssignedTo: { $in: ["QC", "TRC", "qc", "trc"] } }
        ]
      }
    }
  ]);

  const excludedIds = (terminalDevicesInProcess || []).map(r => r._id).filter(Boolean);

  const wipDevices = selectedProduct && processId && mongoose.Types.ObjectId.isValid(String(processId))
    ? await deviceModel
        .find({
          productType: selectedProduct,
          processID: new mongoose.Types.ObjectId(String(processId)),
          _id: { $nin: excludedIds }
        })
        .select("_id serialNo status currentStage processID imei imeiNo ccid flowVersion")
        .lean()
    : [];

  buildDeviceFlowVersionMap(wipDevices).forEach((value, key) => {
    if (!deviceFlowVersions.has(key)) deviceFlowVersions.set(key, value);
  });

  // Count active WIP (those without any test in this process yet)
  (Array.isArray(wipDevices) ? wipDevices : []).forEach((device) => {
     const deviceId = String(device?._id || "");
     if (processedDeviceIds.has(deviceId)) return;

     const stageName = normalizeValue(device?.currentStage || firstProcessStage);
     if (!stageName) return;

     const stageRow = upsertStage(stageName);
     if (!stageRow) return;

      if (isDeviceTerminalNg(device)) {
        stageRow.tested += 1;
        stageRow.ng += 1;
      } else if (normalizeKey(device?.status) === "completed" || normalizeKey(device?.status) === "dispatched") {
        stageRow.tested += 1;
        stageRow.pass += 1;
      } else {
         stageRow.wip += 1;
      }
  });

  replicateStageWipToParallelSeats({
    byStageMap,
    bySeatStageMap,
    stageSeatFallbackMap,
  });

  const countedSerials = new Set();
  const incrementUniqueTotals = (serial, status) => {
    if (!serial || countedSerials.has(serial)) return;
    countedSerials.add(serial);
    uniquePlanTotals.tested += 1;
    if (isPassStatus(status)) uniquePlanTotals.pass += 1;
    else if (isNgStatus(status)) uniquePlanTotals.ng += 1;
    else uniquePlanTotals.wip += 1;
  };

  // latestBySerial is already scoped to the requested date range (it is built
  // from scopedLatestRecords), so unique-per-device totals work for both the
  // overall and date-filtered cases. The previous date-filtered branch summed
  // per-stage rows instead, which counted the same device once per stage it
  // cleared — and the live-WIP augmentation below then inflated `tested` with
  // devices never tested in the range, making "today" totals exceed "overall".
  latestBySerial.forEach((record, serial) => {
    if (shouldSkipRecordForFlowVersion(record, deviceFlowVersions)) return;
    const status = normalizeKey(record?.status);
    if (isResolvedStatus(status)) {
      incrementUniqueTotals(serial, "wip");
      return;
    }
    incrementUniqueTotals(serial, status);
  });

  if (!hasDateFilter) {
    // Live devices with no test record yet count toward the plan-wide totals,
    // but only for the overall view — they have no activity inside a date range.
    (Array.isArray(wipDevices) ? wipDevices : []).forEach((device) => {
      const deviceId = String(device?._id || "");
      if (processedDeviceIds.has(deviceId)) return;
      const serial = normalizeValue(device.serialNo);
      if (!serial || countedSerials.has(serial)) return;
      countedSerials.add(serial);
      uniquePlanTotals.tested += 1;
      if (isDeviceTerminalNg(device)) uniquePlanTotals.ng += 1;
      else if (normalizeKey(device?.status) === "completed" || normalizeKey(device?.status) === "dispatched") {
        uniquePlanTotals.pass += 1;
      } else {
        uniquePlanTotals.wip += 1;
      }
    });
  }

  mergeAliasedStageRows(byStageMap, stageAliasLookup);
  const pipelineDevices = Array.from(
    new Map(
      [...(Array.isArray(deviceSnapshots) ? deviceSnapshots : []), ...(Array.isArray(wipDevices) ? wipDevices : [])]
        .filter((device) => String(device?._id || device?.serialNo || ""))
        .map((device) => [String(device?._id || device?.serialNo || ""), device]),
    ).values(),
  );
  reconcileCommonStageMetrics({
    commonStages,
    devices: pipelineDevices,
    byStageMap,
    upsertStage,
  });

  const dateFilterDays = hasDateFilter ? countInclusiveCalendarDays(dateFrom, dateTo) : 1;

  const byStage = sortStageRows(
    Array.from(byStageMap.values()).map((row) => {
      const stageKey = normalizeKey(row?.stageName);
      const stageDef = [...(processStages || []), ...(commonStages || [])].find(
        (stage) => normalizeKey(stage?.stageName || stage?.name || stage?.stage) === stageKey,
      );
      const targetUph = Number(stageDef?.upha || 0);
      const productiveHours = getShiftProductiveHours(shift);
      const hoursForRange = productiveHours * dateFilterDays;
      const achievedUph =
        hoursForRange > 0
          ? Number((Number(row?.pass || 0) / hoursForRange).toFixed(2))
          : 0;
      return {
        ...row,
        upha: targetUph,
        achievedUph,
      };
    }),
    stageOrderMap,
  );
  const bySeatStage = sortSeatStageRows(Array.from(bySeatStageMap.values()), stageOrderMap);

  const targetUpha = getTargetUpha({ processStages, commonStages });
  const productiveHours = getShiftProductiveHours(shift);
  const productiveHoursForRange = productiveHours * dateFilterDays;
  const denominator = targetUpha > 0 && productiveHoursForRange > 0 ? targetUpha * productiveHoursForRange : 0;
  const todayTested = await getTodayLatestTestedCount({ planId, processId });
  const processEfficiency = denominator > 0 ? Number(((uniquePlanTotals.tested / denominator) * 100).toFixed(2)) : 0;
  const todayEfficiency = denominator > 0 ? Number(((todayTested / denominator) * 100).toFixed(2)) : 0;
  const operatorToday = await getOperatorTodayStatsCached({ operatorId, planId, processId });

  const lineIssueKitsCount = Number(issuedKits) || (uniquePlanTotals.pass + uniquePlanTotals.ng + uniquePlanTotals.wip);
  const kitsShortageCount = Math.max(0, lineIssueKitsCount - (uniquePlanTotals.pass + uniquePlanTotals.ng + uniquePlanTotals.wip));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      tested: uniquePlanTotals.tested,
      pass: uniquePlanTotals.pass,
      ng: uniquePlanTotals.ng,
      wip: uniquePlanTotals.wip,
      lineIssueKits: lineIssueKitsCount,
      kitsShortage: kitsShortageCount,
      operatorToday,
      efficiency: {
        process: processEfficiency,
        today: todayEfficiency,
      },
      targetUpha,
      productiveHours: productiveHoursForRange,
    },
    byStage,
    bySeatStage,
    latestRecords: latestRecords || [],
  };
};

// Every open operator seat polls computePlanInsights every ~10-30s. The heavy
// aggregation work above is identical for every operator on the same
// plan/process within a short window, so we collapse concurrent/near-concurrent
// calls into a single computation and only recompute the cheap per-operator
// fields (operatorToday, lineIssueKits, kitsShortage) on every call.
const SHARED_PLAN_INSIGHTS_CACHE_TTL_MS = 12000;
const sharedPlanInsightsCache = new Map();

const computePlanInsights = async (params) => {
  const { planId = "", processId = "", operatorId = "", issuedKits = 0 } = params || {};

  if (!planId || !mongoose.Types.ObjectId.isValid(String(planId))) {
    return computePlanInsightsUncached(params);
  }

  const cacheKey = [planId, processId, params.dateFrom || "", params.dateTo || ""].join("|");
  const now = Date.now();
  const cached = sharedPlanInsightsCache.get(cacheKey);

  let basePromise;
  if (cached && cached.expiresAt > now) {
    basePromise = cached.promise;
  } else {
    basePromise = computePlanInsightsUncached(params);
    basePromise.catch(() => sharedPlanInsightsCache.delete(cacheKey));
    sharedPlanInsightsCache.set(cacheKey, { expiresAt: now + SHARED_PLAN_INSIGHTS_CACHE_TTL_MS, promise: basePromise });
  }

  const base = await basePromise;
  const operatorToday = await getOperatorTodayStatsCached({ operatorId, planId, processId });

  const totalsBase = base.totals || {};
  const producedTotal = Number(totalsBase.pass || 0) + Number(totalsBase.ng || 0) + Number(totalsBase.wip || 0);
  const lineIssueKitsCount = Number(issuedKits) || producedTotal;
  const kitsShortageCount = Math.max(0, lineIssueKitsCount - producedTotal);

  return {
    ...base,
    totals: {
      ...totalsBase,
      lineIssueKits: lineIssueKitsCount,
      kitsShortage: kitsShortageCount,
      operatorToday,
    },
  };
};

const computeProcessInsights = async ({
  processId = "",
  processStages = [],
  commonStages = [],
  selectedProduct = "",
  quantity = 0,
}) => {
  if (!processId || !mongoose.Types.ObjectId.isValid(String(processId))) {
    return {
      generatedAt: new Date().toISOString(),
      totals: { tested: 0, pass: 0, ng: 0, wip: 0 },
      byStage: [],
    };
  }

  const stageOrderMap = buildStageOrderMap({ processStages, commonStages });
  const stageAliasLookup = buildStageAliasLookup({ processStages, commonStages });

  const latestMatch = { processId: new mongoose.Types.ObjectId(String(processId)) };
  const latestRecords = await deviceTestRecordModel
    .aggregate(buildLatestRecordPipeline(latestMatch));

  const byStageMap = new Map();
  const upsertStage = (stageName) => {
    const canonical = resolveCanonicalStageName(stageName, stageAliasLookup);
    const key = normalizeKey(canonical);
    if (!key) return null;
    if (!byStageMap.has(key)) {
      byStageMap.set(key, getDefaultStageRow(canonical));
    }
    return byStageMap.get(key);
  };

  const firstProcessStage = normalizeValue(processStages?.[0]?.stageName || processStages?.[0]?.name || "");

  // Identify terminal devices to exclude from WIP
  const terminalDevicesInProcess = await deviceTestRecordModel.aggregate([
    { $match: { processId: new mongoose.Types.ObjectId(String(processId)) } },
    { $sort: { createdAt: -1 } },
    { $limit: INSIGHTS_RECORD_SCAN_LIMIT },
    {
      $group: {
        _id: "$deviceId",
        latestStatus: { $first: "$status" },
        latestAssignedTo: { $first: "$assignedDeviceTo" }
      }
    },
    {
      $match: {
        $or: [
          { latestStatus: { $in: ["NG", "Fail", "QC", "TRC", "Rework", "REJECTED"] } },
          { latestAssignedTo: { $in: ["QC", "TRC", "qc", "trc"] } }
        ]
      }
    }
  ]);

  const excludedIds = (terminalDevicesInProcess || []).map(r => r._id).filter(Boolean);

  const wipDevices = selectedProduct && processId && mongoose.Types.ObjectId.isValid(String(processId))
    ? await deviceModel
        .find({
          productType: selectedProduct,
          processID: new mongoose.Types.ObjectId(String(processId)),
          _id: { $nin: excludedIds }
        })
        .select("_id serialNo status currentStage processID imei imeiNo ccid")
        .lean()
    : [];

  const bySeatStageMap = new Map();
  const upsertSeatStage = (seatKey, stageName) => {
    const seat = String(seatKey || "").trim();
    const stage = normalizeValue(stageName);
    if (!seat || !stage) return null;
    const key = `${seat}:${normalizeKey(stage)}`;
    if (!bySeatStageMap.has(key)) {
      bySeatStageMap.set(key, getDefaultSeatStageRow(seat, stage));
    }
    return bySeatStageMap.get(key);
  };

  seedCommonStageRows(commonStages, upsertStage);

  // Use a Map to keep track of the LATEST record per device PER STAGE
  // This ensures we match the history modal's logic exactly.
  const latestByDeviceStage = new Map();
  
  (Array.isArray(latestRecords) ? latestRecords : []).forEach((record) => {
    const deviceId = String(record?.deviceId?._id || record?.deviceId || record?.serialNo || "");
    const stageKey = normalizeKey(record?.stageName || record?.currentStage || "");
    if (!deviceId || !stageKey) return;
    
    // DEDUPE: Only keep the LATEST record per device PER STAGE
    const key = `${deviceId}:${stageKey}`;
    if (!latestByDeviceStage.has(key)) {
      latestByDeviceStage.set(key, record);
    }
  });

  const processedDeviceIds = new Set();
  const dedupedRecords = Array.from(latestByDeviceStage.values());

  const processFlowDevices = await deviceModel
    .find({
      processID: new mongoose.Types.ObjectId(String(processId)),
    })
    .select("_id serialNo status currentStage flowVersion")
    .lean();
  const deviceFlowVersions = buildDeviceFlowVersionMap(processFlowDevices);
  
  // 1. Process all test records (Pass/NG/QC/TRC)
  dedupedRecords.forEach((record) => {
    if (shouldSkipRecordForFlowVersion(record, deviceFlowVersions)) return;

    const deviceId = String(record?.deviceId?._id || record?.deviceId || "");
    if (deviceId) processedDeviceIds.add(deviceId);

    const currentStageName = normalizeValue(record?.stageName || record?.currentStage || "");
    if (!currentStageName) return;

    const status = normalizeKey(record?.status);
    const seatKey = getRecordSeatKey(record);

    // Increment tested/pass/ng for the stage where the test happened
    if (isCountableStatus(status)) {
      const stageRow = upsertStage(currentStageName);
      if (stageRow) {
        stageRow.tested += 1;
        if (isPassStatus(status)) stageRow.pass += 1;
        if (isNgStatus(status)) stageRow.ng += 1;
      }

      if (seatKey) {
        const seatRow = upsertSeatStage(seatKey, currentStageName);
        if (seatRow) {
          seatRow.tested += 1;
          if (isPassStatus(status)) seatRow.pass += 1;
          if (isNgStatus(status)) seatRow.ng += 1;
        }
      }
    } else if (isResolvedStatus(record?.status)) {
      const returnStage = getResolvedReturnStage(record) || currentStageName;
      const stageRow = upsertStage(returnStage);
      if (stageRow) stageRow.wip += 1;

      if (seatKey) {
        const seatRow = upsertSeatStage(seatKey, returnStage);
        if (seatRow) seatRow.wip += 1;
      }
    }
  });

  // 2. Process all other active devices (those without test records yet)
  (Array.isArray(wipDevices) ? wipDevices : []).forEach((device) => {
    const deviceId = String(device?._id || "");
    if (processedDeviceIds.has(deviceId)) return;

    const stageName = normalizeValue(device?.currentStage || firstProcessStage);
    if (!stageName) return;

    const stageRow = upsertStage(stageName);
    if (!stageRow) return;

    if (isDeviceTerminalNg(device)) {
       stageRow.tested += 1;
       stageRow.ng += 1;
    } else if (normalizeKey(device?.status) === "completed" || normalizeKey(device?.status) === "dispatched" || normalizeKey(device?.status) === "pass") {
       stageRow.tested += 1;
       stageRow.pass += 1;
    } else {
      stageRow.wip += 1;
    }
  });

  // Totals: pass/ng from latest row per device-stage combo; wip = sum of stage-level wip buckets
  const uniqueProcessTotals = {
    tested: dedupedRecords?.length || 0,
    pass: 0,
    ng: 0,
    wip: 0,
  };

  dedupedRecords.forEach((record) => {
    if (isPassStatus(record?.status)) uniqueProcessTotals.pass += 1;
    if (isNgStatus(record?.status)) uniqueProcessTotals.ng += 1;

    // Determine if this device should contribute to WIP of the NEXT stage
    if (isPassStatus(record?.status)) {
      const nextStageName = normalizeValue(record?.nextLogicalStage || "");
      if (nextStageName) {
        const deviceId = String(record?.deviceId?._id || record?.deviceId || "");
        const nextStageKey = normalizeKey(nextStageName);
        const dsKey = `${deviceId}:${nextStageKey}`;

        // Only count as WIP for the next stage if the device hasn't started that stage yet
        if (deviceId && !latestByDeviceStage.has(dsKey)) {
          const nextStageRow = upsertStage(nextStageName);
          if (nextStageRow) nextStageRow.wip += 1;
        }
      }
    }
  });

  mergeAliasedStageRows(byStageMap, stageAliasLookup);
  reconcileCommonStageMetrics({
    commonStages,
    devices: processFlowDevices,
    byStageMap,
    upsertStage,
  });

  const byStage = sortStageRows(Array.from(byStageMap.values()), stageOrderMap);
  const bySeatStage = sortSeatStageRows(Array.from(bySeatStageMap.values()), stageOrderMap);

  uniqueProcessTotals.wip = byStage.reduce(
    (sum, row) => sum + Number(row?.wip || 0),
    0,
  );

  const operatorActivityTimestamps = await computeOperatorActivityTimestamps({
    planId,
    processId,
  });

  return {
    generatedAt: new Date().toISOString(),
    totals: uniqueProcessTotals,
    byStage,
    bySeatStage,
    operatorActivityTimestamps,
  };
};

const toIsoOrNull = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const formatOperatorRef = (operatorDoc) => {
  if (!operatorDoc) return { operatorId: null, operatorName: null, employeeCode: null };
  const operatorId = String(operatorDoc?._id || operatorDoc?.id || operatorDoc || "");
  const operatorName = normalizeValue(operatorDoc?.name) || null;
  const employeeCode = normalizeValue(operatorDoc?.employeeCode) || null;
  return {
    operatorId: operatorId || null,
    operatorName: operatorName || employeeCode || null,
    employeeCode: employeeCode || null,
  };
};

const computeOperatorActivityTimestamps = async ({
  planId = "",
  processId = "",
  seatKey = "",
  stageName = "",
  operatorIds = [],
  dateFrom = "",
  dateTo = "",
} = {}) => {
  const empty = {
    stageAssignmentStart: null,
    operatorLogin: null,
    firstDeviceStart: null,
  };

  if (!processId || !mongoose.Types.ObjectId.isValid(String(processId))) {
    return empty;
  }

  const processObjId = new mongoose.Types.ObjectId(String(processId));
  const normalizedSeatKey = normalizeValue(seatKey);
  const normalizedStageName = normalizeValue(stageName);

  const parseSeatParts = (key) => {
    const parts = String(key || "").split("-");
    return {
      rowNumber: normalizeValue(parts[0]) || "",
      seatNumber: normalizeValue(parts[1]) || "",
    };
  };

  const assignmentQuery = { processId: processObjId, status: "Occupied" };
  if (normalizedSeatKey) {
    const { rowNumber, seatNumber } = parseSeatParts(normalizedSeatKey);
    if (rowNumber) assignmentQuery["seatDetails.rowNumber"] = rowNumber;
    if (seatNumber) assignmentQuery["seatDetails.seatNumber"] = seatNumber;
  }

  const normalizedOperatorIds = (Array.isArray(operatorIds) ? operatorIds : [])
    .map((id) => String(id || "").trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const fromTrim = normalizeValue(dateFrom);
  const toTrim = normalizeValue(dateTo);
  const hasDateRange = Boolean(fromTrim || toTrim);
  const { start: rangeStart, end: rangeEnd } = hasDateRange
    ? getPlanningDayRange(fromTrim, toTrim)
    : { start: null, end: null };
  const applyDateRange = (query, field) => {
    if (!hasDateRange) return query;
    const filter = {};
    if (rangeStart) filter.$gte = rangeStart;
    if (rangeEnd) filter.$lte = rangeEnd;
    if (Object.keys(filter).length) query[field] = filter;
    return query;
  };

  const sessionQuery = { processId: processObjId };
  if (normalizedOperatorIds.length > 0) {
    sessionQuery.operatorId = { $in: normalizedOperatorIds };
  }
  applyDateRange(sessionQuery, "startedAt");

  // "Stage Assignment Start" must reflect the operator's TASK_START click for
  // TODAY's session, not assignOperatorToPlan.createdAt — that document is
  // upserted once per (processId, userId) and its createdAt is permanently
  // stuck at the first-ever assignment date, which is why this kept showing
  // stale/old dates instead of today's start time.
  const taskStartEventQuery = { processId: processObjId, actionName: "TASK_START" };
  if (normalizedOperatorIds.length > 0) {
    taskStartEventQuery.operatorId = { $in: normalizedOperatorIds };
  }
  applyDateRange(taskStartEventQuery, "occurredAt");

  const deviceMatch = { processId: processObjId };
  if (normalizedStageName) {
    deviceMatch.stageName = new RegExp(
      `^${normalizedStageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    );
  }
  if (normalizedSeatKey) {
    deviceMatch.seatNumber = normalizedSeatKey;
  }

  const devicePipeline = [
    { $match: deviceMatch },
    {
      $addFields: {
        effectiveStart: { $ifNull: ["$startTime", "$createdAt"] },
      },
    },
    { $match: { effectiveStart: { $ne: null } } },
  ];

  if (hasDateRange) {
    const dateFilter = {};
    if (rangeStart) dateFilter.$gte = rangeStart;
    if (rangeEnd) dateFilter.$lte = rangeEnd;
    devicePipeline.push({ $match: { effectiveStart: dateFilter } });
  }

  devicePipeline.push(
    { $sort: { effectiveStart: 1 } },
    { $limit: 1 },
    {
      $lookup: {
        from: "users",
        localField: "operatorId",
        foreignField: "_id",
        as: "operator",
      },
    },
    { $unwind: { path: "$operator", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        effectiveStart: 1,
        startTime: 1,
        createdAt: 1,
        serialNo: 1,
        stageName: 1,
        operator: { _id: 1, name: 1, employeeCode: 1 },
      },
    },
  );

  const [stageAssignment, taskStartEvent, operatorLogin, firstDeviceRows] = await Promise.all([
    assignOperatorToPlanModel
      .findOne(assignmentQuery)
      .sort({ createdAt: 1 })
      .populate("userId", "name employeeCode")
      .select("createdAt userId stageType seatDetails")
      .lean(),
    OperatorWorkEvent.findOne(taskStartEventQuery)
      .sort({ occurredAt: 1 })
      .populate("operatorId", "name employeeCode")
      .select("occurredAt operatorId planId")
      .lean(),
    OperatorWorkSession.findOne(sessionQuery)
      .sort({ startedAt: 1 })
      .populate("operatorId", "name employeeCode")
      .select("startedAt operatorId planId")
      .lean(),
    deviceTestRecordModel.aggregate(devicePipeline),
  ]);

  const firstDevice = Array.isArray(firstDeviceRows) ? firstDeviceRows[0] : null;
  const taskStartOperator = formatOperatorRef(taskStartEvent?.operatorId);
  const loginOperator = formatOperatorRef(operatorLogin?.operatorId);
  const deviceOperator = formatOperatorRef(firstDevice?.operator);

  return {
    stageAssignmentStart: taskStartEvent?.occurredAt
      ? {
          at: toIsoOrNull(taskStartEvent.occurredAt),
          ...taskStartOperator,
          stageType: normalizeValue(stageAssignment?.stageType) || null,
          seatKey: stageAssignment?.seatDetails
            ? `${normalizeValue(stageAssignment.seatDetails.rowNumber)}-${normalizeValue(stageAssignment.seatDetails.seatNumber)}`.replace(
                /^-$/,
                "",
              ) || null
            : null,
        }
      : null,
    operatorLogin: operatorLogin?.startedAt
      ? {
          at: toIsoOrNull(operatorLogin.startedAt),
          ...loginOperator,
          planId: operatorLogin?.planId ? String(operatorLogin.planId) : null,
        }
      : null,
    firstDeviceStart: firstDevice?.effectiveStart
      ? {
          at: toIsoOrNull(firstDevice.effectiveStart),
          serialNo: normalizeValue(firstDevice?.serialNo) || null,
          stageName: normalizeValue(firstDevice?.stageName) || null,
          ...deviceOperator,
        }
      : null,
  };
};

module.exports = {
  normalizeValue,
  normalizeKey,
  PLANNING_TIMEZONE,
  toPlanningDateKey,
  getPlanningDayRange,
  safeJsonParse,
  sortSeatKeys,
  normalizeAssignedStagesPayload,
  getSeatStageEntry,
  isResolvedStatus,
  isDeviceTerminalNg,
  isActiveWipDeviceStatus,
  getResolvedReturnStage,
  getRecordSeatKey,
  computePlanInsights,
  computeProcessInsights,
  computeOperatorActivityTimestamps,
};
