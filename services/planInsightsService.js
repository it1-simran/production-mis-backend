const mongoose = require("mongoose");
const moment = require("moment");
const deviceModel = require("../models/device");
const deviceTestRecordModel = require("../models/deviceTestModel");

const normalizeValue = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeValue(value).toLowerCase().replace(/\s+/g, " ");

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

const buildLatestRecordPipeline = (match = {}) => [
  { $match: match },
  { $sort: { createdAt: -1 } },
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
      createdAt: 1,
      updatedAt: 1,
    },
  },
];

const getOperatorTodayStats = async ({ operatorId = "", planId = "", processId = "" }) => {
  if (!operatorId || !mongoose.Types.ObjectId.isValid(String(operatorId))) {
    return { totalAttempts: 0, totalCompleted: 0, totalNg: 0 };
  }
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
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
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const match = {
    planId: new mongoose.Types.ObjectId(String(planId)),
    createdAt: { $gte: start, $lte: end },
  };
  if (processId && mongoose.Types.ObjectId.isValid(String(processId))) {
    match.processId = new mongoose.Types.ObjectId(String(processId));
  }

  const rows = await deviceTestRecordModel
    .aggregate(buildLatestRecordPipeline(match))
    .allowDiskUse(true);
  return Array.isArray(rows)
    ? rows.filter((row) => isCountableStatus(row?.status)).length
    : 0;
};

