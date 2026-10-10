const mongoose = require("mongoose");
const moment = require("moment-timezone");
const deviceModel = require("../models/device");
const deviceTestRecordModel = require("../models/deviceTestModel");
const assignOperatorToPlanModel = require("../models/assignOperatorToPlan");
const OperatorWorkSession = require("../models/operatorWorkSession");
const OperatorWorkEvent = require("../models/operatorWorkEvent");

const normalizeValue = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeValue(value).toLowerCase().replace(/\s+/g, " ");

// Live incident (2026-09-18): a plan with a large device-test history caused
// computePlanInsightsUncached's record loops to run for 100+ seconds straight.
// Node is single-threaded, so that blocked the event loop for the ENTIRE
// backend process — every other request, for every other plan/operator,
// froze for the same 100+ seconds, not just this one. Caching (elsewhere in
// this file) only reduces how OFTEN this runs; it does nothing once a run is
// actually in progress. This yields control back to the event loop every
// CHUNK_YIELD_SIZE iterations so a single huge plan's computation can no
// longer starve every other concurrent request — it still takes a while for
// that one request, but it stops taking the whole server down with it.
const CHUNK_YIELD_SIZE = 500;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
const forEachChunked = async (items, fn) => {
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    fn(list[i], i, list);
    if (i > 0 && i % CHUNK_YIELD_SIZE === 0) {
      await yieldToEventLoop();
    }
  }
};

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

// Serial Generator inserts Device docs the moment serials are created — well
// before Store issues kits, the Production Manager approves/allocates them,
// and the floor operator confirms receipt. Untested devices should not read
// as WIP until that chain has actually completed for the owning process.
// Matches the Process.status enum (models/process.js) verbatim, lowercased —
// normalizeKey collapses whitespace but does not touch underscores.
const PRE_KIT_CONFIRMATION_PROCESS_STATUSES = new Set([
  "waiting_schedule",
  "waiting_kits_allocation",
  "waiting_kits_approval",
  "waiting_for_line_feeding",
  "waiting_for_kits_confirmation",
]);

