const mongoose = require("mongoose");
const moment = require("moment");
const assignedOperatorsToPlanModel = require("../models/assignOperatorToPlan");
const assignedJigToPlanModel = require("../models/assignJigToPlan");
const planningAndSchedulingModel = require("../models/planingAndSchedulingModel");
const processModel = require("../models/process");
const productModel = require("../models/Products");
const shiftModel = require("../models/shiftManagement");
const userModel = require("../models/User");
const deviceModel = require("../models/device");
const deviceTestRecordModel = require("../models/deviceTestModel");
const assignKitsToLineModel = require("../models/assignKitsToLine");
const OperatorWorkSession = require("../models/operatorWorkSession");
const AssignOperatorToPlan = require("../models/assignOperatorToPlan");
const {
  parseStickerScanTokens,
  findDevicesByScanTokensStrict,
  findDevicesByScanTokensBestEffort,
} = require("../services/deviceScanMatcher");
const { computePlanInsights, isResolvedStatus, toPlanningDateKey, PLANNING_TIMEZONE } = require("../services/planInsightsService");
const { cachedCompute } = require("../utils/ttlCache");

/** Sessions older than this limit are auto-expired on next device scan (mirrors operatorWorkController). */
const SESSION_MAX_HOURS_TASK = Number(process.env.SESSION_MAX_HOURS || 10);
const SESSION_MAX_MS_TASK = SESSION_MAX_HOURS_TASK * 60 * 60 * 1000;

/**
 * Auto-expire a stale operator session (>SESSION_MAX_HOURS_TASK old).
 * Returns the closed session document or null if no action was taken.
 */
async function autoExpireStaleSessionTask(session) {
  if (!session || session.status !== "active") return null;
  const startedAt = session.startedAt ? new Date(session.startedAt) : null;
  if (!startedAt) return null;
  const ageMs = Date.now() - startedAt.getTime();
  if (ageMs < SESSION_MAX_MS_TASK) return null;

  const now = new Date();
  if (Array.isArray(session.breaks) && session.breaks.length > 0) {
    const lastBreak = session.breaks[session.breaks.length - 1];
    if (lastBreak && !lastBreak.endedAt) lastBreak.endedAt = now;
  }
  session.status = "stopped";
  session.endedAt = now;
  session.stopReason = `auto_expired_${SESSION_MAX_HOURS_TASK}h`;
  session.updatedAt = now;
  await session.save();
  console.info(
    `[SESSION_EXPIRE_TASK] Session ${session._id} for operator ${session.operatorId} ` +
    `auto-expired after ${Math.round(ageMs / 3600000)}h on device scan.`
  );
  return session;
}
const {
  computeHourlyUpha,
  getCurrentShiftHourBoundsInTimezone,
  collectPassTimestampsInHour,
} = require("../services/hourlyUphaMetrics");
const momentTz = require("moment-timezone");

const normalizeValue = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeValue(value).toLowerCase().replace(/\s+/g, " ");

const sortSeatKeys = (seatKeys = []) =>
  [...seatKeys].sort((left, right) => {
    const [leftRow, leftSeat] = String(left || "").split("-").map((part) => Number(part));
    const [rightRow, rightSeat] = String(right || "").split("-").map((part) => Number(part));
    if ((leftRow || 0) !== (rightRow || 0)) return (leftRow || 0) - (rightRow || 0);
    return (leftSeat || 0) - (rightSeat || 0);
  });

const safeJsonParse = (raw, fallback = {}) => {
  if (!raw) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const normalizeStageKeyFlexible = (value) =>
  normalizeValue(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

const sortIndexedObjectKeys = (source = {}) =>
  Object.keys(source || {}).sort((left, right) => {
    const leftNum = Number(left);
    const rightNum = Number(right);
    const leftFinite = Number.isFinite(leftNum);
    const rightFinite = Number.isFinite(rightNum);
    if (leftFinite && rightFinite) return leftNum - rightNum;
    if (leftFinite) return -1;
    if (rightFinite) return 1;
    return String(left).localeCompare(String(right));
  });

const normalizeIndexedSlots = (value) => {
  const parsed = safeJsonParse(value, []);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    return sortIndexedObjectKeys(parsed).map((key) => parsed[key]);
  }
  return [];
};

const normalizeCustomOperatorSlot = (slot) => {
  if (Array.isArray(slot)) return slot.filter(Boolean);
  if (!slot) return [];

  if (typeof slot === "string") {
    const trimmed = slot.trim();
    if (!trimmed) return [];
    const parsed = safeJsonParse(trimmed, null);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    if (typeof parsed === "string" || typeof parsed === "number") return [parsed];
    if (parsed && typeof parsed === "object") return normalizeCustomOperatorSlot(parsed);
    return [trimmed];
  }

  if (typeof slot === "object") {
    if (Array.isArray(slot?.operators)) return slot.operators.filter(Boolean);
    if (slot?._id || slot?.id || slot?.operatorId || slot?.userId || slot?.name) {
      return [slot];
    }
  }

  return [];
};

const resolveOperatorIdentity = (operatorEntry) => {
  if (operatorEntry === null || operatorEntry === undefined) return "";
  if (typeof operatorEntry === "string" || typeof operatorEntry === "number") {
    return String(operatorEntry).trim();
  }
  if (typeof operatorEntry === "object") {
    return String(
      operatorEntry?._id ||
      operatorEntry?.userId ||
      operatorEntry?.operatorId ||
      operatorEntry?.id ||
      operatorEntry?.value ||
      "",
    ).trim();
  }
  return "";
};

const extractCustomStageName = (stageEntry) => {
  if (!stageEntry) return "";

  if (typeof stageEntry === "string") {
    const trimmed = stageEntry.trim();
    if (!trimmed) return "";
    const parsed = safeJsonParse(trimmed, null);
    if (parsed && typeof parsed === "object") {
      return extractCustomStageName(parsed);
    }
    return normalizeValue(trimmed);
  }

  if (typeof stageEntry === "object") {
    return normalizeValue(
      stageEntry?.stageName ||
      stageEntry?.name ||
      stageEntry?.stage ||
      stageEntry?.label ||
      stageEntry?.value,
    );
  }

  return normalizeValue(stageEntry);
};

const findStageByNameFlexible = (stages = [], stageName = "") => {
  const normalizedTarget = normalizeStageKeyFlexible(stageName);
  if (!normalizedTarget) return null;
  return (
    (Array.isArray(stages) ? stages : []).find(
      (stage) =>
        normalizeStageKeyFlexible(stage?.stageName || stage?.name || stage?.stage) ===
        normalizedTarget,
    ) || null
  );
};

const buildStageAliases = (stageName = "") => {
  const baseStageName = normalizeValue(stageName);
  if (!baseStageName) return [];

  const aliases = new Set([baseStageName]);
  const normalized = normalizeStageKeyFlexible(baseStageName);

  if (normalized.includes("fg") && normalized.includes("store")) {
    ["FG_TO_STORE", "FG to Store", "FG TO STORE", "fg_to_store", "fg to store"].forEach((alias) =>
      aliases.add(alias),
    );
  }

  if (normalized.includes("keep") && normalized.includes("store")) {
    ["KEEP_IN_STORE", "Keep In Store", "KEPT_IN_STORE", "STOCKED", "stocked"].forEach((alias) =>
      aliases.add(alias),
    );
  }

  if (normalized.includes("packaging")) {
    ["Packaging", "PACKAGING", "packaging", "Packaging Stage"].forEach((alias) =>
      aliases.add(alias),
    );
  }

  return Array.from(aliases).map((value) => normalizeValue(value)).filter(Boolean);
};

const resolveStageAwareCurrentStage = ({ currentAssignedStageName = "", firstStageName = "" }) => {
  const normalizedCurrent = normalizeValue(currentAssignedStageName);
  if (!normalizedCurrent) return undefined;

  const aliases = buildStageAliases(normalizedCurrent);
  const normalizedFirst = normalizeStageKeyFlexible(firstStageName);
  const isFirstStage =
    !!normalizedFirst &&
    normalizeStageKeyFlexible(normalizedCurrent) === normalizedFirst;

  if (isFirstStage) {
    return aliases.length > 0 ? { $in: Array.from(new Set([...aliases, "", null])) } : { $in: ["", null] };
  }

  if (aliases.length > 1) return { $in: aliases };
  return aliases[0] || normalizedCurrent;
};

const normalizeRoleToken = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const parseManagedByRoles = (managedBy) => {
  if (!managedBy) return [];

  let source = managedBy;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) || typeof parsed === "string") {
        source = parsed;
      } else {
        source = trimmed;
      }
    } catch {
      source = trimmed;
    }
  }

  const rawValues = Array.isArray(source)
    ? source
    : String(source || "").split(/[,|;&/]+/);

  return Array.from(
    new Set(rawValues.map((value) => normalizeRoleToken(value)).filter(Boolean)),
  );
};