const computePlanInsights = async ({
  planId = "",
  processId = "",
  operatorId = "",
  assignedStages = {},
  processStages = [],
  commonStages = [],
  selectedProduct = "",
  quantity = 0,
  shift = null,
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
    };
  }

  const normalizedAssignedStages = normalizeAssignedStagesPayload(
    assignedStages,
    processStages,
    commonStages,
  );
  const stageOrderMap = buildStageOrderMap({ processStages, commonStages });
  const stageSeatFallbackMap = getStageSeatFallbackMap(normalizedAssignedStages);

  // Prioritize processId to match historical records exactly.
  // Many records might be created without a specific planId during testing or migration.
  const latestMatch = {};
  if (processId && mongoose.Types.ObjectId.isValid(String(processId))) {
    latestMatch.processId = new mongoose.Types.ObjectId(String(processId));
  } else if (planId && mongoose.Types.ObjectId.isValid(String(planId))) {
    latestMatch.planId = new mongoose.Types.ObjectId(String(planId));
  }
  const latestRecords = await deviceTestRecordModel
    .aggregate(buildLatestRecordPipeline(latestMatch))
    .allowDiskUse(true);

  const byStageMap = new Map();
  const bySeatStageMap = new Map();

  const upsertStage = (stageName) => {
    const key = normalizeKey(stageName);
    if (!key) return null;
    if (!byStageMap.has(key)) {
      byStageMap.set(key, getDefaultStageRow(stageName));
    }
    return byStageMap.get(key);
  };

  const upsertSeatStage = (seatKey, stageName) => {
    const seat = normalizeValue(seatKey);
    const stage = normalizeValue(stageName);
    if (!seat || !stage) return null;
    const key = `${seat}:${normalizeKey(stage)}`;
    if (!bySeatStageMap.has(key)) {
      bySeatStageMap.set(key, getDefaultSeatStageRow(seat, stage));
    }
    return bySeatStageMap.get(key);
  };

  const latestByDeviceStage = new Map();
  const latestBySerial = new Map();
  
  (Array.isArray(latestRecords) ? latestRecords : []).forEach((record) => {
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

  dedupedRecords.forEach((record) => {
    const deviceId = String(record?.deviceId?._id || record?.deviceId || "");
    if (deviceId) processedDeviceIds.add(deviceId);

    const stageName = normalizeValue(record?.stageName || record?.currentStage || "");
    if (!stageName) return;

    const status = normalizeKey(record?.status);
    const isCountable = isCountableStatus(status);
    
    if (isCountable) {
      const stageRow = upsertStage(stageName);
      if (stageRow) {
        stageRow.tested += 1;
        if (isPassStatus(status)) stageRow.pass += 1;
        if (isNgStatus(status)) stageRow.ng += 1;
      }

      const seatKey = normalizeValue(record?.seatNumber || record?.currentSeatKey || record?.assignedSeatKey);
      if (seatKey) {
        const seatStageRow = upsertSeatStage(seatKey, stageName);
        if (seatStageRow) {
          seatStageRow.tested += 1;
          if (isPassStatus(status)) seatStageRow.pass += 1;
          if (isNgStatus(status)) seatStageRow.ng += 1;
        }
      }
    } else if (status.includes("resolved")) {
      // Resolved NG devices should be counted as WIP for the stage they returned to
      const stageRow = upsertStage(stageName);
      if (stageRow) stageRow.wip += 1;

      const seatKey = normalizeValue(record?.seatNumber || record?.currentSeatKey || record?.assignedSeatKey);
      if (seatKey) {
        const seatStageRow = upsertSeatStage(seatKey, stageName);
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

  const deviceSnapshots = planSerials.length > 0
    ? await deviceModel.find(deviceMatch)
        .select("_id serialNo status currentStage processID imei imeiNo ccid")
        .lean()
    : [];

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

  // Count active WIP (those without any test in this process yet)
  (Array.isArray(wipDevices) ? wipDevices : []).forEach((device) => {
     const deviceId = String(device?._id || "");
     if (processedDeviceIds.has(deviceId)) return;

     const status = normalizeKey(device?.status);
     const stageName = normalizeValue(device?.currentStage || firstProcessStage);
     if (!stageName) return;

     const stageRow = upsertStage(stageName);
     if (!stageRow) return;

      if (status === "ng" || status === "fail" || status === "qc" || status === "trc" || status === "rework" || status === "rejected") {
        stageRow.tested += 1;
        stageRow.ng += 1;
      } else if (status === "completed" || status === "dispatched") {
        stageRow.tested += 1;
        stageRow.pass += 1;
      } else {
         stageRow.wip += 1;
         
         // Find seat assignment for this active unit
         const seatKey = getDeviceSeatKeyForStage({
           latestRecord: latestBySerial.get(normalizeValue(device.serialNo)),
           stageName: stageName,
           stageSeatFallbackMap,
         });
         if (seatKey) {
            const seatRow = upsertSeatStage(seatKey, stageName);
            if (seatRow) seatRow.wip += 1;
         }
      }
  });

  // Calculate process-level summary totals
  latestBySerial.forEach((record, serial) => {
    uniquePlanTotals.tested += 1;
    const status = normalizeKey(record?.status);
    if (isPassStatus(status)) uniquePlanTotals.pass += 1;
    else if (isNgStatus(status)) uniquePlanTotals.ng += 1;
    else uniquePlanTotals.wip += 1;
  });

  const byStage = sortStageRows(Array.from(byStageMap.values()), stageOrderMap);
  const bySeatStage = sortSeatStageRows(Array.from(bySeatStageMap.values()), stageOrderMap);

  const targetUpha = getTargetUpha({ processStages, commonStages });
  const productiveHours = getShiftProductiveHours(shift);
  const denominator = targetUpha > 0 && productiveHours > 0 ? targetUpha * productiveHours : 0;
  const todayTested = await getTodayLatestTestedCount({ planId, processId });
  const processEfficiency = denominator > 0 ? Number(((uniquePlanTotals.tested / denominator) * 100).toFixed(2)) : 0;
  const todayEfficiency = denominator > 0 ? Number(((todayTested / denominator) * 100).toFixed(2)) : 0;
  const operatorToday = await getOperatorTodayStats({ operatorId, planId, processId });

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      tested: uniquePlanTotals.tested,
      pass: uniquePlanTotals.pass,
      ng: uniquePlanTotals.ng,
      wip: uniquePlanTotals.wip,
      lineIssueKits: uniquePlanTotals.pass + uniquePlanTotals.ng + uniquePlanTotals.wip,
      kitsShortage: 0,
      operatorToday,
      efficiency: {
        process: processEfficiency,
        today: todayEfficiency,
      },
      targetUpha,
      productiveHours,
    },
    byStage,
    bySeatStage,
    latestRecords: latestRecords || [],
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

  const latestMatch = { processId: new mongoose.Types.ObjectId(String(processId)) };
  const latestRecords = await deviceTestRecordModel
    .aggregate(buildLatestRecordPipeline(latestMatch))
    .allowDiskUse(true);

  const byStageMap = new Map();
  const upsertStage = (stageName) => {
    const key = normalizeKey(stageName);
    if (!key) return null;
    if (!byStageMap.has(key)) {
      byStageMap.set(key, getDefaultStageRow(stageName));
    }
    return byStageMap.get(key);
  };

  const firstProcessStage = normalizeValue(processStages?.[0]?.stageName || processStages?.[0]?.name || "");

  // Identify terminal devices to exclude from WIP
  const terminalDevicesInProcess = await deviceTestRecordModel.aggregate([
    { $match: { processId: new mongoose.Types.ObjectId(String(processId)) } },
    { $sort: { createdAt: -1 } },
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
    const stage = normalizeKey(stageName);
    if (!seat || !stage) return null;
    const key = `${seat}:${stage}`;
    if (!bySeatStageMap.has(key)) {
      bySeatStageMap.set(key, getDefaultSeatStageRow(seat, stageName));
    }
    return bySeatStageMap.get(key);
  };

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
  
  // 1. Process all test records (Pass/NG/QC/TRC)
  dedupedRecords.forEach((record) => {
    const deviceId = String(record?.deviceId?._id || record?.deviceId || "");
    if (deviceId) processedDeviceIds.add(deviceId);

    const currentStageName = normalizeValue(record?.stageName || record?.currentStage || "");
    if (!currentStageName) return;

    const status = normalizeKey(record?.status);
    const seatKey = String(record?.seatNumber || "").trim();
    
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
    } else if (status.includes("resolved")) {
      // Resolved NG devices should be counted as WIP for the stage they returned to
      const stageRow = upsertStage(currentStageName);
      if (stageRow) stageRow.wip += 1;

      if (seatKey) {
        const seatRow = upsertSeatStage(seatKey, currentStageName);
        if (seatRow) seatRow.wip += 1;
      }
    }
  });

  // 2. Process all other active devices (those without test records yet)
  (Array.isArray(wipDevices) ? wipDevices : []).forEach((device) => {
    const deviceId = String(device?._id || "");
    if (processedDeviceIds.has(deviceId)) return;

    const status = normalizeKey(device?.status);
    const stageName = normalizeValue(device?.currentStage || firstProcessStage);
    if (!stageName) return;

    const stageRow = upsertStage(stageName);
    if (!stageRow) return;

    if (status === "ng" || status === "fail" || status === "qc" || status === "trc" || status === "rework" || status === "rejected") {
       stageRow.tested += 1;
       stageRow.ng += 1;
    } else if (status === "completed" || status === "dispatched" || status === "pass") {
       stageRow.tested += 1;
       stageRow.pass += 1;
    } else {
      stageRow.wip += 1;
    }
  });

  // Calculate unique device totals for the whole process
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

  byStage.forEach((row) => {
    uniqueProcessTotals.wip += Number(row?.wip || 0);
  });

  return {
    generatedAt: new Date().toISOString(),
    totals: uniqueProcessTotals,
    byStage,
    bySeatStage,
  };
};

module.exports = {
  normalizeValue,
  normalizeKey,
  safeJsonParse,
  sortSeatKeys,
  normalizeAssignedStagesPayload,
  getSeatStageEntry,
  computePlanInsights,
  computeProcessInsights,
};