const isKitConfirmedProcessStatus = (processStatus) => {
  const normalized = normalizeKey(processStatus);
  if (!normalized) return false;
  return !PRE_KIT_CONFIRMATION_PROCESS_STATUSES.has(normalized);
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

// ---------------------------------------------------------------------------
// Stage-flow WIP ("chain" model)
//
// Every device of the plan's process lands in exactly ONE bucket, computed from
// the WHOLE plan history (the Today / From-To date filter never applies to WIP):
//   - line WIP of a stage of the process sequence (process stages, then common
//     stages, in the order the process defines them),
//   - the TRC bucket of a stage: NG units waiting in TRC/QC, attributed to the
//     stage they failed at (so "Functional: 13 = 5 line + 8 TRC"),
//   - "after last stage" (passed the final stage) or "rejected" (scrapped).
// A device is counted once per stage (its latest result), so retries and
// duplicate records can't double count. A unit that passes a stage leaves that
// stage's WIP and shows up in the next one.
//
// Parallel seats share one queue per stage, so WIP exists at stage level only;
// bySeatStage rows never carry WIP.
//
// Only the FIRST stage is derived from the kit allocation:
//   first-stage WIP = allocated kits - units that already passed it - rejected
//                     - its own TRC units
// which is what makes "sum of every stage WIP + after-last + rejected" equal the
// allocated kits.
// ---------------------------------------------------------------------------
const FINISHED_GOODS_STAGE_KEYS = new Set([
  "fg to store",
  "keep in store",
  "kept in store",
  "stocked",
]);

const isFinishedGoodsStage = (stageName) =>
  FINISHED_GOODS_STAGE_KEYS.has(normalizeStageKeyFlexible(stageName));

/** Canonical stage names in flow order: process stages, then common stages. */
const buildFlowStageNames = ({ processStages = [], commonStages = [], aliasLookup = new Map() } = {}) => {
  const names = [];
  const seen = new Set();
  [...(Array.isArray(processStages) ? processStages : []), ...(Array.isArray(commonStages) ? commonStages : [])]
    .forEach((stage) => {
      const canonical = resolveCanonicalStageName(
        stage?.stageName || stage?.name || stage?.stage,
        aliasLookup,
      );
      const key = normalizeKey(canonical);
      if (!key || seen.has(key)) return;
      seen.add(key);
      names.push(canonical);
    });
  return names;
};

const classifyFlowResult = (status) => {
  if (isPassStatus(status)) return "pass";
  if (isResolvedStatus(status)) return "resolved";
  if (isNgStatus(status)) return "ng";
  return "other";
};

/**
 * Places every device in exactly one bucket (see the block comment above).
 * Pure: no database access, so it can be unit tested with plain objects.
 *
 * `records` = latest test records of the process (any order, NOT date scoped);
 * `devices` = every Device doc of the process.
 */
const computeStageFlowSnapshot = ({
  stageNames = [],
  aliasLookup = new Map(),
  records = [],
  devices = [],
  // true = also report WHICH devices fall in each bucket (snapshot.membership).
  // Off in the hot insights path: it is only needed by the stage WIP popup.
  collectDevices = false,
} = {}) => {
  const stageCount = stageNames.length;
  const lineCount = new Array(stageCount).fill(0);
  const trcCount = new Array(stageCount).fill(0);
  // reach[p] = devices whose furthest point is position p (a TRC unit's point
  // is the stage it failed at, `stageCount` = past the last stage). A device is
  // counted once, so passedCount below never double counts retries/duplicates.
  const reach = new Array(stageCount + 1).fill(0);
  const deviceList = Array.isArray(devices) ? devices : [];
  const diagnostics = {
    unmappedStage: 0,
    ngWithoutSourceStage: 0,
    untestedAtFirstStage: 0,
  };
  const snapshot = {
    stageNames: [...stageNames],
    lineCount,
    trcCount,
    // passedCount[i] = devices that have passed stage i (unique, whole history).
    passedCount: new Array(stageCount).fill(0),
    afterLast: 0,
    rejected: 0,
    rejectedConsumed: 0,
    devicesBeyondFirstStage: 0,
    consumedKits: 0,
    deviceCount: deviceList.length,
    diagnostics,
  };
  if (collectDevices) {
    snapshot.membership = {
      // line[i] = ids of the units waiting on the line at stage i
      line: Array.from({ length: stageCount }, () => []),
      // trc[i] = NG units waiting in TRC/QC that failed at stage i
      trc: Array.from({ length: stageCount }, () => []),
      afterLast: [],
      rejected: [],
      // devices whose bucket depends on their test records (TRC source stage,
      // unmappable currentStage): a caller can fetch records for just these.
      needsRecords: [],
    };
  }
  if (stageCount === 0) return snapshot;

  const indexByKey = new Map(stageNames.map((name, index) => [normalizeKey(name), index]));
  // Returns the stage's position in the flow, `stageCount` for stages that come
  // after it (dispatch/delivery/kept in store), or -1 when it can't be mapped.
  const resolveStageIndex = (stageText) => {
    const raw = normalizeValue(stageText);
    if (!raw) return -1;
    const index = indexByKey.get(normalizeKey(resolveCanonicalStageName(raw, aliasLookup)));
    if (index !== undefined) return index;
    const flex = normalizeStageKeyFlexible(raw);
    if (POST_COMMON_STAGE_KEYS.has(flex) || flex.startsWith("dispatch") || flex.startsWith("deliver")) {
      return stageCount;
    }
    return -1;
  };

  const deviceFlowVersions = buildDeviceFlowVersionMap(deviceList);
  const deviceIdBySerial = new Map();
  deviceList.forEach((device) => {
    const serial = normalizeValue(device?.serialNo);
    if (serial) deviceIdBySerial.set(serial, String(device?._id || ""));
  });

  // Latest result per (device, stage) + the newest NG stage per device.
  const perDevice = new Map();
  (Array.isArray(records) ? records : []).forEach((record) => {
    if (shouldSkipRecordForFlowVersion(record, deviceFlowVersions)) return;
    const deviceId =
      String(record?.deviceId?._id || record?.deviceId || "").trim() ||
      deviceIdBySerial.get(normalizeValue(record?.serialNo)) ||
      "";
    if (!deviceId) return;
    // Records written at TRC / QC (or any non-plan stage) are not plan stages.
    const stageIndex = resolveStageIndex(record?.stageName || record?.currentStage);
    if (stageIndex < 0 || stageIndex >= stageCount) return;

    const time = new Date(record?.createdAt || 0).getTime() || 0;
    const result = classifyFlowResult(record?.status);
    let entry = perDevice.get(deviceId);
    if (!entry) {
      entry = { results: new Map(), ngIndex: -1, ngTime: -1 };
      perDevice.set(deviceId, entry);
    }
    const existing = entry.results.get(stageIndex);
    if (!existing || time > existing.time) entry.results.set(stageIndex, { result, time });
    if (result === "ng" && time > entry.ngTime) {
      entry.ngIndex = stageIndex;
      entry.ngTime = time;
    }
  });

  let rejectedConsumed = 0;
  const membership = snapshot.membership;
  deviceList.forEach((device) => {
    const deviceKey = String(device?._id || "");
    const entry = perDevice.get(deviceKey);
    let maxPassIndex = -1;
    entry?.results.forEach((value, index) => {
      if (value.result === "pass" && index > maxPassIndex) maxPassIndex = index;
    });

    const status = normalizeKey(device?.status);
    if (status === "rejected") {
      snapshot.rejected += 1;
      if (maxPassIndex >= 0) rejectedConsumed += 1;
      if (membership) membership.rejected.push(deviceKey);
      return;
    }
    if (status === "dispatched" || status === "completed") {
      snapshot.afterLast += 1;
      reach[stageCount] += 1;
      if (membership) membership.afterLast.push(deviceKey);
      return;
    }

    // NG unit waiting in TRC/QC: belongs to the stage it failed at.
    if (isDeviceTerminalNg(device) || isDepartmentStage(device?.currentStage)) {
      let sourceIndex = entry ? entry.ngIndex : -1;
      if (membership) {
        if (sourceIndex < 0) membership.needsRecords.push(deviceKey);
      }
      if (sourceIndex < 0) {
        diagnostics.ngWithoutSourceStage += 1;
        sourceIndex = Math.min(maxPassIndex + 1, stageCount - 1);
      }
      trcCount[sourceIndex] += 1;
      reach[sourceIndex] += 1;
      if (membership) {
        membership.trc[sourceIndex].push({
          id: deviceKey,
          // when it failed (null when no NG record could be found)
          ngTime: entry && entry.ngTime > 0 ? entry.ngTime : null,
        });
      }
      return;
    }

    // Where the device sits right now: its own currentStage is the truth (it is
    // updated in the same transaction as the test record, and common stages
    // such as PDI / FG to Store don't reliably write test records at all). Only
    // when that can't be mapped (empty / unknown name) do the test records
    // decide - and never by defaulting to the first stage.
    let position = resolveStageIndex(device?.currentStage);
    if (position < 0) {
      diagnostics.unmappedStage += 1;
      if (membership) membership.needsRecords.push(deviceKey);
      position = maxPassIndex + 1;
    }

    if (position >= stageCount) {
      snapshot.afterLast += 1;
      reach[stageCount] += 1;
      if (membership) membership.afterLast.push(deviceKey);
    } else {
      lineCount[position] += 1;
      reach[position] += 1;
      if (position === 0) diagnostics.untestedAtFirstStage += 1;
      if (membership) membership.line[position].push(deviceKey);
    }
  });

  // Devices that passed stage i = every device whose furthest point is beyond i.
  // The last stage's count is the units that completed the whole flow.
  let passedBeyond = 0;
  for (let index = stageCount - 1; index >= 0; index -= 1) {
    passedBeyond += reach[index + 1];
    snapshot.passedCount[index] = passedBeyond;
  }

  const beyondFirst = snapshot.passedCount[0];
  snapshot.devicesBeyondFirstStage = beyondFirst;
  snapshot.rejectedConsumed = rejectedConsumed;
  // Consumed kits = devices that have passed the first stage (scrapped units
  // that got past it consumed their kit as well).
  snapshot.consumedKits = beyondFirst + rejectedConsumed;
  return snapshot;
};

/**
 * Turns a snapshot into per-stage WIP rows + totals for one kit allocation.
 * Cheap, so the cached insights re-run it for every caller's own allocation.
 */
const finalizeStageFlow = (snapshot, { allocatedKits = 0, kitConfirmed = false } = {}) => {
  const allocated = Math.max(Number(allocatedKits) || 0, 0);
  const stageNames = snapshot?.stageNames || [];
  // FG to Store and every stage after it (Dispatch, Delivery...) hold finished
  // goods, not in-process work.
  const firstFinishedIndex = stageNames.findIndex((name) => isFinishedGoodsStage(name));
  const stages = stageNames.map((stageName, index) => {
    const trcWip = Number(snapshot.trcCount[index] || 0);
    let lineWip = Number(snapshot.lineCount[index] || 0);
    if (index === 0) {
      // Units that are already generated but not (yet) issued to the line are
      // not WIP, and kits that have no Device doc yet still are: so the first
      // stage comes from the allocation, never from counting Device docs.
      lineWip =
        kitConfirmed && snapshot.deviceCount > 0 && allocated > 0
          ? Math.max(allocated - snapshot.devicesBeyondFirstStage - snapshot.rejected - trcWip, 0)
          : 0;
    }
    return {
      stageName,
      lineWip,
      trcWip,
      wip: lineWip + trcWip,
      // Units that have passed this stage (unique devices, whole history): what
      // the strip shows as "done". waiting_i = done_(i-1) - done_i - TRC_i.
      doneCount: Number(snapshot.passedCount?.[index] || 0),
      finishedGoods: firstFinishedIndex >= 0 && index >= firstFinishedIndex,
    };
  });

  const inProcess = stages.filter((stage) => !stage.finishedGoods);
  const wipLine = inProcess.reduce((sum, stage) => sum + stage.lineWip, 0);
  const wipTrc = inProcess.reduce((sum, stage) => sum + stage.trcWip, 0);
  const finishedGoods = stages
    .filter((stage) => stage.finishedGoods)
    .reduce((sum, stage) => sum + stage.wip, 0);
  const stageWipSum = stages.reduce((sum, stage) => sum + stage.wip, 0);
  const accounted = stageWipSum + Number(snapshot.afterLast || 0) + Number(snapshot.rejected || 0);
  // In-process WIP split: what is still pending at the first stage (kits not
  // consumed yet) vs. what is in line after it.
  const wipFirstStage = stages[0] && !stages[0].finishedGoods ? stages[0].wip : 0;

  return {
    stages,
    totals: {
      wip: wipLine + wipTrc,
      wipLine,
      wipTrc,
      wipFirstStage,
      wipAfterFirstStage: wipLine + wipTrc - wipFirstStage,
      finishedGoodsWip: finishedGoods,
      // Units that passed the LAST stage (unique devices) = completed units.
      deliveredUnits: Number(snapshot.afterLast || 0),
      consumedKits: Number(snapshot.consumedKits || 0),
    },
    check: {
      allocatedKits: allocated,
      stageWipSum,
      afterLastStage: Number(snapshot.afterLast || 0),
      rejected: Number(snapshot.rejected || 0),
      rejectedConsumed: Number(snapshot.rejectedConsumed || 0),
      consumedKits: Number(snapshot.consumedKits || 0),
      accounted,
      balanced: kitConfirmed && allocated > 0 ? accounted === allocated : null,
    },
  };
};

/**
 * Overlays the flow WIP on an insights payload. Returns a new object (the base
 * may be the shared cached one), so it is safe to call once per request.
 */
const applyStageFlowToInsights = (base, { allocatedKits = 0 } = {}) => {
  const raw = base?.flow?.raw;
  if (!raw) return base;
  const flow = finalizeStageFlow(raw.snapshot, {
    allocatedKits,
    kitConfirmed: Boolean(raw.kitConfirmed),
  });
  const flowByKey = new Map(flow.stages.map((stage) => [normalizeKey(stage.stageName), stage]));

  const byStage = (Array.isArray(base.byStage) ? base.byStage : []).map((row) => {
    const flowRow = flowByKey.get(normalizeKey(row?.stageName));
    return {
      ...row,
      wip: flowRow ? flowRow.wip : 0,
      lineWip: flowRow ? flowRow.lineWip : 0,
      trcWip: flowRow ? flowRow.trcWip : 0,
      doneCount: flowRow ? flowRow.doneCount : 0,
      finishedGoods: flowRow ? flowRow.finishedGoods : false,
    };
  });
  // Stages with WIP but no tested/pass/ng row yet (e.g. a fresh first stage).
  const present = new Set(byStage.map((row) => normalizeKey(row?.stageName)));
  flow.stages.forEach((stage) => {
    if (stage.wip <= 0 || present.has(normalizeKey(stage.stageName))) return;
    byStage.push({
      ...getDefaultStageRow(stage.stageName),
      wip: stage.wip,
      lineWip: stage.lineWip,
      trcWip: stage.trcWip,
      doneCount: stage.doneCount,
      finishedGoods: stage.finishedGoods,
      upha: 0,
      achievedUph: 0,
    });
  });
  const stageOrder = new Map(flow.stages.map((stage, index) => [normalizeKey(stage.stageName), index]));

  return {
    ...base,
    totals: {
      ...(base.totals || {}),
      ...flow.totals,
    },
    byStage: sortStageRows(byStage, stageOrder),
    flow: {
      raw,
      stages: flow.stages,
      check: flow.check,
      diagnostics: raw.snapshot?.diagnostics || {},
    },
  };
};

// Dev-only data-integrity check: every stage's WIP + units past the last stage
// + rejected units must add up to the allocated kits. Logged once per distinct
// mismatch so the 30s recompute doesn't flood the console. Only meaningful for
// the plan-level allocation, so only the plan insights endpoint calls it (an
// operator seat's insights are computed against that seat's own allocation).
const flowBalanceWarnings = new Map();
const warnIfStageFlowUnbalanced = (planId, flow) => {
  if (process.env.NODE_ENV === "production") return;
  const check = flow?.check;
  const key = String(planId || "");
  if (!check || check.balanced !== false) {
    flowBalanceWarnings.delete(key);
    return;
  }
  const signature = `${check.accounted}/${check.allocatedKits}`;
  if (flowBalanceWarnings.get(key) === signature) return;
  flowBalanceWarnings.set(key, signature);
  console.assert(
    false,
    `[planInsights] stage WIP does not add up for plan ${key}: stages ${check.stageWipSum} + after last stage ${check.afterLastStage} + rejected ${check.rejected} = ${check.accounted}, allocated kits ${check.allocatedKits}`,
    flow?.diagnostics || {},
  );
};

const seedCommonStageRows = (commonStages = [], upsertStage) => {
  (Array.isArray(commonStages) ? commonStages : []).forEach((stage) => {
    const stageName = normalizeValue(stage?.stageName || stage?.name || stage?.stage);
    if (stageName) upsertStage(stageName);
  });
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
    // Phase 1 log-payload cleanup (2026-09-19): only status feeds the
    // $group below - drop everything else (including any terminalLogs
    // payload) before it.
    { $project: { status: 1 } },
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
  processStatus = "",
  // Callers also pass Process.issuedKits/consumedKits (Store's own figures).
  // Neither is read any more: stage WIP derives from `issuedKits` (the seat /
  // plan allocation) and the devices' own progress, not from Store counters.
}) => {
  if (!planId || !mongoose.Types.ObjectId.isValid(String(planId))) {
    return {
      generatedAt: new Date().toISOString(),
      totals: {
        tested: 0,
        pass: 0,
        ng: 0,
        wip: 0,
        wipLine: 0,
        wipTrc: 0,
        wipFirstStage: 0,
        wipAfterFirstStage: 0,
        deliveredUnits: 0,
        consumedKits: 0,
        trackedUnits: 0,
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

  const stageOrderMap = buildStageOrderMap({ processStages, commonStages });
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

  await forEachChunked(scopedLatestRecords, (record) => {
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
  await forEachChunked(dedupedRecords, (record) => {
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

  await forEachChunked(dedupedRecords, (record) => {
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
    }
    // WIP is not accumulated here: it comes from computeStageFlowSnapshot
    // below, which places each device exactly once over the whole plan history.
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
    // Phase 1 log-payload cleanup (2026-09-19): only deviceId/status/
    // assignedDeviceTo/createdAt feed $sort/$group below - drop everything
    // else (including any terminalLogs payload) before them. This is on the
    // hot WIP-insights path, polled every ~30s per operator.
    { $project: { deviceId: 1, status: 1, assignedDeviceTo: 1, createdAt: 1 } },
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

  // Devices that have no test record in this process yet: only their already
  // terminal states feed the tested/pass/ng counters here. Their WIP is NOT
  // counted from Device docs - see computeStageFlowSnapshot.
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
    }
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

  // Stage WIP: whole plan history over EVERY device of the process. Deliberately
  // not built from scopedLatestRecords / the date-scoped device snapshots above
  // - the Today / From-To filter only applies to pass, NG and UPH.
  const flowDevices = processId && mongoose.Types.ObjectId.isValid(String(processId))
    ? await deviceModel
      .find({ processID: new mongoose.Types.ObjectId(String(processId)) })
      .select("_id serialNo status currentStage flowVersion")
      .lean()
    : [];
  const flowSnapshot = computeStageFlowSnapshot({
    stageNames: buildFlowStageNames({ processStages, commonStages, aliasLookup: stageAliasLookup }),
    aliasLookup: stageAliasLookup,
    records: latestRecords,
    devices: flowDevices,
  });
  const flowKitConfirmed = isKitConfirmedProcessStatus(processStatus);
  // Make sure every stage that carries WIP has a row (the first stage always
  // does: it is the one derived from the kit allocation).
  finalizeStageFlow(flowSnapshot, { allocatedKits: issuedKits, kitConfirmed: flowKitConfirmed })
    .stages.forEach((stage, index) => {
      if (index === 0 || stage.wip > 0) upsertStage(stage.stageName);
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

  return applyStageFlowToInsights(
    {
      generatedAt: new Date().toISOString(),
      totals: {
        tested: uniquePlanTotals.tested,
        pass: uniquePlanTotals.pass,
        ng: uniquePlanTotals.ng,
        // totals.wip (in-process WIP), wipLine, wipTrc, consumedKits are set by
        // applyStageFlowToInsights. trackedUnits is what pass+ng+wip used to
        // add up to - kitsShortage is still measured against it.
        trackedUnits: uniquePlanTotals.pass + uniquePlanTotals.ng + uniquePlanTotals.wip,
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
      flow: { raw: { snapshot: flowSnapshot, kitConfirmed: flowKitConfirmed } },
      latestRecords: latestRecords || [],
    },
    { allocatedKits: issuedKits },
  );
};

// Every open operator seat polls computePlanInsights every ~10-30s. The heavy
// aggregation work above is identical for every operator on the same
// plan/process within a short window, so we collapse concurrent/near-concurrent
// calls into a single computation and only recompute the cheap per-operator
// fields (operatorToday, lineIssueKits, kitsShortage) on every call.
//
// This TTL must comfortably exceed the worst-case computation time, or it
// defeats its own purpose: the cache entry (holding the in-flight promise) is
// stored with expiresAt = now + TTL at the *start* of the computation, so if
// the computation itself outlives the TTL, every operator polling the same
// plan while it's still running sees an "expired" entry and kicks off their
// own redundant recompute instead of awaiting the one already in flight.
// Live data on the app's largest plans showed computePlanInsightsUncached
// taking 13-20s — well past the old 12s TTL — which was observed as repeated
// concurrent SLOW recomputes stacking up for the same planId. 30s gives
// headroom above that without staleness mattering much, since operator tabs
// already poll on a ~30s cycle of their own.
const SHARED_PLAN_INSIGHTS_CACHE_TTL_MS = 30000;
const sharedPlanInsightsCache = new Map();

const computePlanInsights = async (params) => {
  const { planId = "", processId = "", operatorId = "", issuedKits = 0 } = params || {};

  if (!planId || !mongoose.Types.ObjectId.isValid(String(planId))) {
    return computePlanInsightsUncached(params);
  }

  // issuedKits and processIssuedKits/processConsumedKits are deliberately left
  // out of this key. computePlanInsightsUncached doesn't read the process
  // counters (they incremented on nearly every device pass, so keying on them
  // used to make a busy plan generate a near-unique key on almost every call -
  // the cache never absorbed repeat calls, leaving the 5-11s computation
  // running on almost every request and pegging CPU), and the only thing that
  // depends on the allocation (the first stage's WIP) is re-derived per call
  // below. Anything else can lag reality by up to the TTL, which is fine:
  // operator tabs already poll on their own ~30s cycle.
  const cacheKey = [
    planId,
    processId,
    params.dateFrom || "",
    params.dateTo || "",
    params.processStatus || "",
  ].join("|");
  const now = Date.now();
  const cached = sharedPlanInsightsCache.get(cacheKey);

  let basePromise;
  if (cached && cached.expiresAt > now) {
    basePromise = cached.promise;
    cached.lastRequestedAt = now;
  } else {
    // Sweep expired entries opportunistically once the map gets large enough
    // that a full pass is worth it, same pattern already used (correctly) by
    // operatorTodayStatsCache below.
    if (sharedPlanInsightsCache.size > 200) {
      sharedPlanInsightsCache.forEach((entry, entryKey) => {
        if (entry.expiresAt <= now) sharedPlanInsightsCache.delete(entryKey);
      });
    }
    basePromise = computePlanInsightsUncached(params);
    basePromise.catch(() => sharedPlanInsightsCache.delete(cacheKey));
    sharedPlanInsightsCache.set(cacheKey, {
      expiresAt: now + SHARED_PLAN_INSIGHTS_CACHE_TTL_MS,
      promise: basePromise,
      params,
      lastRequestedAt: now,
    });
  }

  const base = await basePromise;
  const operatorToday = await getOperatorTodayStatsCached({ operatorId, planId, processId });

  // The cached base was built for whichever caller got there first (the plan
  // page passes the plan's total allocation, an operator seat passes its own).
  // The first stage's WIP is derived from the allocation, so re-derive the WIP
  // overlay for THIS caller; the heavy per-device counts stay cached.
  const withFlow = applyStageFlowToInsights(base, { allocatedKits: issuedKits });

  const totalsBase = withFlow.totals || {};
  const producedTotal = Number(
    totalsBase.trackedUnits ??
    Number(totalsBase.pass || 0) + Number(totalsBase.ng || 0) + Number(totalsBase.wip || 0),
  );
  const lineIssueKitsCount = Number(issuedKits) || producedTotal;
  const kitsShortageCount = Math.max(0, lineIssueKitsCount - producedTotal);

  return {
    ...withFlow,
    totals: {
      ...totalsBase,
      lineIssueKits: lineIssueKitsCount,
      kitsShortage: kitsShortageCount,
      operatorToday,
    },
  };
};

// Background refresh: without this, the FIRST request to land after a cache
// entry expires is the one that pays computePlanInsightsUncached's full
// 5-30s cost, and while it's running it competes for the same event loop as
// everything else (this is what was blocking deviceRecord/create). Sweeping
// active entries just before they expire and recomputing them ahead of time
// means real requests almost always just read an already-warm cache entry -
// nobody's request triggers the live computation anymore. Only plans with
// actual recent traffic are in the cache to begin with, so idle/abandoned
// plans are never refreshed - this can't grow into background work for
// plans nobody's looking at.
const BACKGROUND_REFRESH_LEAD_MS = 8000;
const BACKGROUND_REFRESH_SWEEP_MS = 5000;
// A plan stops being proactively refreshed once nobody's actually requested
// it for this long - otherwise every plan ever looked at would get refreshed
// forever, turning "keep active plans warm" into unbounded background work
// for plans everyone stopped viewing. 2x the TTL gives one full cache cycle
// of grace (a request right at the edge of expiry still gets a warm read)
// before a plan is treated as abandoned.
const BACKGROUND_REFRESH_IDLE_CUTOFF_MS = SHARED_PLAN_INSIGHTS_CACHE_TTL_MS * 2;

function refreshStalePlanInsightsEntries() {
  const now = Date.now();
  sharedPlanInsightsCache.forEach((entry, cacheKey) => {
    if (entry.refreshing) return;
    if (now - (entry.lastRequestedAt || 0) > BACKGROUND_REFRESH_IDLE_CUTOFF_MS) return;
    if (entry.expiresAt - now > BACKGROUND_REFRESH_LEAD_MS) return;
    entry.refreshing = true;
    const refreshedPromise = computePlanInsightsUncached(entry.params);
    refreshedPromise
      .then(() => {
        sharedPlanInsightsCache.set(cacheKey, {
          expiresAt: Date.now() + SHARED_PLAN_INSIGHTS_CACHE_TTL_MS,
          promise: refreshedPromise,
          params: entry.params,
          lastRequestedAt: entry.lastRequestedAt,
        });
      })
      .catch((err) => {
        // Leave the stale entry in place rather than delete it - a request
        // that arrives before it fully expires still gets a (slightly
        // stale) answer instead of triggering its own live computation.
        console.error("[PLAN-INSIGHTS-REFRESH] Background refresh failed:", err.message);
        entry.refreshing = false;
      });
  });
}

setInterval(refreshStalePlanInsightsEntries, BACKGROUND_REFRESH_SWEEP_MS);

const computeProcessInsights = async ({
  processId = "",
  processStages = [],
  commonStages = [],
  selectedProduct = "",
  quantity = 0,
  processStatus = "",
  // The process's own issued kits (Store): the capacity the first stage's WIP
  // is derived from. (processConsumedKits is still passed by callers but no
  // longer read - consumed kits are the devices that passed the first stage.)
  processIssuedKits = 0,
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
    // Phase 1 log-payload cleanup (2026-09-19): only deviceId/status/
    // assignedDeviceTo/createdAt feed $sort/$group below - drop everything
    // else (including any terminalLogs payload) before them. This is on the
    // hot WIP-insights path, polled every ~30s per operator.
    { $project: { deviceId: 1, status: 1, assignedDeviceTo: 1, createdAt: 1 } },
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
    }
    // WIP is not accumulated here: it comes from computeStageFlowSnapshot
    // below (the same model the plan insights use).
  });

  // 2. Devices that have no test record yet: only their already terminal
  // states feed the tested/pass/ng counters. Their WIP is NOT counted from
  // Device docs - see computeStageFlowSnapshot.
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
    }
  });

  // Totals: tested/pass/ng from the latest row per device-stage combo. totals.wip
  // is set below from the stage-flow model.
  const uniqueProcessTotals = {
    tested: dedupedRecords?.length || 0,
    pass: 0,
    ng: 0,
    wip: 0,
  };

  dedupedRecords.forEach((record) => {
    if (isPassStatus(record?.status)) uniqueProcessTotals.pass += 1;
    if (isNgStatus(record?.status)) uniqueProcessTotals.ng += 1;
  });

  mergeAliasedStageRows(byStageMap, stageAliasLookup);
  reconcileCommonStageMetrics({
    commonStages,
    devices: processFlowDevices,
    byStageMap,
    upsertStage,
  });

  // Stage WIP: same model as the plan insights (whole history, every device of
  // the process placed once, TRC with its source stage). There is no per-plan
  // allocation at process level, so the first stage is derived from the
  // process's own issued kits.
  const flowSnapshot = computeStageFlowSnapshot({
    stageNames: buildFlowStageNames({ processStages, commonStages, aliasLookup: stageAliasLookup }),
    aliasLookup: stageAliasLookup,
    records: latestRecords,
    devices: processFlowDevices,
  });
  const flowKitConfirmed = isKitConfirmedProcessStatus(processStatus);
  finalizeStageFlow(flowSnapshot, {
    allocatedKits: processIssuedKits,
    kitConfirmed: flowKitConfirmed,
  }).stages.forEach((stage, index) => {
    if (index === 0 || stage.wip > 0) upsertStage(stage.stageName);
  });

  const byStage = sortStageRows(Array.from(byStageMap.values()), stageOrderMap);
  const bySeatStage = sortSeatStageRows(Array.from(bySeatStageMap.values()), stageOrderMap);

  // Process level: there is no plan, and computeOperatorActivityTimestamps only
  // filters by process (planId is not used as a filter).
  const operatorActivityTimestamps = await computeOperatorActivityTimestamps({
    processId,
  });

  return applyStageFlowToInsights(
    {
      generatedAt: new Date().toISOString(),
      totals: uniqueProcessTotals,
      byStage,
      bySeatStage,
      operatorActivityTimestamps,
      flow: { raw: { snapshot: flowSnapshot, kitConfirmed: flowKitConfirmed } },
    },
    { allocatedKits: processIssuedKits },
  );
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

// ---------------------------------------------------------------------------
// Stage WIP popup: WHICH units make up a stage's WIP (READ-ONLY).
//
// Uses the very same placement logic as the insights (computeStageFlowSnapshot),
// so the list always matches the number on the tile. It stays cheap by fetching
// test records only for the few devices whose bucket depends on them (NG units
// waiting in TRC/QC need their failing stage; units with an unmappable
// currentStage), instead of aggregating the whole process history. IMEI / CCID
// are read at request time, so a download always has the current values.
// ---------------------------------------------------------------------------
const STAGE_WIP_LIST_LIMIT = 20000;
// One shared collator (natural order: SN9 before SN10): localeCompare with options
// builds a new one per comparison - ~10x slower on 20,000 serials.
const STAGE_WIP_SERIAL_COLLATOR = new Intl.Collator(undefined, { numeric: true });
const STAGE_WIP_ID_CHUNK = 1000;

const chunkList = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const computeStageWipDevices = async ({
  processId = "",
  processStages = [],
  commonStages = [],
  processStatus = "",
  allocatedKits = 0,
  stageName = "",
  // "stage" = one stage of the flow, "delivered" = units that passed the last stage
  bucket = "stage",
}) => {
  if (!processId || !mongoose.Types.ObjectId.isValid(String(processId))) return { found: false };
  const processObjectId = new mongoose.Types.ObjectId(String(processId));
  const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
  const aliasLookup = buildStageAliasLookup({ processStages, commonStages });
  const stageNames = buildFlowStageNames({ processStages, commonStages, aliasLookup });

  const flowDevices = await deviceModel
    .find({ processID: processObjectId })
    .select("_id serialNo status currentStage flowVersion")
    .lean();
  const base = { stageNames, aliasLookup, devices: flowDevices, collectDevices: true };

  // Pass 1 (no records) only tells which devices need their records.
  let snapshot = computeStageFlowSnapshot({ ...base, records: [] });
  const needRecordIds = snapshot.membership.needsRecords;
  if (needRecordIds.length > 0) {
    const records = [];
    for (const idChunk of chunkList(needRecordIds, STAGE_WIP_ID_CHUNK)) {
      const rows = await deviceTestRecordModel
        .find({ processId: processObjectId, deviceId: { $in: idChunk.map(toObjectId) } })
        .select("deviceId serialNo stageName status currentStage flowVersion createdAt")
        .sort({ createdAt: -1 })
        .lean();
      records.push(...rows);
    }
    snapshot = computeStageFlowSnapshot({ ...base, records });
  }
  const flow = finalizeStageFlow(snapshot, {
    allocatedKits,
    kitConfirmed: isKitConfirmedProcessStatus(processStatus),
  });

  let label = "";
  let stageIndex = -1;
  let lineIds = [];
  let trcEntries = [];
  let wip = 0;
  let lineWip = 0;
  let trcWip = 0;
  // Serials that exist at this stage but are not covered by the kit allocation.
  let notAllocated = 0;
  if (bucket === "delivered") {
    label = "Delivered";
    lineIds = snapshot.membership.afterLast;
    wip = Number(snapshot.afterLast || 0);
    lineWip = wip;
  } else {
    const canonical = resolveCanonicalStageName(stageName, aliasLookup);
    stageIndex = stageNames.findIndex((name) => normalizeKey(name) === normalizeKey(canonical));
    if (stageIndex < 0) return { found: false };
    label = stageNames[stageIndex];
    lineIds = snapshot.membership.line[stageIndex];
    trcEntries = snapshot.membership.trc[stageIndex];
    ({ wip, lineWip, trcWip } = flow.stages[stageIndex]);
    // The FIRST stage's WIP comes from the kit allocation (allocated - passed -
    // ...), not from how many serials exist: Serial Generator creates every
    // planned serial up front, so far more units than the kits issued to the line
    // can still be sitting at the first stage. The popup lists the units the
    // allocation covers - the oldest serials first (ObjectIds grow with creation
    // time), i.e. the ones that are tested next - so the list matches the tile.
    if (stageIndex === 0 && lineIds.length > lineWip) {
      notAllocated = lineIds.length - lineWip;
      lineIds = [...lineIds].sort().slice(0, lineWip);
    }
  }

  const trcInfo = new Map(trcEntries.map((entry) => [entry.id, entry]));
  const wantedIds = [...trcEntries.map((entry) => entry.id), ...lineIds];
  const truncated = wantedIds.length > STAGE_WIP_LIST_LIMIT;
  const listedIds = wantedIds.slice(0, STAGE_WIP_LIST_LIMIT);

  const details = new Map();
  for (const idChunk of chunkList(listedIds, 2000)) {
    const rows = await deviceModel
      .find({ _id: { $in: idChunk.map(toObjectId) } })
      .select("_id serialNo imeiNo imei ccid status currentStage cartonSerial modelName updatedAt")
      .lean();
    rows.forEach((row) => details.set(String(row._id), row));
  }

  const devices = listedIds.map((id) => {
    const device = details.get(id) || {};
    const trc = trcInfo.get(id);
    return {
      id,
      serialNo: normalizeValue(device.serialNo),
      imei: normalizeValue(device.imeiNo || device.imei),
      ccid: normalizeValue(device.ccid),
      cartonSerial: normalizeValue(device.cartonSerial),
      modelName: normalizeValue(device.modelName),
      status: normalizeValue(device.status),
      currentStage: normalizeValue(device.currentStage),
      updatedAt: device.updatedAt || null,
      wipType: bucket === "delivered" ? "delivered" : trc ? "trc" : "line",
      // NG units waiting in TRC (or QC) are shown with the stage they failed at.
      assignedTo: trc ? (normalizeKey(device.currentStage) === "qc" ? "QC" : "TRC") : "",
      failedAt: trc ? label : "",
      ngAt: trc && trc.ngTime ? new Date(trc.ngTime).toISOString() : null,
    };
  });
  devices.sort((left, right) => {
    if (left.wipType !== right.wipType) return left.wipType === "trc" ? -1 : 1;
    return STAGE_WIP_SERIAL_COLLATOR.compare(left.serialNo, right.serialNo);
  });

  const listedTrc = devices.filter((device) => device.wipType === "trc").length;
  return {
    found: true,
    stageName: label,
    stageIndex,
    bucket,
    wip,
    lineWip,
    trcWip,
    listed: devices.length,
    listedLine: devices.length - listedTrc,
    listedTrc,
    // The first stage is derived from the kit allocation: kits that are issued
    // but have no serial yet are WIP without a row to list.
    missingUnits: truncated ? 0 : Math.max(wip - devices.length, 0),
    notAllocated,
    truncated,
    devices,
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
  isKitConfirmedProcessStatus,
  getResolvedReturnStage,
  getRecordSeatKey,
  computePlanInsights,
  computeStageFlowSnapshot,
  computeStageWipDevices,
  finalizeStageFlow,
  buildFlowStageNames,
  buildStageAliasLookup,
  warnIfStageFlowUnbalanced,
  computeProcessInsights,
  computeOperatorActivityTimestamps,
};