const isFgToStoreStageName = (stageName = "") => {
  const normalized = normalizeStageKeyFlexible(stageName);
  if (!normalized) return false;
  if (normalized === "fg to store") return true;
  if (normalized === "keep in store") return true;
  return normalized.includes("fg") && normalized.includes("store");
};

const isPdiStageName = (stageName = "") => {
  const normalized = normalizeStageKeyFlexible(stageName);
  if (!normalized) return false;
  return (
    normalized === "pdi" ||
    normalized.includes("pdi") ||
    normalized.includes("quality control") ||
    normalized.includes("quality check") ||
    normalized === "qc"
  );
};

const collectOperatorRoleTokens = (operatorProfile = null) => {
  const rawValues = [
    operatorProfile?.userType,
    operatorProfile?.role,
    operatorProfile?.department,
    operatorProfile?.designation,
    operatorProfile?.name,
  ];
  return new Set(rawValues.map((value) => normalizeRoleToken(value)).filter(Boolean));
};

const resolveCommonStageByRoleFallback = ({
  processDoc = null,
  productDoc = null,
  operatorProfile = null,
} = {}) => {
  const stagePool = [
    ...(Array.isArray(processDoc?.commonStages) ? processDoc.commonStages : []),
    ...(Array.isArray(productDoc?.commonStages) ? productDoc.commonStages : []),
  ];
  if (stagePool.length === 0) return null;

  const uniqueStages = [];
  const seenStageNames = new Set();
  stagePool.forEach((stage) => {
    const stageName = normalizeValue(stage?.stageName || stage?.name || stage?.stage);
    if (!stageName) return;
    const key = normalizeStageKeyFlexible(stageName);
    if (seenStageNames.has(key)) return;
    seenStageNames.add(key);
    uniqueStages.push(stage);
  });
  if (uniqueStages.length === 0) return null;

  const operatorRoleTokens = collectOperatorRoleTokens(operatorProfile);
  const hasStoreRole = Array.from(operatorRoleTokens).some((token) => token.includes("store"));
  const hasQcRole = Array.from(operatorRoleTokens).some(
    (token) => token === "qc" || token.includes("quality"),
  );

  const managedByMatch = uniqueStages.find((stage) => {
    const roles = parseManagedByRoles(stage?.managedBy);
    if (!roles.length || operatorRoleTokens.size === 0) return false;
    return roles.some((role) => operatorRoleTokens.has(role));
  });
  if (managedByMatch) return managedByMatch;

  if (hasStoreRole) {
    const fgStage = uniqueStages.find((stage) =>
      isFgToStoreStageName(stage?.stageName || stage?.name || stage?.stage),
    );
    if (fgStage) return fgStage;
  }

  if (hasQcRole) {
    const pdiStage = uniqueStages.find((stage) =>
      isPdiStageName(stage?.stageName || stage?.name || stage?.stage),
    );
    if (pdiStage) return pdiStage;
  }

  return uniqueStages[0] || null;
};

