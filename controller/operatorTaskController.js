const mongoose = require("mongoose");
const moment = require("moment");
const assignedOperatorsToPlanModel = require("../models/assignOperatorToPlan");
const assignedJigToPlanModel = require("../models/assignJigToPlan");
const planningAndSchedulingModel = require("../models/planingAndSchedulingModel");
const processModel = require("../models/process");
const productModel = require("../models/Products");
const shiftModel = require("../models/shiftManagement");
const deviceModel = require("../models/device");
const deviceTestRecordModel = require("../models/deviceTestModel");
const {
  parseStickerScanTokens,
  findDevicesByScanTokensStrict,
  findDevicesByScanTokensBestEffort,
} = require("../services/deviceScanMatcher");
const { computePlanInsights } = require("../services/planInsightsService");

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
const isRevertedEquivalentStatus = (status = "") => {
  const normalizedStatus = normalizeKey(status);
  return normalizedStatus === "reverted" || normalizedStatus === "removed";
};
const isTerminalStageStatus = (status = "") => {
  const normalizedStatus = normalizeKey(status);
  return normalizedStatus === "pass" || normalizedStatus === "completed" || normalizedStatus === "ng" || normalizedStatus === "fail";
};

const isDeviceVisibleToSeat = ({ device = {}, latestRecords = [], operatorStageName = "", processId = "", processStages = [], normalizedAssignedStages = {}, seatKey = "" }) => {
  const trimmedStageName = normalizeValue(operatorStageName);
  const normalizedTrimmedStageName = normalizeKey(trimmedStageName);
  const firstStageName = normalizeValue(processStages?.[0]?.stageName || "");
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

  if (!(deviceProcessId === String(processId) && deviceStatus !== "ng" && stageMatches)) {
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

  return deviceTestRecordModel.aggregate(pipeline).allowDiskUse(true);
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
  const assignedOperatorPayload = safeJsonParse(
    plan?.[isCommon ? "assignedCustomStagesOp" : "assignedOperators"],
    {},
  );
  const assignedStagePayload = safeJsonParse(
    plan?.[isCommon ? "assignedCustomStages" : "assignedStages"],
    {},
  );
  const normalizedAssignedStages = isCommon
    ? assignedStagePayload
    : normalizeAssignedStagesPayload(assignedStagePayload, process?.stages || []);

  const seatKey = sortSeatKeys(Object.keys(assignedOperatorPayload || {})).find((key) => {
    const operators = Array.isArray(assignedOperatorPayload?.[key])
      ? assignedOperatorPayload[key]
      : assignedOperatorPayload?.[key]
        ? [assignedOperatorPayload[key]]
        : [];
    return operators.some((operator) => {
      const candidate = String(operator?._id || operator?.userId || "");
      return candidate === String(operatorId);
    });
  }) || "";

  const assignUserStage = seatKey ? normalizedAssignedStages?.[seatKey] || null : null;
  const currentAssignedStage = Array.isArray(assignUserStage) ? assignUserStage[0] : assignUserStage;
  const currentAssignedStageName = normalizeValue(
    currentAssignedStage?.name || currentAssignedStage?.stageName || currentAssignedStage?.stage,
  );
  const processAssignUserStage = (process?.stages || []).find(
    (stage) => normalizeValue(stage?.stageName) === currentAssignedStageName,
  ) || null;

  const targetStageNames = new Set(
    (Array.isArray(assignUserStage) ? assignUserStage : assignUserStage ? [assignUserStage] : [])
      .map((stage) => normalizeValue(stage?.name || stage?.stageName || stage?.stage))
      .filter(Boolean),
  );
  const stageNames = Array.from(targetStageNames);
  const firstStageName = normalizeValue(process?.stages?.[0]?.stageName || "");
  const stageAwareCurrentStage = currentAssignedStageName
    ? normalizeValue(currentAssignedStageName) === firstStageName
      ? { $in: [currentAssignedStageName, "", null] }
      : currentAssignedStageName
    : undefined;

  const [latestRecords, rawDevices, canonicalInsights, operatorSummary] = await Promise.all([
    process?._id && stageNames.length > 0
      ? getLatestDeviceTests(planId, process._id, stageNames)
      : Promise.resolve([]),
    process?.selectedProduct
      ? deviceModel
          .find({
            productType: process.selectedProduct,
            processID: process._id,
            status: { $nin: ["NG"] },
            ...(stageAwareCurrentStage !== undefined ? { currentStage: stageAwareCurrentStage } : {}),
          })
          .select("_id serialNo imeiNo customFields modelName status currentStage processID productType flowVersion flowStartedAt")
          .lean()
      : Promise.resolve([]),
    computePlanInsights({
      planId,
      processId: process?._id || "",
      operatorId,
      assignedStages: normalizedAssignedStages,
      processStages: process?.stages || [],
      commonStages: process?.commonStages || [],
      selectedProduct: process?.selectedProduct || "",
      quantity: process?.quantity || 0,
      shift,
    }),
    getOperatorStats(operatorId, includeHistory),
  ]);

  const deviceQueue = seatKey && currentAssignedStageName && process
    ? filterDevicesForSeat({
        devices: rawDevices,
        latestRecords,
        operatorStageName: currentAssignedStageName,
        processId: process._id,
        processStages: process?.stages || [],
        normalizedAssignedStages,
        seatKey,
      })
    : [];

  const byStage = Array.isArray(canonicalInsights?.byStage) ? canonicalInsights.byStage : [];
  const bySeatStage = Array.isArray(canonicalInsights?.bySeatStage)
    ? canonicalInsights.bySeatStage
    : [];
  const scopedStages = byStage.filter((row) =>
    targetStageNames.has(normalizeValue(row?.stageName)),
  );
  const scopedSeatStages = seatKey
    ? bySeatStage.filter(
        (row) =>
          String(row?.seatKey || "") === String(seatKey) &&
          targetStageNames.has(normalizeValue(row?.stageName)),
      )
    : [];

  const scopedTotals = scopedStages.reduce(
    (acc, row) => {
      acc.overallTotalAttempts += Number(row?.tested || 0);
      acc.overallTotalCompleted += Number(row?.pass || 0);
      acc.overallTotalNg += Number(row?.ng || 0);
      acc.scopedStageWip += Number(row?.wip || 0);
      return acc;
    },
    {
      overallTotalAttempts: 0,
      overallTotalCompleted: 0,
      overallTotalNg: 0,
      scopedStageWip: 0,
    },
  );
  const scopedSeatWip = scopedSeatStages.reduce(
    (sum, row) => sum + Number(row?.wip || 0),
    0,
  );
  const resolvedWipKits =
    seatKey && scopedSeatStages.length > 0
      ? scopedSeatWip
      : seatKey && scopedSeatStages.length === 0
        ? deviceQueue.length
        : scopedTotals.scopedStageWip;
  const resolvedLineIssueKits =
    resolvedWipKits +
    scopedTotals.overallTotalCompleted +
    scopedTotals.overallTotalNg;

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
    assignedTaskDetails,
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
    counters: {
      wipKits: resolvedWipKits,
      lineIssueKits: resolvedLineIssueKits,
      kitsShortage: 0,
      overallTotalCompleted: scopedTotals.overallTotalCompleted,
      overallTotalNg: scopedTotals.overallTotalNg,
      overallTotalAttempts: scopedTotals.overallTotalAttempts,
      totalAttempts: Number(operatorToday?.totalAttempts || 0),
      totalCompleted: Number(operatorToday?.totalCompleted || 0),
      totalNg: Number(operatorToday?.totalNg || 0),
    },
    insights: {
      ...canonicalInsights,
      operatorScope: {
        seatKey,
        stageNames,
        tested: scopedTotals.overallTotalAttempts,
        pass: scopedTotals.overallTotalCompleted,
        ng: scopedTotals.overallTotalNg,
        wip: resolvedWipKits,
        lineIssueKits: resolvedLineIssueKits,
        kitsShortage: 0,
      },
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
      return res.status(200).json({ status: 200, message: "Operator task bootstrap fetched", data: payload });
    } catch (error) {
      return res.status(error.status || 500).json({ status: error.status || 500, error: error.message });
    }
  },
  getOperatorTaskRefresh: async (req, res) => {
    try {
      const { planId, operatorId } = req.params;
      const payload = await buildOperatorTaskSummary({ planId, operatorId });
      return res.status(200).json({ status: 200, message: "Operator task refresh fetched", data: payload });
    } catch (error) {
      return res.status(error.status || 500).json({ status: error.status || 500, error: error.message });
    }
  },
  getOperatorTaskDevice: async (req, res) => {
    try {
      const { planId, operatorId } = req.params;
      const { deviceId, serialNo, scanInput } = req.query || {};
      const summary = await buildOperatorTaskSummary({ planId, operatorId });
      const processId = summary?.process?._id || summary?.selectedProcess;
      const isCommon = summary?.assignedTaskDetails?.stageType === "common";
      const normalizedAssignedStages = isCommon
        ? safeJsonParse(summary?.plan?.assignedCustomStages, {})
        : normalizeAssignedStagesPayload(
            safeJsonParse(summary?.plan?.assignedStages, {}),
            summary?.process?.stages || [],
          );
      const currentAssignedStage = Array.isArray(summary?.assignUserStage)
        ? summary.assignUserStage[0]
        : summary?.assignUserStage;
      const currentAssignedStageName = normalizeValue(
        currentAssignedStage?.name || currentAssignedStage?.stageName || currentAssignedStage?.stage,
      );
      const seatKey = normalizeValue(
        summary?.operatorSeatInfo?.seatKey ||
          (String(summary?.operatorSeatInfo?.rowNumber || "") + "-" + String(summary?.operatorSeatInfo?.seatNumber || "")),
      );
      const firstStageName = normalizeValue(summary?.process?.stages?.[0]?.stageName || "");
      const stageAwareCurrentStage = currentAssignedStageName
        ? normalizeKey(currentAssignedStageName) === normalizeKey(firstStageName)
          ? { $in: [currentAssignedStageName, "", null] }
          : currentAssignedStageName
        : undefined;

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
        const visibleMatches = findDevicesByScanTokens(summary?.compactQueue || [], scanTokens);
        if (visibleMatches.length > 1) {
          return res.status(409).json(ambiguousSearchResponse);
        }
        if (visibleMatches.length === 1) {
          device = visibleMatches[0].device;
          matchMeta = visibleMatches[0];
        }

        if (!device) {
          const stageScopedDevices = processId && summary?.process?.selectedProduct
            ? await deviceModel
                .find({
                  productType: summary.process.selectedProduct,
                  processID: processId,
                  status: { $nin: ["NG"] },
                  ...(stageAwareCurrentStage !== undefined ? { currentStage: stageAwareCurrentStage } : {}),
                })
                .select("_id serialNo imeiNo customFields modelName status currentStage processID productType flowVersion flowStartedAt")
                .lean()
            : [];
          const stageMatches = findDevicesByScanTokens(stageScopedDevices, scanTokens);
          if (stageMatches.length > 1) {
            return res.status(409).json(ambiguousSearchResponse);
          }
          if (stageMatches.length === 1) {
            device = stageMatches[0].device;
            matchMeta = stageMatches[0];
          }

          if (!device) {
            const processScopedDevices = processId && summary?.process?.selectedProduct
              ? await deviceModel
                  .find({
                    productType: summary.process.selectedProduct,
                    processID: processId,
                    status: { $nin: ["NG"] },
                  })
                  .select("_id serialNo imeiNo customFields modelName status currentStage processID productType flowVersion flowStartedAt")
                  .lean()
              : [];

            const processMatches = findDevicesByScanTokens(
              processScopedDevices,
              scanTokens,
            );

            if (processMatches.length > 1) {
              return res.status(409).json(ambiguousSearchResponse);
            }
            if (processMatches.length === 1) {
              device = processMatches[0].device;
              matchMeta = processMatches[0];
            }
          }
        }
      } else if (serialNo) {
        const query = { serialNo: String(serialNo).trim() };
        if (processId) query.processID = processId;
        device = await deviceModel.findOne(query).lean();
      }

      if (!device?._id) {
        return res.status(404).json({
          status: 404,
          message: scanTokens.length > 0
            ? "No device matched the scanned sticker values."
            : "Device not found",
        });
      }

      const latestRecords = processId
        ? await getLatestDeviceTests(planId, processId, currentAssignedStageName ? [currentAssignedStageName] : []).catch(() => [])
        : [];

      const isVisibleToSeat = currentAssignedStageName && seatKey && processId
        ? isDeviceVisibleToSeat({
            device,
            latestRecords,
            operatorStageName: currentAssignedStageName,
            processId,
            processStages: summary?.process?.stages || [],
            normalizedAssignedStages,
            seatKey,
          })
        : true;

      if (!isVisibleToSeat) {
        const currentStageRecord = getLatestStageRecordBySerial({
          records: latestRecords,
          serialNo: device?.serialNo || serialNo,
          stageName: currentAssignedStageName,
        });
        const claimedSeatKey = getClaimSeatKey(currentStageRecord);
        if (claimedSeatKey && claimedSeatKey !== seatKey && !isTerminalStageStatus(currentStageRecord?.status)) {
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
          process: summary.process,
          assignUserStage: summary.assignUserStage,
          operatorSeatInfo: summary.operatorSeatInfo,
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