const normalizeAssignedStagesPayload = (assignedStages = {}, processStages = []) => {
  const stageOrderMap = new Map();
  (Array.isArray(processStages) ? processStages : []).forEach((stage, index) => {
    const stageName = normalizeKey(stage?.stageName || stage?.name);
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

const getSeatStageEntry = (assignedStages = {}, seatKey) => {
  const seatStages = Array.isArray(assignedStages?.[seatKey])
    ? assignedStages[seatKey]
    : assignedStages?.[seatKey]
      ? [assignedStages[seatKey]]
      : [];
  return seatStages.find((stage) => !stage?.reserved) || seatStages[0] || null;
};

const getParallelSeatEntries = ({ assignedStages = {}, stageName = "", lineIndex = -1, parallelGroupKey = "" }) => {
  const targetStageName = normalizeKey(stageName);
  const targetGroupKey = normalizeValue(parallelGroupKey);
  const normalizedEntries = sortSeatKeys(Object.keys(assignedStages || {}))
    .map((seatKey) => ({ seatKey, stage: getSeatStageEntry(assignedStages, seatKey) }))
    .filter(({ stage }) => !!stage && !stage?.reserved);

  const sameLane = normalizedEntries.filter(({ stage }) => {
    if (targetGroupKey) {
      return normalizeValue(stage?.parallelGroupKey) === targetGroupKey;
    }
    return (
      stage?.lineIndex === lineIndex &&
      normalizeKey(stage?.stageName || stage?.name || stage?.stage) === targetStageName
    );
  });

  if (sameLane.length > 0) return sameLane;
  return normalizedEntries.filter(({ stage }) => normalizeKey(stage?.stageName || stage?.name || stage?.stage) === targetStageName);
};

const getLatestStageRecordBySerial = ({ records = [], serialNo = "", stageName = "" }) => {
  const normalizedSerial = normalizeKey(serialNo);
  const normalizedStageName = normalizeKey(stageName);
  if (!normalizedSerial) return null;

  let matchedRecord = null;
  (Array.isArray(records) ? records : []).forEach((record) => {
    const recordSerial = normalizeKey(
      record?.serialNo || record?.serial || record?.device?.serialNo || record?.deviceInfo?.serialNo,
    );
    if (recordSerial !== normalizedSerial) return;

    const recordStage = normalizeKey(
      record?.stageName || record?.currentStage || record?.currentLogicalStage || record?.nextLogicalStage,
    );
    if (normalizedStageName && recordStage !== normalizedStageName) return;

    const recordTime = new Date(record?.createdAt || 0).getTime();
    const matchedTime = new Date(matchedRecord?.createdAt || 0).getTime();
    if (!matchedRecord || recordTime >= matchedTime) {
      matchedRecord = record;
    }
  });

  return matchedRecord;
};

const getClaimSeatKey = (record = {}) => normalizeValue(record?.assignedSeatKey || record?.seatNumber || "");
const getRecordSeatKey = (record = {}) =>
  normalizeValue(record?.seatNumber || record?.currentSeatKey || record?.assignedSeatKey);

const resolveSeatIssuedKits = (kitAssignment, seatKey = "") => {
  if (!kitAssignment || !seatKey) return 0;
  const [row, seat] = String(seatKey).split("-").map((part) => normalizeValue(part));
  const seatDetails = Array.isArray(kitAssignment.seatDetails) ? kitAssignment.seatDetails : [];

  const exactMatch = seatDetails.find(
    (entry) =>
      normalizeValue(entry?.rowNumber) === row &&
      normalizeValue(entry?.seatNumber) === seat,
  );
  if (exactMatch) return Number(exactMatch.issuedKits || 0);

  const seatOnlyMatches = seatDetails.filter(
    (entry) => normalizeValue(entry?.seatNumber) === seat,
  );
  if (seatOnlyMatches.length === 1) {
    return Number(seatOnlyMatches[0]?.issuedKits || 0);
  }

  return 0;
};

const isRevertedEquivalentStatus = (status = "") => {
  const normalizedStatus = normalizeKey(status);
  return normalizedStatus === "reverted" || normalizedStatus === "removed";
};
const isTerminalStageStatus = (status = "") => {
  const normalizedStatus = normalizeKey(status);
  if (isResolvedStatus(normalizedStatus)) return false;
  return normalizedStatus === "pass" || normalizedStatus === "completed" || normalizedStatus === "ng" || normalizedStatus === "fail";
};

const buildDeviceFlowVersionMap = (devices = []) => {
  const map = new Map();
  (Array.isArray(devices) ? devices : []).forEach((device) => {
    const flowVersion = Number(device?.flowVersion || 1);
    const deviceId = String(device?._id || "").trim();
    const serialNo = String(device?.serialNo || "").trim();
    if (deviceId) map.set(deviceId, flowVersion);
    if (serialNo) map.set(serialNo, flowVersion);
  });
  return map;
};

const buildActiveWipDeviceKeys = (devices = [], targetStageNames = new Set()) => {
  const keys = new Set();
  (Array.isArray(devices) ? devices : []).forEach((device) => {
    const stageName = normalizeKey(device?.currentStage || "");
    const targetStages = [...targetStageNames].map((name) => normalizeKey(name));
    const isAtTargetStage =
      targetStages.length === 0 ||
      targetStages.some(
        (targetStage) => targetStage && (stageName === targetStage || stageName.includes(targetStage)),
      );
    const deviceStatus = normalizeKey(device?.status || "");
    const isActiveWip = deviceStatus !== "ng" && deviceStatus !== "fail";
    if (!isAtTargetStage || !isActiveWip) return;

    const deviceId = String(device?._id || "").trim();
    const serialNo = String(device?.serialNo || "").trim();
    if (deviceId) keys.add(deviceId);
    if (serialNo) keys.add(serialNo);
  });
  return keys;
};

/**
 * Shared eligibility gate for a seat+stage record: correct stage, correct
 * seat, not a device currently mid-retry at that stage, and not a stale
 * record from a flow version the device has since moved past. Used by both
 * countSeatStageStats (pass/ng/wip totals) and the hourly-UPHA pass-timestamp
 * collector below, so the two never disagree on which records are "this
 * seat's this stage's" records.
 */
const recordPassesSeatStageGates = (
  record,
  { targetStageNames, normalizedSeatKey, deviceFlowVersions, activeWipDeviceKeys },
) => {
  const stageName = normalizeValue(record?.stageName);
  if (!targetStageNames.has(stageName)) return false;
  if (normalizedSeatKey) {
    const recordSeatKey = getRecordSeatKey(record);
    if (!recordSeatKey || recordSeatKey !== normalizedSeatKey) return false;
  }

  const recordDeviceKey = String(record?.deviceId || record?.serialNo || "").trim();
  if (recordDeviceKey && activeWipDeviceKeys.has(recordDeviceKey)) {
    return false;
  }
  const currentFlowVersion = recordDeviceKey
    ? deviceFlowVersions.get(recordDeviceKey)
    : undefined;
  const recordFlowVersion = Number(record?.flowVersion || 1);
  if (currentFlowVersion !== undefined && recordFlowVersion !== currentFlowVersion) {
    return false;
  }

  return true;
};

const countSeatStageStats = ({
  records = [],
  targetStageNames,
  seatKey = "",
  deviceFlowVersions = new Map(),
  activeWipDeviceKeys = new Set(),
}) => {
  const normalizedSeatKey = normalizeValue(seatKey);
  let tested = 0;
  let pass = 0;
  let ng = 0;
  let wip = 0;

  (Array.isArray(records) ? records : []).forEach((record) => {
    if (
      !recordPassesSeatStageGates(record, {
        targetStageNames,
        normalizedSeatKey,
        deviceFlowVersions,
        activeWipDeviceKeys,
      })
    ) {
      return;
    }

    const status = normalizeKey(record?.status);
    if (isResolvedStatus(status)) {
      wip += 1;
      return;
    }
    if (!isTerminalStageStatus(status)) return;

    tested += 1;
    if (status === "pass" || status === "completed") pass += 1;
    if (status === "ng" || status === "fail") ng += 1;
  });

  return { tested, pass, ng, wip };
};

/**
 * Pass timestamps for one seat+stage inside an hour window, for the hourly
 * UPHA calculator (devices produced, average cycle time, etc. — see
 * services/hourlyUphaMetrics.js). Reuses the same gating as
 * countSeatStageStats so "devices produced this hour" is drawn from exactly
 * the same record set as the shift-level pass/ng totals.
 */
const collectSeatPassTimestampsInHour = ({
  records = [],
  targetStageNames,
  seatKey = "",
  deviceFlowVersions = new Map(),
  activeWipDeviceKeys = new Set(),
  hourBounds,
}) => {
  const normalizedSeatKey = normalizeValue(seatKey);
  return collectPassTimestampsInHour(records, hourBounds, (record) =>
    recordPassesSeatStageGates(record, {
      targetStageNames,
      normalizedSeatKey,
      deviceFlowVersions,
      activeWipDeviceKeys,
    }),
  );
};

const setNoStoreHeaders = (res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
};

const isDeviceVisibleToSeat = ({ device = {}, latestRecords = [], operatorStageName = "", processId = "", processStages = [], normalizedAssignedStages = {}, seatKey = "" }) => {
  const trimmedStageName = normalizeValue(operatorStageName);
  const normalizedTrimmedStageName = normalizeKey(trimmedStageName);
  const firstStageName = normalizeValue(processStages?.[0]?.stageName || processStages?.[0]?.name || "");
  const normalizedFirstStageName = normalizeKey(firstStageName);
  const currentSeatStage = getSeatStageEntry(normalizedAssignedStages, seatKey);
  const parallelSeats = getParallelSeatEntries({
    assignedStages: normalizedAssignedStages,
    stageName: trimmedStageName,
    lineIndex: currentSeatStage?.lineIndex,
    parallelGroupKey: currentSeatStage?.parallelGroupKey,
  });

  const deviceProcessId = String(device?.processID || device?.processId || "");
  const deviceStatus = normalizeKey(device?.status || "");
  const deviceCurrentStage = normalizeValue(device?.currentStage || "");
  const normalizedDeviceCurrentStage = normalizeKey(deviceCurrentStage);

  const stageMatches =
    normalizedDeviceCurrentStage === normalizedTrimmedStageName ||
    (!normalizedDeviceCurrentStage && normalizedTrimmedStageName && normalizedTrimmedStageName === normalizedFirstStageName);

  if (
    !(
      deviceProcessId === String(processId) &&
      deviceStatus !== "ng" &&
      deviceStatus !== "fail" &&
      stageMatches
    )
  ) {
    return false;
  }

  if (parallelSeats.length <= 1) {
    return true;
  }

  const deviceSerial = normalizeValue(device?.serialNo || device?.serial_no || "");
  const currentStageRecord = getLatestStageRecordBySerial({
    records: latestRecords,
    serialNo: deviceSerial,
    stageName: trimmedStageName,
  });

  if (!currentStageRecord) {
    return true;
  }

  if (isRevertedEquivalentStatus(currentStageRecord?.status)) {
    return true;
  }

  if (isTerminalStageStatus(currentStageRecord?.status)) {
    // A terminal record from an earlier pass should not hide a device that is
    // currently routed back into the same stage (for example after TRC resolve/rework).
    return normalizedDeviceCurrentStage === normalizedTrimmedStageName;
  }

  const claimedSeatKey = getClaimSeatKey(currentStageRecord);
  if (!claimedSeatKey) {
    return true;
  }

  return String(claimedSeatKey) === String(seatKey);
};

const filterDevicesForSeat = ({ devices = [], latestRecords = [], operatorStageName = "", processId = "", processStages = [], normalizedAssignedStages = {}, seatKey = "" }) => {
  return (Array.isArray(devices) ? devices : []).filter((device) =>
    isDeviceVisibleToSeat({
      device,
      latestRecords,
      operatorStageName,
      processId,
      processStages,
      normalizedAssignedStages,
      seatKey,
    }),
  );
};

const findDevicesByScanTokens = (devices = [], scanTokens = []) => {
  const strictMatches = findDevicesByScanTokensStrict(devices, scanTokens);
  if (strictMatches.length > 0) return strictMatches;
  return findDevicesByScanTokensBestEffort(devices, scanTokens);
};

const DEVICE_LOOKUP_SELECT_FIELDS =
  "_id serialNo imeiNo customFields modelName status currentStage processID productType flowVersion flowStartedAt";

const isLikelyImeiToken = (token = "") => /^\d{15}$/.test(String(token || "").trim());
const isLikelyCcidToken = (token = "") =>
  /^\d{20,30}[a-z0-9]*$/i.test(String(token || "").trim());

const buildTokenVariants = (token = "") => {
  const normalized = normalizeValue(token);
  if (!normalized) return [];

  const variants = new Set([normalized]);
  if (!/^\d+$/.test(normalized)) {
    variants.add(normalized.toLowerCase());
    variants.add(normalized.toUpperCase());
  }
  return Array.from(variants);
};

const resolveLookupFieldAliases = (token = "") => {
  if (isLikelyImeiToken(token)) {
    return [
      "imeiNo",
      "imei",
      "imei_no",
      "IMEI",
      "imei1",
      "imei2",
      "IMEI1",
      "IMEI2",
      "imeiNo1",
      "imeiNo2",
      "imei_1",
      "imei_2",
      "imei1No",
      "imei2No",
    ];
  }
  if (isLikelyCcidToken(token)) {
    return ["ccid", "CCID", "iccid", "ICCID", "ccidNo", "CCID1", "CCID2", "iccid1", "iccid2"];
  }
  return [
    "serialNo",
    "serial_no",
    "serial",
    "serialNumber",
    "serialnumber",
    "SN",
    "sn",
    "SNO",
    "sno",
    "imeiNo",
    "imei",
    "imei_no",
    "IMEI",
    "ccid",
    "CCID",
    "iccid",
    "ICCID",
    "ccidNo",
  ];
};

const resolveRootIndexedAliases = (token = "") => {
  if (isLikelyImeiToken(token)) return ["imeiNo"];
  if (isLikelyCcidToken(token)) return ["ccid"];
  return ["serialNo", "imeiNo", "ccid"];
};

const buildRootIndexedLookupOrClauses = (scanTokens = []) => {
  const clauses = [];
  const seen = new Set();

  (Array.isArray(scanTokens) ? scanTokens : []).forEach((scanToken) => {
    const variants = buildTokenVariants(scanToken);
    if (!variants.length) return;

    resolveRootIndexedAliases(scanToken).forEach((field) => {
      const key = `${field}::${variants.join("|")}`;
      if (seen.has(key)) return;
      seen.add(key);

      clauses.push({
        [field]: variants.length === 1 ? variants[0] : { $in: variants },
      });
    });
  });

  return clauses;
};

const buildProductTypeMatch = (selectedProduct) => {
  if (!selectedProduct) return null;
  const normalized = String(selectedProduct).trim();
  if (!normalized) return null;
  if (mongoose.Types.ObjectId.isValid(normalized)) {
    const objectId = new mongoose.Types.ObjectId(normalized);
    return { $in: [objectId, normalized] };
  }
  return normalized;
};

const buildProcessDeviceScopeFilter = ({
  processId,
  selectedProduct,
  stageAwareCurrentStage,
} = {}) => {
  if (!processId) return null;

  const filter = {
    processID: processId,
    status: { $nin: ["NG"] },
  };

  const productTypeMatch = buildProductTypeMatch(selectedProduct);
  if (productTypeMatch) {
    filter.productType = productTypeMatch;
  }

  if (stageAwareCurrentStage !== undefined) {
    filter.currentStage = stageAwareCurrentStage;
  }

  return filter;
};

const buildIdentityLookupOrClauses = ({
  scanTokens = [],
  currentStageName = "",
}) => {
  const pathPrefixes = new Set([""]);
  pathPrefixes.add("customFields");

  const normalizedCurrentStage = normalizeValue(currentStageName);
  if (normalizedCurrentStage) {
    pathPrefixes.add(`customFields.${normalizedCurrentStage}`);
  }

  const clauses = [];
  const seen = new Set();

  (Array.isArray(scanTokens) ? scanTokens : []).forEach((scanToken) => {
    const variants = buildTokenVariants(scanToken);
    if (!variants.length) return;
    const fieldAliases = resolveLookupFieldAliases(scanToken);

    fieldAliases.forEach((fieldAlias) => {
      pathPrefixes.forEach((prefix) => {
        const path = prefix ? `${prefix}.${fieldAlias}` : fieldAlias;
        const key = `${path}::${variants.join("|")}`;
        if (seen.has(key)) return;
        seen.add(key);

        clauses.push({
          [path]: variants.length === 1 ? variants[0] : { $in: variants },
        });
      });
    });
  });

  return clauses;
};

const resolveMatchFromCandidates = (candidateDevices = [], scanTokens = []) => {
  const matches = findDevicesByScanTokens(candidateDevices, scanTokens);
  if (matches.length > 1) return { ambiguous: true, match: null };
  if (matches.length === 1) return { ambiguous: false, match: matches[0] };
  return { ambiguous: false, match: null };
};

const ensureOperatorWorkSessionForBootstrap = async ({ operatorId, processId, planId }) => {
  try {
    const operatorObjId = new mongoose.Types.ObjectId(String(operatorId));
    const processObjId = new mongoose.Types.ObjectId(String(processId));
    const planObjId =
      planId && mongoose.Types.ObjectId.isValid(String(planId))
        ? new mongoose.Types.ObjectId(String(planId))
        : null;

    const existing = await OperatorWorkSession.findOne({
      operatorId: operatorObjId,
      processId: processObjId,
      status: "active",
    });
    if (existing) {
      // Auto-expire sessions that started more than SESSION_MAX_HOURS_TASK ago.
      // When an operator scans their first device of a new day the stale overnight
      // session is closed here and a fresh one is created below, so the device
      // test record will be stamped with today's login time.
      const expired = await autoExpireStaleSessionTask(existing);
      if (!expired) return existing.toObject ? existing.toObject() : existing;
      // Expired — fall through to create a new session.
    }

    const assignment = await AssignOperatorToPlan.findOne({
      userId: operatorObjId,
      processId: processObjId,
    }).lean();

    const session = new OperatorWorkSession({
      operatorId: operatorObjId,
      processId: processObjId,
      planId: planObjId,
      taskUrl: "",
      scheduledShift: assignment?.ProcessShiftMappings || {},
      startedAt: new Date(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await session.save();
    return session;
  } catch (error) {
    console.error("Failed to ensure operator work session on bootstrap:", error?.message || error);
    return null;
  }
};

const buildOperatorTaskDeviceContext = async ({ planId, operatorId }) => {
  const plan = await planningAndSchedulingModel
    .findById(planId)
    .select(
      "_id selectedProcess assignedOperators assignedCustomStagesOp assignedStages assignedCustomStages",
    )
    .lean();
  if (!plan) {
    const error = new Error("Planning not found");
    error.status = 404;
    throw error;
  }

  const assignedTaskDetails =
    (await assignedOperatorsToPlanModel
      .findOne({ userId: operatorId, processId: plan?.selectedProcess })
      .sort({ updatedAt: -1 })
      .select("_id userId processId stageType")
      .lean()) ||
    (await assignedOperatorsToPlanModel
      .findOne({ userId: operatorId })
      .sort({ updatedAt: -1 })
      .select("_id userId processId stageType")
      .lean());

  const process = plan?.selectedProcess
    ? await processModel.findById(plan.selectedProcess).select("_id stages commonStages selectedProduct").lean()
    : null;

  const isCommon = assignedTaskDetails?.stageType === "common";

  // --- Common-stage path (assignedCustomStagesOp is a parallel array, not a seat-key map) ---
  if (isCommon) {
    const operatorProfile = await userModel
      .findById(operatorId)
      .select("_id userType role department designation name")
      .lean()
      .catch(() => null);
    const customStagesArr = normalizeIndexedSlots(plan?.assignedCustomStages);
    const customOpsArr = normalizeIndexedSlots(plan?.assignedCustomStagesOp);

    let commonStageName = "";
    for (let i = 0; i < customStagesArr.length; i++) {
      const slotOperators = normalizeCustomOperatorSlot(customOpsArr[i]);
      const found = slotOperators.some((op) =>
        resolveOperatorIdentity(op) === String(operatorId),
      );
      if (found) {
        commonStageName = extractCustomStageName(customStagesArr[i]);
        break;
      }
    }

    const processCommonStages = Array.isArray(process?.commonStages) ? process.commonStages : [];
    let assignUserStage = commonStageName
      ? findStageByNameFlexible(processCommonStages, commonStageName)
      : null;
    if (!assignUserStage) {
      assignUserStage = resolveCommonStageByRoleFallback({
        processDoc: process,
        productDoc: null,
        operatorProfile,
      });
      commonStageName = normalizeValue(
        assignUserStage?.stageName || assignUserStage?.name || assignUserStage?.stage,
      );
    }

    const currentAssignedStageName = commonStageName;
    const normalizedAssignedStages = {};
    const firstStageName = normalizeValue(process?.stages?.[0]?.stageName || "");

    return {
      plan,
      process,
      selectedProcess: process?._id || plan?.selectedProcess || null,
      assignedTaskDetails,
      normalizedAssignedStages,
      assignUserStage,
      currentAssignedStageName,
      stageAwareCurrentStage: resolveStageAwareCurrentStage({
        currentAssignedStageName,
        firstStageName,
      }),
      seatKey: "",
      operatorSeatInfo: null,
    };
  }

  // --- Regular (non-common) stage path: assignedOperators is a seat-key keyed object ---
  const assignedOperatorPayload = safeJsonParse(plan?.assignedOperators, {});
  const assignedStagePayload = safeJsonParse(plan?.assignedStages, {});
  const normalizedAssignedStages = normalizeAssignedStagesPayload(
    assignedStagePayload,
    process?.stages || [],
    process?.commonStages || [],
  );

  const seatKey =
    sortSeatKeys(Object.keys(assignedOperatorPayload || {})).find((key) => {
      const operators = Array.isArray(assignedOperatorPayload?.[key])
        ? assignedOperatorPayload[key]
        : assignedOperatorPayload?.[key]
          ? [assignedOperatorPayload[key]]
          : [];
      return operators.some((operator) => {
        const candidate = resolveOperatorIdentity(operator);
        return candidate === String(operatorId);
      });
    }) || "";

  const assignUserStage = seatKey ? normalizedAssignedStages?.[seatKey] || null : null;
  const currentAssignedStage = Array.isArray(assignUserStage)
    ? assignUserStage[0]
    : assignUserStage;
  const currentAssignedStageName = normalizeValue(
    currentAssignedStage?.name ||
    currentAssignedStage?.stageName ||
    currentAssignedStage?.stage,
  );

  const firstStageName = normalizeValue(process?.stages?.[0]?.stageName || "");
  const stageAwareCurrentStage = resolveStageAwareCurrentStage({
    currentAssignedStageName,
    firstStageName,
  });

  return {
    plan,
    process,
    selectedProcess: process?._id || plan?.selectedProcess || null,
    assignedTaskDetails,
    normalizedAssignedStages,
    assignUserStage,
    currentAssignedStageName,
    stageAwareCurrentStage,
    seatKey,
    operatorSeatInfo: seatKey
      ? {
        rowNumber: String(seatKey).split("-")[0] || "",
        seatNumber: String(seatKey).split("-")[1] || "",
        seatKey,
      }
      : null,
  };
};

const getLatestSeatRecordForDeviceStage = async ({
  planId,
  processId,
  stageName,
  device,
}) => {
  const base = {};
  if (mongoose.Types.ObjectId.isValid(String(planId || ""))) {
    base.planId = new mongoose.Types.ObjectId(planId);
  }
  if (processId && mongoose.Types.ObjectId.isValid(String(processId))) {
    base.processId = new mongoose.Types.ObjectId(processId);
  }
  if (stageName) {
    base.stageName = String(stageName).trim();
  }

  const projection = {
    serialNo: 1,
    stageName: 1,
    status: 1,
    seatNumber: 1,
    assignedSeatKey: 1,
    createdAt: 1,
  };

  if (device?._id && mongoose.Types.ObjectId.isValid(String(device._id))) {
    const byDeviceId = await deviceTestRecordModel
      .findOne(
        { ...base, deviceId: new mongoose.Types.ObjectId(String(device._id)) },
        projection,
        { sort: { createdAt: -1 } },
      )
      .lean();
    if (byDeviceId) return byDeviceId;
  }

  const serial = normalizeValue(device?.serialNo || device?.serial_no || "");
  if (!serial) return null;

  return deviceTestRecordModel
    .findOne(
      { ...base, serialNo: serial },
      projection,
      { sort: { createdAt: -1 } },
    )
    .lean();
};

const getLatestDeviceTests = async (planId, processId, stageNames = []) => {
  const match = { planId: new mongoose.Types.ObjectId(planId) };
  if (processId && mongoose.Types.ObjectId.isValid(processId)) {
    match.processId = new mongoose.Types.ObjectId(processId);
  }

  const normalizedStageNames = [...new Set(
    (Array.isArray(stageNames) ? stageNames : [stageNames])
      .map((value) => normalizeValue(value))
      .filter(Boolean),
  )];
  if (normalizedStageNames.length === 1) {
    match.stageName = normalizedStageNames[0];
  } else if (normalizedStageNames.length > 1) {
    match.stageName = { $in: normalizedStageNames };
  }

  const pipeline = [
    { $match: match },
    { $sort: { createdAt: -1 } },
    { $limit: 5000 },
    {
      $project: {
        _id: 1,
        planId: 1,
        processId: 1,
        operatorId: 1,
        deviceId: 1,
        serialNo: 1,
        searchType: 1,
        seatNumber: 1,
        stageName: 1,
        status: 1,
        flowVersion: 1,
        assignedSeatKey: "$seatNumber",
        nextLogicalStage: 1,
        currentStage: 1,
        timeConsumed: 1,
        totalBreakTime: 1,
        startTime: 1,
        endTime: 1,
        createdAt: 1,
        updatedAt: 1,
        deviceKey: {
          $ifNull: [
            { $toString: "$deviceId" },
            { $ifNull: ["$serialNo", { $toString: "$_id" }] },
          ],
        },
        normalizedStageName: {
          $trim: {
            input: { $ifNull: ["$stageName", ""] },
          },
        },
      },
    },
    {
      $group: {
        _id: {
          planId: "$planId",
          stageName: "$normalizedStageName",
          deviceKey: "$deviceKey",
        },
        latest: { $first: "$$ROOT" },
      },
    },
    { $replaceRoot: { newRoot: "$latest" } },
    { $project: { normalizedStageName: 0, deviceKey: 0 } },
  ];

  // This is the same shape of query as processController.js's
  // getLatestDeviceTestsByPlanId (already cached there) — called here on
  // EVERY /operator-task/refresh poll (the busiest endpoint in the app), so
  // it gets the same short-lived cache to collapse repeat/concurrent calls.
  const cacheKey = `operatorTaskLatestTests:${planId}:${processId || "all"}:${normalizedStageNames.join(",")}`;
  return cachedCompute(cacheKey, 10000, () => deviceTestRecordModel.aggregate(pipeline));
};

const getTodayRange = () => {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const getOperatorStats = async (operatorId, includeHistory = false) => {
  if (!operatorId || !mongoose.Types.ObjectId.isValid(operatorId)) {
    return {
      operatorStats: { totalAttempts: 0, totalCompleted: 0, totalNg: 0 },
      operatorHistory: includeHistory ? [] : undefined,
    };
  }

  const { start, end } = getTodayRange();
  const operatorObjectId = new mongoose.Types.ObjectId(operatorId);
  const [statsRows, operatorHistory] = await Promise.all([
    deviceTestRecordModel.aggregate([
      {
        $match: {
          operatorId: operatorObjectId,
          createdAt: { $gte: start, $lte: end },
        },
      },
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
    ]),
    includeHistory
      ? deviceTestRecordModel
        .find(
          {
            operatorId: operatorObjectId,
            createdAt: { $gte: start, $lte: end },
          },
          { serialNo: 1, stageName: 1, status: 1, assignedDeviceTo: 1, timeConsumed: 1, createdAt: 1 },
          { sort: { createdAt: -1 } },
        )
        .lean()
      : Promise.resolve(undefined),
  ]);

  const stats = statsRows?.[0] || {};
  return {
    operatorStats: {
      totalAttempts: Number(stats.totalAttempts || 0),
      totalCompleted: Number(stats.totalCompleted || 0),
      totalNg: Number(stats.totalNg || 0),
    },
    operatorHistory,
  };
};

const buildOperatorTaskSummary = async ({ planId, operatorId, includeHistory = false }) => {
  const plan = await planningAndSchedulingModel.findById(planId).lean();
  if (!plan) {
    const error = new Error("Planning not found");
    error.status = 404;
    throw error;
  }

  if (
    mongoose.Types.ObjectId.isValid(String(operatorId || "")) &&
    mongoose.Types.ObjectId.isValid(String(plan?.selectedProcess || ""))
  ) {
    await ensureOperatorWorkSessionForBootstrap({
      operatorId,
      processId: plan.selectedProcess,
      planId,
    });
  }

  const assignedTaskDetails =
    (await assignedOperatorsToPlanModel
      .findOne({ userId: operatorId, processId: plan?.selectedProcess })
      .sort({ updatedAt: -1 })
      .lean()) ||
    (await assignedOperatorsToPlanModel
      .findOne({ userId: operatorId })
      .sort({ updatedAt: -1 })
      .lean());

  const process = plan?.selectedProcess
    ? await processModel.findById(plan.selectedProcess).lean()
    : null;
  const [product, shift] = await Promise.all([
    process?.selectedProduct ? productModel.findById(process.selectedProduct).lean() : Promise.resolve(null),
    plan?.selectedShift ? shiftModel.findById(plan.selectedShift).lean() : Promise.resolve(null),
  ]);

  const isCommon = assignedTaskDetails?.stageType === "common";

  let seatKey = "";
  let assignUserStage = null;
  let normalizedAssignedStages = {};
  let currentAssignedStageName = "";

  if (isCommon) {
    const operatorProfile = await userModel
      .findById(operatorId)
      .select("_id userType role department designation name")
      .lean()
      .catch(() => null);
    // Common stages: assignedCustomStages is an array of stage name strings,
    // assignedCustomStagesOp is a parallel array of operator-arrays.
    const customStagesArr = normalizeIndexedSlots(plan?.assignedCustomStages);
    const customOpsArr = normalizeIndexedSlots(plan?.assignedCustomStagesOp);

    let matchedStageName = "";
    for (let i = 0; i < customStagesArr.length; i++) {
      const slotOperators = normalizeCustomOperatorSlot(customOpsArr[i]);
      const found = slotOperators.some(
        (op) => resolveOperatorIdentity(op) === String(operatorId),
      );
      if (found) {
        matchedStageName = extractCustomStageName(customStagesArr[i]);
        break;
      }
    }

    currentAssignedStageName = matchedStageName;
    const processCommonStages = Array.isArray(process?.commonStages) ? process.commonStages : [];
    assignUserStage = matchedStageName
      ? findStageByNameFlexible(processCommonStages, matchedStageName)
      : null;
    if (!assignUserStage) {
      assignUserStage = resolveCommonStageByRoleFallback({
        processDoc: process,
        productDoc: product,
        operatorProfile,
      });
      currentAssignedStageName = normalizeValue(
        assignUserStage?.stageName || assignUserStage?.name || assignUserStage?.stage,
      );
    }

  } else {
    // Regular stages: assignedOperators is a seat-key keyed object.
    const assignedOperatorPayload = safeJsonParse(plan?.assignedOperators, {});
    const assignedStagePayload = safeJsonParse(plan?.assignedStages, {});
    normalizedAssignedStages = normalizeAssignedStagesPayload(
      assignedStagePayload,
      process?.stages || [],
      process?.commonStages || [],
    );

    seatKey =
      sortSeatKeys(Object.keys(assignedOperatorPayload || {})).find((key) => {
        const operators = Array.isArray(assignedOperatorPayload?.[key])
          ? assignedOperatorPayload[key]
          : assignedOperatorPayload?.[key]
            ? [assignedOperatorPayload[key]]
            : [];
        return operators.some((operator) => {
          const candidate = resolveOperatorIdentity(operator);
          return candidate === String(operatorId);
        });
      }) || "";

    const seatStage = seatKey ? normalizedAssignedStages?.[seatKey] || null : null;
    const currentStageObj = Array.isArray(seatStage) ? seatStage[0] : seatStage;
    currentAssignedStageName = normalizeValue(
      currentStageObj?.name || currentStageObj?.stageName || currentStageObj?.stage,
    );
    assignUserStage = seatStage;
  }

  const allProcessStages = [
    ...(Array.isArray(process?.stages) ? process.stages : []),
    ...(Array.isArray(process?.commonStages) ? process.commonStages : []),
  ];
  const processAssignUserStage = findStageByNameFlexible(allProcessStages, currentAssignedStageName);


  const targetStageNames = new Set(
    [
      ...(Array.isArray(assignUserStage) ? assignUserStage : assignUserStage ? [assignUserStage] : []),
      currentAssignedStageName ? { stageName: currentAssignedStageName } : null,
    ]
      .filter(Boolean)
      .map((stage) => normalizeValue(stage?.name || stage?.stageName || stage?.stage))
      .filter(Boolean),
  );
  const stageNames = Array.from(targetStageNames);
  const firstStageName = normalizeValue(process?.stages?.[0]?.stageName || "");
  const stageAwareCurrentStage = resolveStageAwareCurrentStage({
    currentAssignedStageName,
    firstStageName,
  });

  const planObjectId = mongoose.Types.ObjectId.isValid(String(planId))
    ? new mongoose.Types.ObjectId(String(planId))
    : planId;
  const processObjectId = process?._id;

  const [latestRecords, rawDevices, allProcessDevices, kitAssignment, operatorSummary] = await Promise.all([
    process?._id && stageNames.length > 0
      ? getLatestDeviceTests(planId, process._id, stageNames)
      : Promise.resolve([]),
    process?._id
      ? deviceModel
        .find({
          processID: process._id,
          status: { $nin: ["NG"] },
          ...(buildProductTypeMatch(process?.selectedProduct)
            ? { productType: buildProductTypeMatch(process?.selectedProduct) }
            : {}),
          ...(stageAwareCurrentStage !== undefined ? { currentStage: stageAwareCurrentStage } : {}),
        })
        .select("_id serialNo imeiNo customFields modelName status currentStage processID productType flowVersion flowStartedAt")
        .lean()
      : Promise.resolve([]),
    process?._id
      ? deviceModel
        .find({ processID: process._id })
        .select("_id serialNo flowVersion")
        .lean()
      : Promise.resolve([]),
    processObjectId
      ? assignKitsToLineModel
        .findOne({ planId: planObjectId, processId: processObjectId })
        .lean()
        .catch(() => null)
      : Promise.resolve(null),
    getOperatorStats(operatorId, includeHistory),
  ]);

  const mergedStagesForSeatFilter = [
    ...(process?.stages || []),
    ...(process?.commonStages || []),
  ];

  let seatIssuedKits = resolveSeatIssuedKits(kitAssignment, seatKey);
  if (seatIssuedKits <= 0 && kitAssignment && Number(kitAssignment.issuedKits) > 0) {
    const seatDetails = Array.isArray(kitAssignment.seatDetails) ? kitAssignment.seatDetails : [];
    if (seatDetails.length === 0) {
      seatIssuedKits = Number(kitAssignment.issuedKits);
    }
  }

  const canonicalInsights = await computePlanInsights({
    planId,
    processId: process?._id || "",
    operatorId,
    assignedStages: normalizedAssignedStages,
    processStages: process?.stages || [],
    commonStages: process?.commonStages || [],
    selectedProduct: process?.selectedProduct || "",
    quantity: process?.quantity || 0,
    shift,
    issuedKits: seatIssuedKits,
  });

  const deviceQueue = seatKey && currentAssignedStageName && process
    ? filterDevicesForSeat({
      devices: rawDevices,
      latestRecords,
      operatorStageName: currentAssignedStageName,
      processId: process._id,
      processStages: mergedStagesForSeatFilter,
      normalizedAssignedStages,
      seatKey,
    })
    : [];

  const deviceFlowVersions = buildDeviceFlowVersionMap(allProcessDevices);
  const activeWipDeviceKeys = buildActiveWipDeviceKeys(allProcessDevices, targetStageNames);
  const seatScopedStats = countSeatStageStats({
    records: latestRecords,
    targetStageNames,
    seatKey,
    deviceFlowVersions,
    activeWipDeviceKeys,
  });
  let seatScopedTested = seatScopedStats.tested;
  let seatScopedPass = seatScopedStats.pass;
  let seatScopedNg = seatScopedStats.ng;
  const seatScopedResolvedWip = seatScopedStats.wip;

  const quantityCap = Number.parseInt(process?.quantity, 10) || 0;
  if (quantityCap > 0 && seatScopedPass + seatScopedNg > quantityCap) {
    const cappedPass = Math.min(seatScopedPass, quantityCap);
    const remaining = Math.max(quantityCap - cappedPass, 0);
    const cappedNg = Math.min(seatScopedNg, remaining);
    seatScopedPass = cappedPass;
    seatScopedNg = cappedNg;
    seatScopedTested = Math.min(seatScopedTested, quantityCap);
  }

  // The operator page shows the CURRENT DAY's seat summary (plant timezone),
  // not the seat's lifetime totals. The all-time numbers above are still used
  // for the WIP-kits math, which must subtract everything completed so far.
  const todayDateKey = toPlanningDateKey(new Date());
  const seatScopedTodayStats = countSeatStageStats({
    records: (Array.isArray(latestRecords) ? latestRecords : []).filter(
      (record) => record?.createdAt && toPlanningDateKey(record.createdAt) === todayDateKey,
    ),
    targetStageNames,
    seatKey,
    deviceFlowVersions,
    activeWipDeviceKeys,
  });

  // Hourly UPHA: "Achieved UPH" on the operator page is the devices produced
  // in the CURRENT hour bucket, aligned to the shift's own start/end time
  // (plant timezone) rather than a wall-clock hour — see
  // services/hourlyUphaMetrics.js for the full formula set and why shift
  // alignment matters (overnight shifts, breaks, off-shift periods).
  const seatStageForTarget = Array.isArray(assignUserStage) ? assignUserStage[0] : assignUserStage;
  const targetUphaForSeat = Number(seatStageForTarget?.upha || 0);
  const currentHourBounds = getCurrentShiftHourBoundsInTimezone(momentTz, PLANNING_TIMEZONE, shift, new Date());
  let currentHourUpha;
  if (!currentHourBounds) {
    // Outside the shift's active window (before/after shift, or on a break) —
    // there is no current hour to report against.
    currentHourUpha = {
      hourLabel: "Off shift",
      ...computeHourlyUpha([], targetUphaForSeat, 1),
    };
  } else {
    const currentHourPassTimestamps = collectSeatPassTimestampsInHour({
      records: latestRecords,
      targetStageNames,
      seatKey,
      deviceFlowVersions,
      activeWipDeviceKeys,
      hourBounds: currentHourBounds,
    });
    currentHourUpha = {
      hourLabel: `${momentTz.tz(currentHourBounds.start, PLANNING_TIMEZONE).format("HH:mm")} - ${momentTz
        .tz(currentHourBounds.end, PLANNING_TIMEZONE)
        .format("HH:mm")}`,
      ...computeHourlyUpha(currentHourPassTimestamps, targetUphaForSeat, 1),
    };
  }

  const seatStageEntries = Array.isArray(assignUserStage)
    ? assignUserStage
    : assignUserStage
      ? [assignUserStage]
      : [];

  const seatStageInsights = (canonicalInsights?.bySeatStage || []).filter(
    (row) =>
      normalizeValue(row?.seatKey) === normalizeValue(seatKey) &&
      targetStageNames.has(normalizeValue(row?.stageName)),
  );
  const insightSeatWip = seatStageInsights.reduce(
    (sum, row) => sum + Number(row?.wip || 0),
    0,
  );

  const isFirstStage = !isCommon && normalizeValue(currentAssignedStageName) === firstStageName;

  const stageInsight = (canonicalInsights?.byStage || []).find(
    (row) => targetStageNames.has(normalizeValue(row?.stageName))
  );
  const insightStageWip = stageInsight ? Number(stageInsight.wip || 0) : 0;

  const lineIssueKitsCount = isFirstStage && seatIssuedKits > 0 ? seatIssuedKits : 0;
  const wipKitsCount =
    lineIssueKitsCount > 0 && !(insightSeatWip > 0 || insightStageWip > 0)
      ? Math.max(0, lineIssueKitsCount - seatScopedPass - seatScopedNg)
      : Math.max(Number(deviceQueue.length || 0), insightSeatWip, insightStageWip, seatScopedResolvedWip);
  const kitsShortageCount =
    lineIssueKitsCount > 0
      ? Math.max(0, lineIssueKitsCount - seatScopedPass - seatScopedNg - wipKitsCount)
      : 0;

  const operatorScope = {
    wip: wipKitsCount,
    lineIssueKits: lineIssueKitsCount,
    kitsShortage: kitsShortageCount,
    pass: seatScopedTodayStats.pass,
    ng: seatScopedTodayStats.ng,
    tested: seatScopedTodayStats.tested,
    currentHourUpha,
  };

  const { operatorStats, operatorHistory } = operatorSummary;
  const operatorToday = canonicalInsights?.totals?.operatorToday || operatorStats;

  const currentStatus = plan?.processStatus || plan?.status;
  const downTime = typeof plan?.downTime === "string" ? safeJsonParse(plan.downTime, {}) : plan?.downTime || {};
  const downTimeEnd = downTime?.to ? new Date(downTime.to).getTime() : null;
  const downTimeEnabled =
    currentStatus === "down_time_hold" &&
    (downTimeEnd == null || Number.isNaN(downTimeEnd) || downTimeEnd > Date.now());

  return {
    plan,
    assignedTaskDetails: assignedTaskDetails
      ? { ...assignedTaskDetails, stageName: currentAssignedStageName }
      : null,
    operatorSeatInfo: seatKey
      ? {
        rowNumber: String(seatKey).split("-")[0] || "",
        seatNumber: String(seatKey).split("-")[1] || "",
        seatKey,
      }
      : null,
    assignUserStage,
    processAssignUserStage,
    process,
    product,
    shift,
    selectedProcess: process?._id || plan?.selectedProcess || null,
    processStagesName: (process?.stages || []).map((stage) => stage?.stageName).filter(Boolean),
    compactQueue: deviceQueue,
    insights: {
      operatorScope,
    },
    counters: {
      wipKits: wipKitsCount,
      lineIssueKits: lineIssueKitsCount,
      kitsShortage: kitsShortageCount,
      // Today-scoped seat summary — drives the Devices card and Achieved UPH.
      overallTotalCompleted: seatScopedTodayStats.pass,
      overallTotalNg: seatScopedTodayStats.ng,
      overallTotalAttempts: seatScopedTodayStats.tested,
      ...operatorStats,
    },
    downTime: {
      enabled: downTimeEnabled,
      value: downTime,
    },
    overtimeSummary: plan?.overtimeSummary || {},
    latestRecords: includeHistory ? latestRecords : undefined,
    operatorHistory: includeHistory ? operatorHistory : undefined,
  };
};

module.exports = {
  create: async (req, res) => {
    try {
      const data = req?.body;
      let seatsDetails = JSON.parse(data?.seatDetails);
      let ProcessShiftMappings = JSON.parse(data?.ProcessShiftMappings);
      let newassignOp;
      const data1 = {
        processId: data.processId,
        userId: data.userId,
        roomName: data.roomName,
        seatDetails: seatsDetails,
        stageType: data.stageType,
        ProcessShiftMappings,
        status: data.status,
        startDate: moment(data.startDate, "DD/MM/YY HH:mm:ss").toDate(),
      };
      const checkEntryExist = await assignedOperatorsToPlanModel.findOne({
        processId: data.processId,
        userId: data.userId,
      });
      if (!checkEntryExist) {
        const assignedOperatorsToPlan = new assignedOperatorsToPlanModel(data1);
        newassignOp = await assignedOperatorsToPlan.save();
      } else {
        newassignOp = await assignedOperatorsToPlanModel.findByIdAndUpdate(
          checkEntryExist._id,
          data1,
          { new: true, runValidators: true },
        );
      }
      return res.status(200).json({
        status: 200,
        message: "Operator Assigned Successfully!!",
        newassignOp,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getOperatorTaskByUserID: async (req, res) => {
    try {
      const userId = req.params.id;
      const task = await assignedOperatorsToPlanModel.findOne({ userId }).lean();
      return res.status(200).json({ status: 200, task });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getTaskByUserID: async (req, res) => {
    try {
      const userId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(String(userId || ""))) {
        return res.status(400).json({ status: 400, message: "Invalid user id." });
      }

      const task = await assignedOperatorsToPlanModel.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(userId) } },
        { $lookup: { from: "processes", localField: "processId", foreignField: "_id", as: "processDetails" } },
        { $unwind: "$processDetails" },
        { $match: { "processDetails.status": { $ne: "completed" } } },
        {
          $lookup: {
            from: "planingandschedulings",
            let: { mappedProcessId: "$processId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: [{ $toString: "$selectedProcess" }, { $toString: "$$mappedProcessId" }],
                  },
                },
              },
              { $sort: { updatedAt: -1, createdAt: -1 } },
              { $limit: 1 },
            ],
            as: "planDetails",
          },
        },
        { $unwind: { path: "$planDetails", preserveNullAndEmptyArrays: true } },
        { $lookup: { from: "assignkitstolines", localField: "processId", foreignField: "processId", as: "assignKitsToLine" } },
        { $unwind: { path: "$assignKitsToLine", preserveNullAndEmptyArrays: true } },
        { $lookup: { from: "roomplans", localField: "roomName", foreignField: "_id", as: "roomDetails" } },
        { $unwind: { path: "$roomDetails", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            userId: 1,
            planId: "$planDetails._id",
            processId: "$processDetails._id",
            seatDetails: 1,
            ProcessShiftMappings: 1,
            roomName: 1,
            "roomDetails.floorName": 1,
            processName: "$processDetails.name",
            taskStartDate: { $ifNull: ["$planDetails.startDate", "$startDate"] },
            "planDetails.assignedStages": 1,
            "planDetails.startDate": { $ifNull: ["$planDetails.startDate", "$startDate"] },
            "planDetails.estimatedEndDate": { $ifNull: ["$planDetails.estimatedEndDate", "$estimatedEndDate"] },
            "planDetails.roomName": 1,
            "planDetails.seatDetails": 1,
            status: "$processDetails.status",
            kitRecievedConfirmationId: "$assignKitsToLine._id",
            kitRecievedSeatDetails: "$assignKitsToLine.seatDetails",
            kitRecievedConfirmationStatus: "$assignKitsToLine.status",
            issuedKitsStatus: "$assignKitsToLine.issuedKitsStatus",
            assignedKitsToOperator: "$assignKitsToLine.issuedKits",
            requiredKits: "$processDetails.issuedKits",
          },
        },
        { $sort: { _id: -1 } },
      ]);

      if (!task.length) {
        return res.status(200).json({ status: 200, message: "No tasks found for the given user and date." });
      }
      return res.status(200).json({
        status: 200,
        message: "Task Retrieved Successfully!!",
        task,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getOperatorTaskBootstrap: async (req, res) => {
    try {
      const { planId, operatorId } = req.params;
      const payload = await buildOperatorTaskSummary({ planId, operatorId });
      setNoStoreHeaders(res);
      return res.status(200).json({ status: 200, message: "Operator task bootstrap fetched", data: payload });
    } catch (error) {
      return res.status(error.status || 500).json({ status: error.status || 500, error: error.message });
    }
  },
  getOperatorTaskRefresh: async (req, res) => {
    try {
      const { planId, operatorId } = req.params;
      const payload = await buildOperatorTaskSummary({ planId, operatorId });
      setNoStoreHeaders(res);
      return res.status(200).json({ status: 200, message: "Operator task refresh fetched", data: payload });
    } catch (error) {
      return res.status(error.status || 500).json({ status: error.status || 500, error: error.message });
    }
  },
  getOperatorTaskDevice: async (req, res) => {
    try {
      const { planId, operatorId } = req.params;
      const { deviceId, serialNo, scanInput } = req.query || {};
      const context = await buildOperatorTaskDeviceContext({ planId, operatorId });
      const processId = context?.process?._id || context?.selectedProcess;

      let device = null;
      let matchMeta = null;
      const scanTokens = scanInput ? parseStickerScanTokens(scanInput) : [];
      const ambiguousSearchResponse = {
        status: 409,
        message: "Multiple devices matched the scanned sticker values. Please scan a more specific sticker.",
        data: {
          matchedTokens: scanTokens,
          matchMode: scanTokens.length > 1 ? "multi" : "single",
        },
      };

      if (deviceId && mongoose.Types.ObjectId.isValid(deviceId)) {
        device = await deviceModel.findById(deviceId).lean();
      } else if (scanTokens.length > 0) {
        const stageScopedFilter = buildProcessDeviceScopeFilter({
          processId,
          selectedProduct: context?.process?.selectedProduct,
          stageAwareCurrentStage: context?.stageAwareCurrentStage,
        });

        const processScopedFilter = buildProcessDeviceScopeFilter({
          processId,
          selectedProduct: context?.process?.selectedProduct,
        });

        const rootIndexedClauses = buildRootIndexedLookupOrClauses(scanTokens);
        const directLookupClauses = buildIdentityLookupOrClauses({
          scanTokens,
          currentStageName: context?.currentAssignedStageName || "",
        });

        const applyMatchResult = (candidateDevices = []) => {
          const { ambiguous, match } = resolveMatchFromCandidates(
            candidateDevices,
            scanTokens,
          );
          if (ambiguous) return { ambiguous: true };
          if (match) {
            device = match.device;
            matchMeta = match;
          }
          return { ambiguous: false };
        };

        if (stageScopedFilter && rootIndexedClauses.length > 0) {
          const stageRootCandidates = await deviceModel
            .find({ ...stageScopedFilter, $or: rootIndexedClauses })
            .select(DEVICE_LOOKUP_SELECT_FIELDS)
            .limit(250)
            .lean();
          const stageRootResult = applyMatchResult(stageRootCandidates);
          if (stageRootResult.ambiguous) {
            return res.status(409).json(ambiguousSearchResponse);
          }
        }

        if (!device && processScopedFilter && rootIndexedClauses.length > 0) {
          const processRootCandidates = await deviceModel
            .find({ ...processScopedFilter, $or: rootIndexedClauses })
            .select(DEVICE_LOOKUP_SELECT_FIELDS)
            .limit(250)
            .lean();
          const processRootResult = applyMatchResult(processRootCandidates);
          if (processRootResult.ambiguous) {
            return res.status(409).json(ambiguousSearchResponse);
          }
        }

        if (!device && stageScopedFilter && directLookupClauses.length > 0) {
          const stageDirectCandidates = await deviceModel
            .find({ ...stageScopedFilter, $or: directLookupClauses })
            .select(DEVICE_LOOKUP_SELECT_FIELDS)
            .limit(100)
            .lean();
          const stageDirectResult = applyMatchResult(stageDirectCandidates);
          if (stageDirectResult.ambiguous) {
            return res.status(409).json(ambiguousSearchResponse);
          }
        }

        if (!device && processScopedFilter && directLookupClauses.length > 0) {
          const processDirectCandidates = await deviceModel
            .find({ ...processScopedFilter, $or: directLookupClauses })
            .select(DEVICE_LOOKUP_SELECT_FIELDS)
            .limit(100)
            .lean();
          const processDirectResult = applyMatchResult(processDirectCandidates);
          if (processDirectResult.ambiguous) {
            return res.status(409).json(ambiguousSearchResponse);
          }
        }

        // Fallback: scan customFields and non-indexed identity paths in-memory.
        if (!device && processScopedFilter) {
          const broadCandidates = await deviceModel
            .find(processScopedFilter)
            .select(DEVICE_LOOKUP_SELECT_FIELDS)
            .limit(500)
            .lean();
          const broadResult = applyMatchResult(broadCandidates);
          if (broadResult.ambiguous) {
            return res.status(409).json(ambiguousSearchResponse);
          }
        }

        // Last resort: drop productType filter (searchByJigFields does not use it).
        if (!device && processId && scanTokens.length > 0) {
          const processOnlyFilter = buildProcessDeviceScopeFilter({ processId });
          if (processOnlyFilter) {
            const processOnlyCandidates = await deviceModel
              .find(processOnlyFilter)
              .select(DEVICE_LOOKUP_SELECT_FIELDS)
              .limit(500)
              .lean();
            const processOnlyResult = applyMatchResult(processOnlyCandidates);
            if (processOnlyResult.ambiguous) {
              return res.status(409).json(ambiguousSearchResponse);
            }
          }
        }
      } else if (serialNo) {
        const trimmedSerial = String(serialNo).trim();
        const serialVariants = buildTokenVariants(trimmedSerial);
        const query =
          serialVariants.length > 1
            ? { serialNo: { $in: serialVariants } }
            : { serialNo: trimmedSerial };
        if (processId) query.processID = processId;
        device = await deviceModel.findOne(query).select(DEVICE_LOOKUP_SELECT_FIELDS).lean();
      }

      if (!device?._id) {
        return res.status(404).json({
          status: 404,
          message: scanTokens.length > 0
            ? "No device matched the scanned sticker values."
            : "Device not found",
        });
      }

      const mergedStagesForOperatorContext = [
        ...(context?.process?.stages || []),
        ...(context?.process?.commonStages || []),
      ];
      const firstMergedStageLabel = normalizeValue(
        mergedStagesForOperatorContext?.[0]?.stageName ||
        mergedStagesForOperatorContext?.[0]?.name ||
        "",
      );
      const normOperatorStage = normalizeKey(context?.currentAssignedStageName || "");
      const normDeviceStage = normalizeKey(device?.currentStage || "");
      const normFirstStage = normalizeKey(firstMergedStageLabel);

      if (context?.currentAssignedStageName && context?.seatKey && processId) {
        const stageAlignedAtSeat =
          normDeviceStage === normOperatorStage ||
          (!normDeviceStage && normOperatorStage && normOperatorStage === normFirstStage);
        if (!stageAlignedAtSeat) {
          const readableDev = normalizeValue(device?.currentStage || "") || "unknown routing";
          const readableOp = normalizeValue(context.currentAssignedStageName || "");
          return res.status(409).json({
            status: 409,
            message: `This device is assigned to "${readableDev}" but this station is "${readableOp}". Open this device at the correct stage, or fix reassignment so currentStage matches your station (TRC resolve FormData must include currentStage).`,
            data: {
              deviceCurrentStage: device.currentStage || "",
              operatorStage: readableOp,
            },
          });
        }
      }

      const latestSeatRecord =
        context?.currentAssignedStageName && context?.seatKey && processId
          ? await getLatestSeatRecordForDeviceStage({
            planId,
            processId,
            stageName: context.currentAssignedStageName,
            device,
          }).catch(() => null)
          : null;
      const latestRecords = latestSeatRecord ? [latestSeatRecord] : [];

      const isVisibleToSeat = context?.currentAssignedStageName && context?.seatKey && processId
        ? isDeviceVisibleToSeat({
          device,
          latestRecords,
          operatorStageName: context.currentAssignedStageName,
          processId,
          processStages: mergedStagesForOperatorContext,
          normalizedAssignedStages: context?.normalizedAssignedStages || {},
          seatKey: context.seatKey,
        })
        : true;

      if (!isVisibleToSeat) {
        const currentStageRecord = getLatestStageRecordBySerial({
          records: latestRecords,
          serialNo: device?.serialNo || serialNo,
          stageName: context?.currentAssignedStageName,
        });
        const claimedSeatKey = getClaimSeatKey(currentStageRecord);
        if (
          claimedSeatKey &&
          claimedSeatKey !== context?.seatKey &&
          !isTerminalStageStatus(currentStageRecord?.status)
        ) {
          return res.status(409).json({
            status: 409,
            message: "Device is already in progress on seat " + claimedSeatKey + ".",
          });
        }
        // return res.status(404).json({ status: 404, message: "Device is not available for this seat" });
      }

      const history = await deviceTestRecordModel
        .find(
          { deviceId: device._id },
          {
            serialNo: 1,
            stageName: 1,
            status: 1,
            assignedDeviceTo: 1,
            ngDescription: 1,
            logs: 1,
            flowVersion: 1,
            flowBoundary: 1,
            flowType: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          { sort: { createdAt: -1 }, limit: 120 },
        )
        .lean();
      return res.status(200).json({
        status: 200,
        message: "Operator task device fetched",
        data: {
          device,
          history,
          process: context?.process,
          assignUserStage: context?.assignUserStage,
          operatorSeatInfo: context?.operatorSeatInfo,
          matchedTokens: matchMeta?.matchedTokens,
          matchedFields: matchMeta?.matchedFields,
          matchMode: matchMeta?.matchMode,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json({ status: error.status || 500, error: error.message });
    }
  },
  createJigAssignedToPlan: async (req, res) => {
    try {
      const data = req?.body;
      let newassignJig;
      let seatsDetails = data?.seatDetails ? JSON.parse(data.seatDetails) : [];
      let ProcessShiftMappings = data?.ProcessShiftMappings ? JSON.parse(data.ProcessShiftMappings) : [];
      if (!data.processId || !data.jigId || !data.roomName || !data.startDate) {
        return res.status(400).json({ status: 400, message: "Missing required fields" });
      }
      const data1 = {
        processId: data.processId,
        jigId: data.jigId,
        roomName: data.roomName,
        seatDetails: seatsDetails,
        ProcessShiftMappings,
        status: data.status || "pending",
        startDate: moment(data.startDate, "YY/MM/DD HH:mm:ss").toDate(),
      };
      let jigData = await assignedJigToPlanModel.findOne({ jigId: data.jigId });
      if (jigData && Object.keys(jigData).length > 0) {
        newassignJig = await assignedJigToPlanModel.findByIdAndUpdate(
          jigData._id,
          { status: data.status },
          { new: true, runValidators: true },
        );
      } else {
        const assignedJigToPlan = new assignedJigToPlanModel(data1);
        newassignJig = await assignedJigToPlan.save();
      }

      return res.status(200).json({
        status: 200,
        message: "Jig Created Successfully!!",
        newassignJig,
      });
    } catch (error) {
      console.error("Error:", error.message);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
