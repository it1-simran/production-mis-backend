const deviceModel = require("../models/device");
const deviceTestModel = require("../models/deviceTestModel");
const processModel = require("../models/process");
const deviceTestRecords = require("../models/deviceTestModel");
const planingAndScheduling = require("../models/planingAndSchedulingModel");
const productModel = require("../models/Products");
const inventoryModel = require("../models/inventoryManagement");
const imeiModel = require("../models/imeiModel");
const NGDevice = require("../models/NGDevice");
const User = require("../models/User");
const mongoose = require("mongoose");
const OrderConfirmationModel = require("../models/orderConfirmationNumber");
const DeviceAttempt = require("../models/deviceAttempt");
const cartonModel = require("../models/cartonManagement");
const {
  parseStickerScanTokensFromJigFields,
  findDevicesByScanTokensStrict,
} = require("../services/deviceScanMatcher");

function sanitizeKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeKeys(item));
  }
  if (value && typeof value === "object") {
    const next = {};
    Object.keys(value).forEach((key) => {
      const safeKey = String(key).replace(/\u0000/g, "");
      next[safeKey] = sanitizeKeys(value[key]);
    });
    return next;
  }
  return value;
}

const normalizeText = (value) => String(value || "").trim();
const getStageLabel = (stage) => normalizeText(stage?.name || stage?.stageName || stage?.stage);
const toStageArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const safeParseJson = (value, fallback) => {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
};
const shouldLogOperatorPassTimings = String(process.env.LOG_OPERATOR_PASS_TIMINGS || "").toLowerCase() === "true";
const logOperatorPassTimings = (timings = {}, meta = {}) => {
  if (!shouldLogOperatorPassTimings) return;
  try {
    console.info("[operator-pass-timing]", JSON.stringify({ ...meta, ...timings }));
  } catch (error) {
    console.info("[operator-pass-timing]", { ...meta, ...timings });
  }
};
const buildCompactDeviceTestRecord = (record = {}) => ({
  _id: record?._id || null,
  deviceId: record?.deviceId || null,
  serialNo: record?.serialNo || "",
  stageName: record?.stageName || "",
  status: record?.status || "",
  createdAt: record?.createdAt || null,
});
function resolveAssignedSeatContext({
  assignedStages = {},
  rawAssignedOperators,
  operatorId,
  currentSeatKey = "",
  currentLogicalStage = "",
  stageInstanceId = "",
  parallelGroupKey = "",
}) {
  const normalizedSeatKey = normalizeText(currentSeatKey);
  const normalizedLogicalStage = normalizeText(currentLogicalStage);
  const normalizedStageInstanceId = normalizeText(stageInstanceId);
  const normalizedParallelGroupKey = normalizeText(parallelGroupKey);

  const tryResolveSeat = (seatKey) => {
    if (!seatKey || !assignedStages?.[seatKey]) return null;
    const seatStages = toStageArray(assignedStages[seatKey]);
    if (!seatStages.length) return null;

    let targetStageIdx = seatStages.findIndex((stage) => {
      if (normalizedStageInstanceId && normalizeText(stage?.stageInstanceId) === normalizedStageInstanceId) {
        return true;
      }
      const stageName = getStageLabel(stage);
      if (normalizedLogicalStage && stageName !== normalizedLogicalStage) {
        return false;
      }
      if (normalizedParallelGroupKey && normalizeText(stage?.parallelGroupKey) !== normalizedParallelGroupKey) {
        return false;
      }
      return Boolean(stageName || normalizedStageInstanceId || normalizedParallelGroupKey);
    });

    if (targetStageIdx === -1) {
      targetStageIdx = seatStages.findIndex((stage) => getStageLabel(stage) === normalizedLogicalStage);
    }
    if (targetStageIdx === -1) {
      targetStageIdx = 0;
    }

    return {
      seatKey,
      seatStages,
      targetStageIdx,
      currentStageName: getStageLabel(seatStages[targetStageIdx]) || getStageLabel(seatStages[0]),
    };
  };

  const directSeat = tryResolveSeat(normalizedSeatKey);
  if (directSeat) {
    return directSeat;
  }

  const assignedOperators = safeParseJson(rawAssignedOperators, {});
  const fallbackSeatKey = Object.keys(assignedOperators || {}).find((key) =>
    toStageArray(assignedOperators[key]).some(
      (operator) => normalizeText(operator?._id || operator?.userId) === normalizeText(operatorId),
    ),
  );

  return fallbackSeatKey ? tryResolveSeat(fallbackSeatKey) : null;
}

const normalizeKey = (value) => normalizeText(value).toLowerCase().replace(/\s+/g, " ");

const toSeatParts = (seatKey = "") => {
  const [lineIndex, seatIndex] = String(seatKey || "")
    .split("-")
    .map((part) => Number(part));

  return {
    lineIndex: Number.isFinite(lineIndex) ? lineIndex : -1,
    seatIndex: Number.isFinite(seatIndex) ? seatIndex : -1,
  };
};

const sortSeatKeys = (seatKeys = []) =>
  [...seatKeys].sort((left, right) => {
    const leftSeat = toSeatParts(left);
    const rightSeat = toSeatParts(right);

    if (leftSeat.lineIndex !== rightSeat.lineIndex) {
      return leftSeat.lineIndex - rightSeat.lineIndex;
    }

    return leftSeat.seatIndex - rightSeat.seatIndex;
  });

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

    if (seatItems.length === 0) {
      return acc;
    }

    const { lineIndex } = toSeatParts(seatKey);
    acc[seatKey] = seatItems.map((item, itemIndex) => {
      if (item?.reserved) {
        return {
          ...item,
          seatKey,
          lineIndex,
        };
      }

      const stageName = normalizeText(item?.stageName || item?.name || item?.stage);
      const normalizedStageName = normalizeKey(stageName);
      const sequenceIndex = stageOrderMap.has(normalizedStageName)
        ? Number(stageOrderMap.get(normalizedStageName))
        : itemIndex;
      const parallelGroupKey =
        item?.parallelGroupKey ||
        `line-${lineIndex}-seq-${sequenceIndex}-stage-${normalizedStageName.replace(/[^a-z0-9]+/g, "-")}`;
      const stageInstanceId =
        item?.stageInstanceId ||
        `${parallelGroupKey}-seat-${seatKey.replace(/[^0-9-]+/g, "")}`;

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

const getParallelSeatEntries = ({ assignedStages = {}, stageName = "", lineIndex = -1, parallelGroupKey = "" }) => {
  const targetStageName = normalizeKey(stageName);
  const targetGroupKey = normalizeText(parallelGroupKey);

  const normalizedEntries = sortSeatKeys(Object.keys(assignedStages || {}))
    .map((seatKey) => ({ seatKey, stage: getSeatStageEntry(assignedStages, seatKey) }))
    .filter(({ stage }) => !!stage && !stage?.reserved);

  const sameLane = normalizedEntries.filter(({ stage }) => {
    if (targetGroupKey) {
      return normalizeText(stage?.parallelGroupKey) === targetGroupKey;
    }

    return (
      stage?.lineIndex === lineIndex &&
      normalizeKey(stage?.stageName || stage?.name || stage?.stage) === targetStageName
    );
  });

  if (sameLane.length > 0) {
    return sameLane;
  }

  return normalizedEntries.filter(({ stage }) => (
    normalizeKey(stage?.stageName || stage?.name || stage?.stage) === targetStageName
  ));
};

const getNextLogicalStageName = (processStages = [], currentStageName = "", commonStages = []) => {
  const normalizedCurrent = normalizeKey(currentStageName);
  const stages = Array.isArray(processStages) ? processStages : [];
  const currentIndex = stages.findIndex(
    (stage) => normalizeKey(stage?.stageName || stage?.name) === normalizedCurrent,
  );

  if (currentIndex >= 0 && currentIndex < stages.length - 1) {
    return normalizeText(stages[currentIndex + 1]?.stageName || stages[currentIndex + 1]?.name);
  }

  const commonStage = (Array.isArray(commonStages) ? commonStages : [])[0];
  return normalizeText(commonStage?.stageName || commonStage?.name || commonStage?.stage);
};

const chooseNextStageSeatAssignment = ({
  assignedStages = {},
  currentSeatKey = "",
  currentStageName = "",
  processStages = [],
  commonStages = [],
}) => {
  const nextLogicalStage = getNextLogicalStageName(processStages, currentStageName, commonStages);
  if (!nextLogicalStage) {
    return {
      nextLogicalStage: "",
      assignedSeatKey: "",
      assignedStageInstanceId: "",
      assignedParallelGroupKey: "",
    };
  }

  const currentSeatStage = getSeatStageEntry(assignedStages, currentSeatKey);
  const currentLineIndex = currentSeatStage?.lineIndex ?? toSeatParts(currentSeatKey).lineIndex;
  const sameLaneCandidates = getParallelSeatEntries({
    assignedStages,
    stageName: nextLogicalStage,
    lineIndex: currentLineIndex,
  });
  const candidates = sameLaneCandidates.length > 0
    ? sameLaneCandidates
    : getParallelSeatEntries({ assignedStages, stageName: nextLogicalStage });

  if (candidates.length === 0) {
    return {
      nextLogicalStage,
      assignedSeatKey: "",
      assignedStageInstanceId: "",
      assignedParallelGroupKey: "",
    };
  }

  const selectedCandidate = [...candidates].sort((left, right) => {
    const leftLoad = Number(left?.stage?.totalUPHA || 0);
    const rightLoad = Number(right?.stage?.totalUPHA || 0);
    if (leftLoad !== rightLoad) {
      return leftLoad - rightLoad;
    }

    return sortSeatKeys([left.seatKey, right.seatKey])[0] === left.seatKey ? -1 : 1;
  })[0];

  return {
    nextLogicalStage,
    assignedSeatKey: selectedCandidate?.seatKey || "",
    assignedStageInstanceId: selectedCandidate?.stage?.stageInstanceId || "",
    assignedParallelGroupKey: selectedCandidate?.stage?.parallelGroupKey || "",
  };
};

const isPassingStatus = (status) => {
  const normalizedStatus = normalizeKey(status);
  return normalizedStatus === "pass" || normalizedStatus === "completed";
};

const resolvePreviousStageEligibility = async ({
  processStages = [],
  currentStageName = "",
  serialNo = "",
  deviceCurrentStage = "",
  planId = "",
  processId = "",
}) => {
  const normalizedCurrentStage = normalizeText(currentStageName);
  const stages = Array.isArray(processStages) ? processStages : [];
  const currentStageIndex = stages.findIndex(
    (stage) => normalizeKey(stage?.stageName || stage?.name) === normalizeKey(normalizedCurrentStage),
  );

  if (!normalizedCurrentStage || currentStageIndex < 0) {
    return { isEligible: true, message: "", previousStageRecord: null };
  }

  if (currentStageIndex === 0) {
    return { isEligible: true, message: "", previousStageRecord: null };
  }

  if (
    normalizeText(deviceCurrentStage) &&
    normalizeKey(deviceCurrentStage) === normalizeKey(normalizedCurrentStage)
  ) {
    return { isEligible: true, message: "", previousStageRecord: null };
  }

  const previousStageName = normalizeText(
    stages[currentStageIndex - 1]?.stageName || stages[currentStageIndex - 1]?.name || "",
  );
  const query = {
    serialNo: normalizeText(serialNo),
    $or: [
      { stageName: previousStageName },
      { currentLogicalStage: previousStageName },
      { currentStage: previousStageName },
    ],
  };

  if (planId && mongoose.Types.ObjectId.isValid(planId)) {
    query.planId = new mongoose.Types.ObjectId(planId);
  }
  if (processId && mongoose.Types.ObjectId.isValid(processId)) {
    query.processId = new mongoose.Types.ObjectId(processId);
  }

  const previousStageRecord = await deviceTestRecords.findOne(query).sort({ createdAt: -1 }).lean();
  if (!previousStageRecord) {
    return {
      isEligible: false,
      message: `This device must first pass ${previousStageName} before testing can start at ${normalizedCurrentStage}.`,
      previousStageRecord: null,
    };
  }

  if (!isPassingStatus(previousStageRecord?.status)) {
    const latestStatus = normalizeText(previousStageRecord?.status || "Unknown");
    return {
      isEligible: false,
      message: `This device cannot start ${normalizedCurrentStage} because ${previousStageName} is not passed. Latest status: ${latestStatus}.`,
      previousStageRecord,
    };
  }

  return { isEligible: true, message: "", previousStageRecord };
};

const getRoutedStageName = (record = {}) => normalizeKey(
  record?.nextLogicalStage ||
  record?.currentLogicalStage ||
  record?.currentStage ||
  record?.stageName,
);

const getClaimedSeatKey = (record = {}, currentStageName = "") => {
  const normalizedCurrentStage = normalizeKey(currentStageName);
  const directStage = normalizeKey(record?.currentLogicalStage || record?.currentStage || record?.stageName);
  if (directStage === normalizedCurrentStage && normalizeText(record?.currentSeatKey)) {
    return normalizeText(record.currentSeatKey);
  }

  const routedStage = getRoutedStageName(record);
  if (routedStage === normalizedCurrentStage && normalizeText(record?.assignedSeatKey)) {
    return normalizeText(record.assignedSeatKey);
  }

  return "";
};

const buildActionResponseMeta = (status) => {
  const normalizedStatus = normalizeKey(status);
  if (normalizedStatus === "ng") {
    return {
      actionStatus: "NG",
      resultType: "ng",
      message: "Device marked as NG",
    };
  }

  if (normalizedStatus === "pass" || normalizedStatus === "completed") {
    return {
      actionStatus: "Pass",
      resultType: "pass",
      message: "Device passed successfully",
    };
  }

  const readableStatus = normalizeText(status || "Saved");
  return {
    actionStatus: readableStatus,
    resultType: "saved",
    message: readableStatus ? `Device ${readableStatus} saved successfully` : "Device saved successfully",
  };
};
const resolveDeviceIdentity = (device) => {
  if (!device) return device;
  let imeiNo = device.imeiNo;
  let ccid = device.ccid;

  let customFields = device.customFields;
  if (typeof customFields === "string") {
    try {
      customFields = JSON.parse(customFields);
    } catch {
      customFields = null;
    }
  }

  if (customFields && typeof customFields === "object") {
    // Priority: Functional.IMEI as requested
    if (!imeiNo && customFields.Functional && (customFields.Functional.IMEI || customFields.Functional.imei)) {
      imeiNo = customFields.Functional.IMEI || customFields.Functional.imei;
    }

    // Fallback: search all stages
    if (!imeiNo || !ccid) {
      Object.values(customFields).forEach(stage => {
        if (stage && typeof stage === "object") {
          if (!imeiNo && (stage.IMEI || stage.imei)) imeiNo = stage.IMEI || stage.imei;
          if (!ccid && (stage.CCID || stage.ccid)) ccid = stage.CCID || stage.ccid;
        }
      });
    }
  }

  return {
    ...device,
    imeiNo: imeiNo ? String(imeiNo).trim() : device.imeiNo,
    ccid: ccid ? String(ccid).trim() : device.ccid,
  };
};

module.exports = {
  create: async (req, res) => {
    try {
      const data = req.body || {};
      const productType = data.selectedProduct;
      const currentStage = req.body.currentStage;
      const processID = req.body.processId;
      const prefix = req.body.prefix;
      const noOfSerialRequired = Number.parseInt(req.body.noOfSerialRequired, 10) || 0;
      const suffix = req.body.suffix;
      const enableZero = req.body.enableZero;
      const lastSerialNo = req.body.lastSerialNo;
      const noOfZeroRequired = req.body.noOfZeroRequired;
      const startFrom = req.body.startFrom;

      if (!productType || !processID) {
        return res.status(400).json({ status: 400, message: "selectedProduct and processId are required" });
      }
      if (noOfSerialRequired <= 0) {
        return res.status(400).json({ status: 400, message: "noOfSerialRequired must be greater than 0" });
      }

      const parsedStartFrom = Number.parseInt(startFrom, 10);
      const serials = generateSerials(
        lastSerialNo,
        prefix,
        noOfSerialRequired,
        suffix,
        enableZero,
        noOfZeroRequired,
        1,
        1,
        Number.isNaN(parsedStartFrom) ? null : parsedStartFrom
      );

      // Fetch modelName from Order Confirmation for this process
      let modelNameFromOc = "";
      const processDoc = await processModel.findById(processID).select("orderConfirmationNo").lean();
      if (processDoc?.orderConfirmationNo) {
        const ocDoc = await OrderConfirmationModel.findOne({ orderConfirmationNo: processDoc.orderConfirmationNo }).select("modelName").lean();
        if (ocDoc?.modelName) {
          modelNameFromOc = ocDoc.modelName;
        }
      }

      const documents = serials.map((value) => ({
        productType,
        processID,
        serialNo: value,
        currentStage,
        modelName: modelNameFromOc,
      }));

      const chunkSize = 250;
      let insertedCount = 0;
      let duplicateErrors = 0;

      for (let index = 0; index < documents.length; index += chunkSize) {
        const chunk = documents.slice(index, index + chunkSize);

        try {
          const result = await deviceModel.insertMany(chunk, {
            ordered: false,
            rawResult: true,
          });

          insertedCount += Number(result?.insertedCount || chunk.length);
        } catch (error) {
          if (error?.name !== "MongoBulkWriteError") {
            throw error;
          }

          const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
          const chunkDuplicateErrors = writeErrors.filter((item) => item?.code === 11000).length;
          const chunkInsertedCount = Number(
            error?.result?.result?.nInserted ??
            error?.result?.insertedCount ??
            Math.max(chunk.length - writeErrors.length, 0)
          );

          insertedCount += chunkInsertedCount;
          duplicateErrors += chunkDuplicateErrors;

          const nonDuplicateWriteError = writeErrors.find((item) => item?.code !== 11000);
          if (nonDuplicateWriteError) {
            throw error;
          }
        }
      }

      const requestedCount = documents.length;
      const message = duplicateErrors > 0
        ? `${insertedCount} devices created, ${duplicateErrors} duplicate serials skipped.`
        : "Devices added successfully";

      return res.status(200).json({
        status: 200,
        message,
        requestedCount,
        insertedCount,
        duplicateErrors,
      });
    } catch (error) {
      console.error("error ==>", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getLastEntryBasedOnPrefixAndSuffix: async (req, res) => {
    try {
      const data = req.query;
      const escapeRegex = (string) => string.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
      const escapedPrefix = escapeRegex(data.prefix || "");
      const escapedSuffix = escapeRegex(data.suffix || "");

      const lastEntry = await deviceModel
        .findOne({
          serialNo: { $regex: `^${escapedPrefix}.*${escapedSuffix}$` },
        })
        .sort({ createdAt: -1 })
        .exec();
      return res.status(200).json({
        status: 200,
        message: "Last Entry Fetched Successfully",
        data: lastEntry,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getDeviceCountByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;
      const count = await deviceModel.countDocuments({ processID: processId });
      return res.status(200).json({
        status: 200,
        message: "Device Count Fetched Successfully",
        count: count,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getDevicesByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;
      const devices = await deviceModel
        .find({ processID: processId }, null, { sort: { createdAt: -1 } })
        .lean();

      const deviceIds = devices.map((device) => device?._id).filter(Boolean);
      const historyByDevice = new Map();

      if (deviceIds.length > 0) {
        const histories = await deviceTestRecords
          .find({ deviceId: { $in: deviceIds } })
          .sort({ createdAt: 1 })
          .select("deviceId stageName status createdAt flowVersion flowBoundary flowType previousFlowVersion")
          .lean();

        histories.forEach((history) => {
          const key = String(history?.deviceId || "");
          if (!historyByDevice.has(key)) {
            historyByDevice.set(key, []);
          }
          historyByDevice.get(key).push(history);
        });
      }

      const devicesWithHistory = devices.map((deviceRaw) => {
        const device = resolveDeviceIdentity(deviceRaw);
        const allHistory = historyByDevice.get(String(device?._id)) || [];
        const activeFlowVersion = Number(device?.flowVersion || 1);
        const currentFlowHistory = allHistory.filter((history) => {
          const recordFlowVersion = Number(history?.flowVersion || 1);
          return recordFlowVersion === activeFlowVersion;
        });

        const stageHistory = (currentFlowHistory.length > 0 ? currentFlowHistory : allHistory).map((history) => ({
          stageName: history?.stageName || "Unknown Stage",
          status: history?.status || "N/A",
          createdAt: history?.createdAt || null,
          flowVersion: history?.flowVersion || 1,
          flowBoundary: !!history?.flowBoundary,
          flowType: history?.flowType || "stage",
        }));

        return {
          ...device,
          stageHistory,
          hasStageHistory: stageHistory.length > 0,
        };
      });

      return res.status(200).json({
        status: 200,
        message: "Devices fetched successfully",
        data: devicesWithHistory,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getNGDevicesByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(processId)) {
        return res.status(400).json({
          status: 400,
          message: "Invalid processId",
        });
      }

      const ngDevices = await deviceTestRecords
        .find({
          processId: new mongoose.Types.ObjectId(processId),
          status: { $regex: /^NG$/i },
        })
        .populate("deviceId")
        .populate("processId")
        .lean();

      return res.status(200).json({
        status: 200,
        message: "NG devices fetched successfully",
        data: ngDevices,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  createIMEI: async (req, res) => {
    try {
      const data = req.body;
      const productType = data.selectedProduct;
      const imeis = JSON.parse(data.imei);
      const savedImeis = [];

      for (const value of imeis.slice(1)) {
        const imei = new imeiModel({
          productType,
          imeiNo: value[0],
          status: "Pending",
        });
        const savedImei = await imei.save();
        savedImeis.push(savedImei);
      }

      return res.status(200).json({
        status: 200,
        message: "IMEI added successfully",
        data: savedImeis,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  viewIMEI: async (req, res) => {
    try {
      const imei = await imeiModel.aggregate([
        {
          $lookup: {
            from: "products", // Collection name in MongoDB
            localField: "productType",
            foreignField: "_id",
            as: "products",
          },
        },
        {
          $unwind: "$products",
        },
        {
          $project: {
            _id: 1,
            imeiNo: 1,
            status: 1,
            productName: "$products.name",
          },
        },
      ]);
      return res.status(200).json({
        status: 200,
        status_msg: "IMEI Fetched Sucessfully!!",
        imei,
      });
    } catch (error) {
      console.error("Error fetching IMEI details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  deleteIMEI: async (req, res) => {
    try {
      const imei = await imeiModel.findByIdAndDelete(req.params.id);
      if (!imei) {
        return res.status(404).json({ message: "Product not found" });
      }
      res.status(200).json({ message: "Product deleted successfully", imei });
    } catch (error) {
      console.error("Error fetching Product details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  deleteMultipleIMEI: async (req, res) => {
    try {
      const ids = req.body.deleteIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          message: "Invalid request, ids must be an array of strings",
        });
      }
      const objectIds = ids.map((id) => {
        if (mongoose.Types.ObjectId.isValid(id)) {
          return new mongoose.Types.ObjectId(id);
        } else {
          throw new Error(`Invalid ObjectId: ${id}`);
        }
      });

      const result = await imeiModel.deleteMany({ _id: { $in: objectIds } });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} item(s) deleted successfully`,
      });
    } catch (error) {
      // Error handling
      if (error.message.startsWith("Invalid ObjectId")) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error deleting multiple items:", error);
      return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
  },
  getDeviceByProductId: async (req, res) => {
    try {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          status: 400,
          error: "Invalid Product ID",
        });
      }
      const devices = await deviceModel.find({ productType: id });
      if (devices.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "No devices found for the given Product ID",
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Devices retrieved successfully",
        data: devices,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  createDeviceTestEntry: async (req, res) => {
    const requestStartedAt = Date.now();
    const timings = {};
    const markTiming = (key, startedAt) => {
      timings[key] = Date.now() - startedAt;
    };

    try {
      const data = req.body || {};
      if (data && data.logs) {
        data.logs = sanitizeKeys(data.logs);
      }

      const serialNo = normalizeText(
        data.serialNo || data.serialNoValue || data.deviceSerial || data.serial,
      );
      const requestedProcessId = normalizeText(data.processId || "");
      const assignedDeviceTo = normalizeText(data.assignedDeviceTo);
      const actionMeta = buildActionResponseMeta(data.status);
      const isQcOrTrc = assignedDeviceTo === "QC" || assignedDeviceTo === "TRC";

      const planStart = Date.now();
      const planPromise = planingAndScheduling
        .findById(data.planId)
        .select("selectedProcess assignedStages assignedOperators assignedCustomStagesOp consumedKit")
        .lean()
        .then((result) => {
          markTiming("planLoadMs", planStart);
          return result;
        });

      const processStart = Date.now();
      const processPromise = requestedProcessId && mongoose.Types.ObjectId.isValid(requestedProcessId)
        ? processModel.findById(requestedProcessId).select("stages commonStages").lean().then((result) => {
            markTiming("processLoadMs", processStart);
            return result;
          })
        : Promise.resolve(null).then((result) => {
            markTiming("processLoadMs", processStart);
            return result;
          });

      const deviceLookupStart = Date.now();
      const devicePromise = data.deviceId && mongoose.Types.ObjectId.isValid(data.deviceId)
        ? deviceModel.findById(data.deviceId).select("_id serialNo currentStage status flowVersion flowStartedAt processID modelName").lean().then((result) => {
            markTiming("deviceLookupMs", deviceLookupStart);
            return result;
          })
        : serialNo
          ? deviceModel.findOne({ serialNo }).select("_id serialNo currentStage status flowVersion flowStartedAt processID modelName").lean().then((result) => {
              markTiming("deviceLookupMs", deviceLookupStart);
              return result;
            })
          : Promise.resolve(null).then((result) => {
              markTiming("deviceLookupMs", deviceLookupStart);
              return result;
            });

      let [planing, products, deviceSnapshot] = await Promise.all([planPromise, processPromise, devicePromise]);

      if (!planing) {
        return res.status(404).json({
          status: 404,
          message: "Planing not found",
        });
      }

      const resolvedProcessId = normalizeText(planing.selectedProcess || requestedProcessId || deviceSnapshot?.processID || "");
      if ((!products || !products?._id) && resolvedProcessId && mongoose.Types.ObjectId.isValid(resolvedProcessId)) {
        const fallbackProcessStart = Date.now();
        products = await processModel.findById(resolvedProcessId).select("stages commonStages").lean();
        markTiming("fallbackProcessLoadMs", fallbackProcessStart);
      }
      if (!products?._id) {
        return res.status(404).json({
          status: 404,
          message: "Process not found",
        });
      }

      if (!deviceSnapshot && serialNo) {
        const fallbackDeviceStart = Date.now();
        deviceSnapshot = await deviceModel.findOne({ serialNo }).select("_id serialNo currentStage status flowVersion flowStartedAt processID modelName").lean();
        markTiming("fallbackDeviceLookupMs", fallbackDeviceStart);
      }
      if (!deviceSnapshot?._id) {
        return res.status(404).json({
          status: 404,
          message: "Device not found",
        });
      }

      data.deviceId = data.deviceId || String(deviceSnapshot._id || "");
      data.serialNo = serialNo || normalizeText(deviceSnapshot.serialNo);
      data.processId = resolvedProcessId;

      const payloadFlowVersion = Number(data.flowVersion);
      const hasFlowVersion = Number.isFinite(payloadFlowVersion) && payloadFlowVersion > 0;
      const hasFlowStartedAt = Object.prototype.hasOwnProperty.call(data, "flowStartedAt");
      data.flowVersion = hasFlowVersion ? payloadFlowVersion : Number(deviceSnapshot?.flowVersion || 1);
      data.flowStartedAt = hasFlowStartedAt ? (data.flowStartedAt || null) : (deviceSnapshot?.flowStartedAt || null);
      data.flowBoundary = false;
      data.flowType = data.flowType || "stage";
      data.previousFlowVersion = null;

      const parseStart = Date.now();
      const rawAssignedStages = safeParseJson(planing.assignedStages, {}) || {};
      const normalizedAssignedStages = normalizeAssignedStagesPayload(rawAssignedStages, products?.stages || []);
      let assignedCustomStagesOp = [];
      if (planing.assignedCustomStagesOp) {
        const parsedCustomStages = safeParseJson(planing.assignedCustomStagesOp, []);
        assignedCustomStagesOp = Array.isArray(parsedCustomStages) ? parsedCustomStages : [];
      }
      markTiming("planParseMs", parseStart);

      const seatResolveStart = Date.now();
      const resolvedSeatContext = resolveAssignedSeatContext({
        assignedStages: normalizedAssignedStages,
        rawAssignedOperators: planing.assignedOperators,
        operatorId: data.operatorId,
        currentSeatKey: data.currentSeatKey,
        currentLogicalStage: data.currentLogicalStage || data.stageName,
        stageInstanceId: data.stageInstanceId,
        parallelGroupKey: data.parallelGroupKey,
      });
      markTiming("seatResolveMs", seatResolveStart);

      if (!resolvedSeatContext && isQcOrTrc) {
        let savedDeviceTestRecord = null;
        const writeSession = await mongoose.startSession();
        try {
          await writeSession.withTransaction(async () => {
            const notes = normalizeText(data.ngDescription || data?.logData?.description || "");
            const ngPayload = {
              processId: resolvedProcessId || null,
              userId: data.operatorId || data.userId || null,
              department: assignedDeviceTo,
              serialNo: data.serialNo || "",
              ngStage: normalizeText(data.stageName || data.ngStage || ""),
              ...(notes ? { notes } : {}),
            };
            if (ngPayload.processId && ngPayload.userId && ngPayload.serialNo) {
              const ngRecord = new NGDevice(ngPayload);
              await ngRecord.save({ session: writeSession });
            }

            const recordSaveStart = Date.now();
            savedDeviceTestRecord = await new deviceTestRecords({
              ...data,
              assignedDeviceTo,
            }).save({ session: writeSession });
            markTiming("recordSaveMs", recordSaveStart);
          });
        } finally {
          await writeSession.endSession();
        }

        timings.totalMs = Date.now() - requestStartedAt; // Total time
        logOperatorPassTimings(timings, {
          actionStatus: actionMeta.actionStatus,
          planId: data.planId || "",
          processId: resolvedProcessId || "",
          seatKey: data.currentSeatKey || "",
          stageName: data.stageName || data.currentLogicalStage || "",
          branch: "qc-trc-direct",
        });
        return res.status(200).json({
          status: 200,
          message: actionMeta.message,
          actionStatus: actionMeta.actionStatus,
          resultType: actionMeta.resultType,
          data: {
            ...buildCompactDeviceTestRecord(savedDeviceTestRecord),
            actionStatus: actionMeta.actionStatus,
            resultType: actionMeta.resultType,
          },
        });
      }

      if (!resolvedSeatContext) {
        return res.status(404).json({
          status: 404,
          message: "Operator not found in assigned operators.",
        });
      }

      const currentIndex = resolvedSeatContext.seatKey;
      const currentSeatKey = normalizeText(data.currentSeatKey || currentIndex || "");
      const currentStageName = normalizeText(
        resolvedSeatContext.currentStageName || data.currentLogicalStage || data.stageName || getStageLabel(rawAssignedStages[currentIndex]),
      );
      const rawSeatStages = toStageArray(rawAssignedStages[currentIndex]);
      const targetStageIdx = resolvedSeatContext.targetStageIdx >= 0 && resolvedSeatContext.targetStageIdx < rawSeatStages.length
        ? resolvedSeatContext.targetStageIdx
        : Math.max(rawSeatStages.findIndex((stage) => normalizeKey(getStageLabel(stage)) === normalizeKey(currentStageName)), 0);
      const currentSeatStage = getSeatStageEntry(normalizedAssignedStages, currentSeatKey);
      const productStages = (products?.stages || []).map((stage) => normalizeText(stage?.stageName || stage?.name));
      const commonStages = (products?.commonStages || []).map((stage) => normalizeText(stage?.stageName || stage?.name || stage?.stage));
      const mergedStages = [...productStages, ...commonStages];
      const lastProductStage = productStages[productStages.length - 1] || "";
      const lastStage = mergedStages[mergedStages.length - 1] || "";
      const nextIndex = getNextIndex(rawAssignedStages, currentIndex);

      data.stageName = currentStageName;
      data.currentLogicalStage = currentStageName;
      data.currentSeatKey = currentSeatKey;

      const eligibilityStart = Date.now();
      const eligibility = await resolvePreviousStageEligibility({
        processStages: products?.stages || [],
        currentStageName,
        serialNo: data.serialNo,
        deviceCurrentStage: deviceSnapshot?.currentStage || "",
        planId: data.planId,
        processId: resolvedProcessId,
      });
      markTiming("eligibilityMs", eligibilityStart);
      if (!eligibility.isEligible) {
        return res.status(409).json({
          status: 409,
          message: eligibility.message || "Previous stage must be passed before testing this device.",
        });
      }

      const parallelSeats = getParallelSeatEntries({
        assignedStages: normalizedAssignedStages,
        stageName: currentStageName,
        lineIndex: currentSeatStage?.lineIndex,
        parallelGroupKey: currentSeatStage?.parallelGroupKey,
      });
      if (parallelSeats.length > 1) {
        const seatConflictStart = Date.now();
        const latestRecordQuery = { serialNo: data.serialNo };
        if (data.planId && mongoose.Types.ObjectId.isValid(data.planId)) {
          latestRecordQuery.planId = new mongoose.Types.ObjectId(data.planId);
        }
        if (resolvedProcessId && mongoose.Types.ObjectId.isValid(resolvedProcessId)) {
          latestRecordQuery.processId = new mongoose.Types.ObjectId(resolvedProcessId);
        }
        const latestSeatRecord = await deviceTestRecords
          .findOne(latestRecordQuery)
          .sort({ createdAt: -1 })
          .select("assignedSeatKey currentSeatKey nextLogicalStage currentLogicalStage currentStage stageName status createdAt")
          .lean();
        markTiming("seatConflictMs", seatConflictStart);

        const claimedSeatKey = getClaimedSeatKey(latestSeatRecord, currentStageName);
        if (claimedSeatKey && claimedSeatKey !== currentSeatKey) {
          return res.status(409).json({
            status: 409,
            message: `This device is assigned to seat ${claimedSeatKey} for ${currentStageName}.`,
            conflictSeatKey: claimedSeatKey,
          });
        }
      }

      let nextSeatRouting = {
        nextLogicalStage: "",
        assignedSeatKey: "",
        assignedStageInstanceId: "",
        assignedParallelGroupKey: "",
      };

      if (actionMeta.actionStatus === "Pass") {
        nextSeatRouting = chooseNextStageSeatAssignment({
          assignedStages: normalizedAssignedStages,
          currentSeatKey,
          currentStageName,
          processStages: products?.stages || [],
          commonStages: products?.commonStages || [],
        });
      }

      data.nextLogicalStage = nextSeatRouting.nextLogicalStage || "";
      data.assignedSeatKey = nextSeatRouting.assignedSeatKey || data.assignedSeatKey || "";
      data.assignedStageInstanceId = nextSeatRouting.assignedStageInstanceId || data.assignedStageInstanceId || "";
      data.assignedParallelGroupKey = nextSeatRouting.assignedParallelGroupKey || data.assignedParallelGroupKey || "";

      const currentSeatStageEntry = rawSeatStages[targetStageIdx] || rawSeatStages[0] || {};
      let pendingNgPayload = null;
      if (actionMeta.actionStatus === "Pass") {
        if (Number(currentSeatStageEntry?.totalUPHA || 0) > 0) {
          currentSeatStageEntry.totalUPHA = Number(currentSeatStageEntry.totalUPHA || 0) - 1;
        }
        currentSeatStageEntry.passedDevice = Number(currentSeatStageEntry?.passedDevice || 0) + 1;

        if (currentStageName === lastProductStage && commonStages.length > 0) {
          const commonStageName = commonStages[0];
          const existingCommonIndex = assignedCustomStagesOp.findIndex(
            (stage) => normalizeKey(getStageLabel(stage)) === normalizeKey(commonStageName),
          );
          if (existingCommonIndex >= 0) {
            assignedCustomStagesOp[existingCommonIndex].totalUPHA = Number(assignedCustomStagesOp[existingCommonIndex]?.totalUPHA || 0) + 1;
          } else {
            assignedCustomStagesOp.push({
              name: commonStageName,
              totalUPHA: 1,
              passedDevice: 0,
              ngDevice: 0,
            });
          }
        } else if (nextSeatRouting.assignedSeatKey && rawAssignedStages[nextSeatRouting.assignedSeatKey]) {
          const targetSeatStages = toStageArray(rawAssignedStages[nextSeatRouting.assignedSeatKey]);
          const targetSeatStageIdx = targetSeatStages.findIndex(
            (stage) => normalizeKey(getStageLabel(stage)) === normalizeKey(nextSeatRouting.nextLogicalStage),
          );
          if (targetSeatStageIdx >= 0) {
            targetSeatStages[targetSeatStageIdx].totalUPHA = Number(targetSeatStages[targetSeatStageIdx]?.totalUPHA || 0) + 1;
            rawAssignedStages[nextSeatRouting.assignedSeatKey] = targetSeatStages;
          }
        } else if (nextIndex && rawAssignedStages[nextIndex] && toStageArray(rawAssignedStages[nextIndex])[0]) {
          const nextSeatStages = toStageArray(rawAssignedStages[nextIndex]);
          nextSeatStages[0].totalUPHA = Number(nextSeatStages[0]?.totalUPHA || 0) + 1;
          rawAssignedStages[nextIndex] = nextSeatStages;
        }
      } else {
        if (Number(currentSeatStageEntry?.totalUPHA || 0) > 0) {
          currentSeatStageEntry.totalUPHA = Number(currentSeatStageEntry.totalUPHA || 0) - 1;
        }
        currentSeatStageEntry.ngDevice = Number(currentSeatStageEntry?.ngDevice || 0) + 1;

        data.assignedDeviceTo = assignedDeviceTo;
        if (assignedDeviceTo === "QC" || assignedDeviceTo === "TRC") {
          const notes = normalizeText(data.ngDescription || data?.logData?.description || "");
          pendingNgPayload = {
            processId: resolvedProcessId || null,
            userId: data.operatorId || data.userId || null,
            department: assignedDeviceTo,
            serialNo: data.serialNo || "",
            ngStage: currentStageName || data.ngStage || "",
            ...(notes ? { notes } : {}),
          };
        } else if (assignedDeviceTo) {
          const targetKey = Object.keys(rawAssignedStages).find((key) => {
            const stageEntries = toStageArray(rawAssignedStages[key]);
            return stageEntries.some((stage) => normalizeKey(getStageLabel(stage)) === normalizeKey(assignedDeviceTo));
          });
          if (targetKey) {
            const targetStageEntries = toStageArray(rawAssignedStages[targetKey]);
            const targetIdx = targetStageEntries.findIndex(
              (stage) => normalizeKey(getStageLabel(stage)) === normalizeKey(assignedDeviceTo),
            );
            if (targetIdx !== -1) {
              targetStageEntries[targetIdx].totalUPHA = Number(targetStageEntries[targetIdx]?.totalUPHA || 0) + 1;
              rawAssignedStages[targetKey] = targetStageEntries;
            }
          }
        }
      }

      rawSeatStages[targetStageIdx] = currentSeatStageEntry;
      rawAssignedStages[currentIndex] = rawSeatStages;
      if (currentStageName === "FG to Store") {
        planing.consumedKit = Number(planing.consumedKit || 0) + 1;
      }
      if (currentStageName === lastStage && rawAssignedStages[currentIndex]?.[0]) {
        rawAssignedStages[currentIndex][0].totalUPHA = Number(rawAssignedStages[currentIndex][0]?.totalUPHA || 0) - 1;
      }
      planing.assignedStages = JSON.stringify(rawAssignedStages);
      planing.assignedCustomStagesOp = JSON.stringify(assignedCustomStagesOp);

      const getSequentialNextStage = (fromStageName = "") => {
        const normalizedFrom = normalizeKey(fromStageName);
        if (!normalizedFrom) return "";

        const processStagesList = Array.isArray(products?.stages) ? products.stages : [];
        const commonStagesList = Array.isArray(products?.commonStages) ? products.commonStages : [];

        const processIdx = processStagesList.findIndex(
          (stage) => normalizeKey(stage?.stageName || stage?.name) === normalizedFrom,
        );
        if (processIdx >= 0) {
          if (processIdx < processStagesList.length - 1) {
            return normalizeText(processStagesList[processIdx + 1]?.stageName || processStagesList[processIdx + 1]?.name);
          }
          return normalizeText(commonStagesList[0]?.stageName || commonStagesList[0]?.name || commonStagesList[0]?.stage);
        }

        const commonIdx = commonStagesList.findIndex(
          (stage) => normalizeKey(stage?.stageName || stage?.name || stage?.stage) === normalizedFrom,
        );
        if (commonIdx >= 0 && commonIdx < commonStagesList.length - 1) {
          return normalizeText(
            commonStagesList[commonIdx + 1]?.stageName ||
            commonStagesList[commonIdx + 1]?.name ||
            commonStagesList[commonIdx + 1]?.stage,
          );
        }

        return "";
      };

      const deviceUpdatePayload = { updatedAt: new Date() };
      let shouldUpdateDevice = false;

      // Extract identification data (IMEI, CCID) from logs to promote to root-level device fields
      if (Array.isArray(logs) && logs.length > 0) {
        logs.forEach(log => {
          const parsed = log.logData?.parsedData;
          if (parsed && typeof parsed === "object") {
            Object.keys(parsed).forEach(k => {
              const key = String(k || "").toLowerCase();
              const val = String(parsed[k] || "").trim();
              if (!val) return;

              if (key === "imei" || key === "imeino") {
                deviceUpdatePayload.imeiNo = val;
                shouldUpdateDevice = true;
              } else if (key === "ccid" || key === "iccid") {
                deviceUpdatePayload.ccid = val;
                shouldUpdateDevice = true;
              } else if (key === "modelname" || key === "model_name") {
                deviceUpdatePayload.modelName = val;
                shouldUpdateDevice = true;
              }
            });
          }
        });
      }

      if (actionMeta.actionStatus === "Pass") {
        let targetStageName = normalizeText(nextSeatRouting.nextLogicalStage || "");

        // Fallback: derive next stage directly from process/common stage order
        // when seat routing is missing or resolves to the same current stage.
        if (
          !targetStageName ||
          normalizeKey(targetStageName) === normalizeKey(currentStageName)
        ) {
          const sequentialFromCurrent = getSequentialNextStage(currentStageName);
          const sequentialFromDeviceStage = getSequentialNextStage(deviceSnapshot?.currentStage || "");
          targetStageName = normalizeText(
            sequentialFromCurrent ||
            sequentialFromDeviceStage ||
            targetStageName ||
            currentStageName,
          );
        }

        if (!data.nextLogicalStage && targetStageName) {
          data.nextLogicalStage = targetStageName;
        }

        if (targetStageName) {
          deviceUpdatePayload.currentStage = targetStageName;
          shouldUpdateDevice = true;
        }
      } else if (assignedDeviceTo && assignedDeviceTo !== "QC" && assignedDeviceTo !== "TRC") {
        deviceUpdatePayload.currentStage = assignedDeviceTo;
        deviceUpdatePayload.status = "Rework";

        // Root-level identification persistence on rework/NG assignment
        if (data.imeiNo) deviceUpdatePayload.imeiNo = String(data.imeiNo).trim();
        if (data.ccid) deviceUpdatePayload.ccid = String(data.ccid).trim();
        if (data.modelName) deviceUpdatePayload.modelName = String(data.modelName).trim();

        shouldUpdateDevice = true;
      }
      let savedDeviceTestRecord = null;
      const writeSession = await mongoose.startSession();
      try {
        await writeSession.withTransaction(async () => {
          const planUpdateStart = Date.now();
          const updateResult = await planingAndScheduling.updateOne(
            { _id: data.planId },
            {
              $set: {
                assignedStages: planing.assignedStages,
                consumedKit: planing.consumedKit,
                assignedCustomStagesOp: planing.assignedCustomStagesOp,
              },
            },
            { session: writeSession },
          );
          markTiming("planUpdateMs", planUpdateStart);
          if (!updateResult?.acknowledged || !updateResult?.matchedCount) {
            throw new Error("Error updating planing data.");
          }

          const deviceUpdateStart = Date.now();
          if (shouldUpdateDevice) {
            const deviceUpdateResult = await deviceModel.updateOne(
              { _id: deviceSnapshot._id },
              { $set: deviceUpdatePayload },
              { session: writeSession },
            );
            markTiming("deviceUpdateMs", deviceUpdateStart);
            if (!deviceUpdateResult?.acknowledged || !deviceUpdateResult?.matchedCount) {
              throw new Error("Error updating device stage.");
            }
          } else {
            markTiming("deviceUpdateMs", deviceUpdateStart);
          }

          const recordSaveStart = Date.now();
          savedDeviceTestRecord = await new deviceTestRecords(data).save({ session: writeSession });
          markTiming("recordSaveMs", recordSaveStart);

          if (
            pendingNgPayload &&
            pendingNgPayload.processId &&
            pendingNgPayload.userId &&
            pendingNgPayload.serialNo
          ) {
            const ngSaveStart = Date.now();
            await new NGDevice(pendingNgPayload).save({ session: writeSession });
            markTiming("ngSaveMs", ngSaveStart);
          }
        });
      } finally {
        await writeSession.endSession();
      }

      if (actionMeta.actionStatus === "NG" && assignedDeviceTo && assignedDeviceTo !== "QC" && assignedDeviceTo !== "TRC") {
        const attemptFilter = { deviceId: deviceSnapshot._id };
        if (data.planId && mongoose.Types.ObjectId.isValid(data.planId)) {
          attemptFilter.planId = new mongoose.Types.ObjectId(data.planId);
        }
        if (resolvedProcessId && mongoose.Types.ObjectId.isValid(resolvedProcessId)) {
          attemptFilter.processId = new mongoose.Types.ObjectId(resolvedProcessId);
        }
        DeviceAttempt.updateMany(
          attemptFilter,
          { $set: { attemptCount: 0, stageAttempts: {}, lastAttemptAt: new Date() } },
        ).catch((error) => {
          console.warn("Failed to reset attempt count on rework:", error);
        });
      }

      timings.totalMs = Date.now() - requestStartedAt;
      logOperatorPassTimings(timings, {
        actionStatus: actionMeta.actionStatus,
        planId: data.planId || "",
        processId: resolvedProcessId || "",
        seatKey: currentIndex,
        stageName: currentStageName,
        branch: "seat-stage",
      });

      return res.status(200).json({
        status: 200,
        message: actionMeta.message,
        actionStatus: actionMeta.actionStatus,
        resultType: actionMeta.resultType,
        data: {
          ...buildCompactDeviceTestRecord(savedDeviceTestRecord),
          actionStatus: actionMeta.actionStatus,
          resultType: actionMeta.resultType,
        },
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  registerDeviceAttempt: async (req, res) => {
    try {
      const { deviceId, serialNo, planId, processId, operatorId, stageName } = req.body || {};

      if (!planId || !processId) {
        return res.status(400).json({
          status: 400,
          message: "planId and processId are required",
        });
      }

      let resolvedDeviceId = deviceId;
      if (!resolvedDeviceId && serialNo) {
        const query = { serialNo: String(serialNo).trim() };
        if (processId) query.processID = processId;
        const device = await deviceModel.findOne(query).lean();
        if (!device?._id) {
          return res.status(404).json({
            status: 404,
            message: "Device not found for provided serialNo",
          });
        }
        resolvedDeviceId = device._id;
      }

      if (!resolvedDeviceId || !mongoose.Types.ObjectId.isValid(resolvedDeviceId)) {
        return res.status(400).json({
          status: 400,
          message: "Valid deviceId or serialNo is required",
        });
      }

      let resolvedStageName = String(stageName || "").trim();
      if (!resolvedStageName) {
        try {
          let deviceDoc = null;
          if (deviceId && mongoose.Types.ObjectId.isValid(deviceId)) {
            deviceDoc = await deviceModel.findById(deviceId).select("currentStage").lean();
          } else if (serialNo) {
            deviceDoc = await deviceModel.findOne({ serialNo }).select("currentStage").lean();
          }
          resolvedStageName = String(deviceDoc?.currentStage || "").trim();
        } catch (e) {
          resolvedStageName = "";
        }
      }

      const normalizedStageName = resolvedStageName;
      const stageKey = Buffer.from(
        normalizedStageName.length > 0 ? normalizedStageName : "__default__"
      ).toString("base64url");

      const attempt = await DeviceAttempt.findOneAndUpdate(
        {
          deviceId: new mongoose.Types.ObjectId(resolvedDeviceId),
          planId: new mongoose.Types.ObjectId(planId),
          processId: new mongoose.Types.ObjectId(processId),
        },
        {
          $inc: {
            attemptCount: 1,
            [`stageAttempts.${stageKey}`]: 1,
          },
          $set: { lastAttemptAt: new Date(), stageName: normalizedStageName },
          ...(operatorId ? { $setOnInsert: { operatorId } } : {}),
        },
        { new: true, upsert: true }
      );

      const stageAttempts = attempt?.stageAttempts || {};
      const stageAttemptCount =
        typeof stageAttempts?.get === "function"
          ? stageAttempts.get(stageKey) || 0
          : stageAttempts?.[stageKey] || 0;

      return res.status(200).json({
        status: 200,
        message: "Attempt registered",
        attemptCount: stageAttemptCount,
        totalAttemptCount: attempt?.attemptCount || 0,
        deviceId: attempt?.deviceId,
        stageName: attempt?.stageName || "",
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Error registering device attempt",
        error: error.message,
      });
    }
  },
  getOverallDeviceTestEntry: async (req, res) => {
    try {
      const pageRaw = req.query.page;
      const limitRaw = req.query.limit;
      const statusRaw = req.query.status || req.query.onlyNg;
      const shouldPaginate = pageRaw || limitRaw;
      const statusFilter =
        String(statusRaw || "").toLowerCase() === "ng"
          ? { status: { $regex: /^NG$/i } }
          : {};
      const projection = {
        deviceId: 1,
        processId: 1,
        operatorId: 1,
        serialNo: 1,
        stageName: 1,
        status: 1,
        assignedDeviceTo: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      let DeviceTestEntry;
      let meta;
      if (shouldPaginate) {
        const page = Math.max(parseInt(pageRaw) || 1, 1);
        const limit = Math.min(Math.max(parseInt(limitRaw) || 100, 1), 1000);
        const skip = (page - 1) * limit;
        const [entries, total] = await Promise.all([
          deviceTestRecords
            .find(statusFilter, projection, { sort: { createdAt: -1 } })
            .populate({ path: "deviceId", select: "serialNo modelName status currentStage" })
            .populate({ path: "processId", select: "name processName" })
            .skip(skip)
            .limit(limit)
            .lean(),
          deviceTestRecords.countDocuments(statusFilter),
        ]);
        DeviceTestEntry = entries;
        meta = { page, limit, total };
      } else {
        DeviceTestEntry = await deviceTestRecords
          .find(statusFilter, projection, { sort: { createdAt: -1 } })
          .populate({ path: "deviceId", select: "serialNo modelName status currentStage" })
          .populate({ path: "processId", select: "name processName" })
          .lean();
      }
      return res.status(200).json({
        status: 200,
        status_msg: "Device Test Entry Fetched Sucessfully!!",
        DeviceTestEntry,
        ...(meta ? { meta } : {}),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  getDeviceTestEntryByOperatorId: async (req, res) => {
    try {
      console.log(">>> [DEBUG]: getDeviceTestEntryByOperatorId - id:", req.params.id, "query:", req.query);
      const id = req.params.id;
      const { date, startDate, endDate, serialNo } = req.query;

      let query = { operatorId: id };
      let startOfDay, endOfDay;

      if (serialNo) {
        query.serialNo = { $regex: serialNo, $options: "i" };
      }

      if (date) {
        const targetDate = new Date(date);
        startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        query.createdAt = {
          $gte: startOfDay,
          $lte: endOfDay,
        };
      } else if (startDate && endDate) {
        startOfDay = new Date(startDate);
        startOfDay.setHours(0, 0, 0, 0);
        endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        query.createdAt = {
          $gte: startOfDay,
          $lte: endOfDay,
        };
      }

      const deviceTestRecord = await deviceTestRecords
        .find(query, null, { sort: { createdAt: -1 } })
        .populate("deviceId")
        .populate("operatorId", "name employeeCode")
        .populate("productId", "name")
        .populate("planId", "processName")
        .lean();

      if (deviceTestRecord.length === 0) {
        return res.status(200).json({
          status: 200,
          message: "No device records found",
          data: [],
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Device records retrieved successfully",
        data: deviceTestRecord.map((record) => {
          const device = resolveDeviceIdentity(record.deviceId);
          return {
            ...record,
            deviceInfo: device,
            imeiNo: device?.imeiNo || record.imeiNo,
          };
        }),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },

  getDeviceTestHistoryByDeviceId: async (req, res) => {
    try {
      let id = req.params.deviceId;

      let deviceTestHistory = await deviceTestRecords
        .find({ deviceId: id }, null, { sort: { createdAt: -1 } })
        .populate("deviceId")
        .populate("operatorId", "name employeeCode")
        .populate("productId", "name")
        .populate("planId", "processName")
        .lean();



      if (deviceTestHistory.length === 0) {
        return res.status(200).json({
          status: 200,
          message: "No devices record history found for the given Product ID",
          data: [],
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Devices Record retrieved successfully",
        data: deviceTestHistory.map((record) => {
          const device = resolveDeviceIdentity(record.deviceId);
          return {
            ...record,
            deviceInfo: device,
            imeiNo: device?.imeiNo || record.imeiNo,
          };
        }),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },

  getOverallProcessByOperatorId: async (req, res) => {
    try {
      const { planId, operatorId } = req.params;
      const devices = await deviceTestRecords
        .find({ planId, operatorId })
        .populate("operatorId", "name employeeCode")
        .populate("productId", "name")
        .populate("planId", "processName")
        .lean();

      if (devices.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "No devices found for the given plan and operator.",
        });
      }
      res.status(200).json({
        status: 200,
        message: "Overall process retrieved successfully!",
        data: devices,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "An error occurred while retrieving the process.",
        error: error.message,
      });
    }
  },
  getDeviceTestTrends: async (req, res) => {
    try {
      const interval = (req.query.interval || "day").toLowerCase();
      const days = Math.max(parseInt(req.query.days, 10) || 7, 1);
      const hours = Math.max(parseInt(req.query.hours, 10) || 24, 1);
      const { operatorId, processId } = req.query;

      const match = {};
      if (operatorId && mongoose.Types.ObjectId.isValid(operatorId)) {
        match.operatorId = new mongoose.Types.ObjectId(operatorId);
      }
      if (processId && mongoose.Types.ObjectId.isValid(processId)) {
        match.processId = new mongoose.Types.ObjectId(processId);
      }

      let start;
      let format;
      if (interval === "hour") {
        start = new Date();
        start.setHours(start.getHours() - (hours - 1), 0, 0, 0);
        format = "%Y-%m-%d %H:00";
      } else {
        start = new Date();
        start.setDate(start.getDate() - (days - 1));
        start.setHours(0, 0, 0, 0);
        format = "%Y-%m-%d";
      }
      match.createdAt = { $gte: start };

      const trend = await deviceTestRecords.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              bucket: { $dateToString: { format, date: "$createdAt" } },
              status: { $toUpper: "$status" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.bucket": 1 } },
      ]);

      const buckets = {};
      trend.forEach((row) => {
        const key = row._id.bucket;
        if (!buckets[key]) buckets[key] = { Pass: 0, NG: 0 };
        if (row._id.status === "PASS") buckets[key].Pass = row.count;
        if (row._id.status === "NG") buckets[key].NG = row.count;
      });

      const categories = [];
      const passData = [];
      const ngData = [];
      if (interval === "hour") {
        for (let i = 0; i < hours; i += 1) {
          const d = new Date(start);
          d.setHours(start.getHours() + i, 0, 0, 0);
          const key = d.toISOString().slice(0, 13).replace("T", " ") + ":00";
          categories.push(key);
          passData.push(buckets[key]?.Pass || 0);
          ngData.push(buckets[key]?.NG || 0);
        }
      } else {
        for (let i = 0; i < days; i += 1) {
          const d = new Date(start);
          d.setDate(start.getDate() + i);
          const key = d.toISOString().slice(0, 10);
          categories.push(key);
          passData.push(buckets[key]?.Pass || 0);
          ngData.push(buckets[key]?.NG || 0);
        }
      }

      return res.status(200).json({
        status: 200,
        message: "Device test trends fetched successfully",
        categories,
        series: [
          { name: "Pass", data: passData },
          { name: "NG", data: ngData },
        ],
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getNGReasonDistribution: async (req, res) => {
    try {
      const days = Math.max(parseInt(req.query.days, 10) || 30, 1);
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      start.setHours(0, 0, 0, 0);

      const dist = await NGDevice.aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: "$ngStage", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);

      return res.status(200).json({
        status: 200,
        message: "NG distribution fetched successfully",
        labels: dist.map((d) => d._id || "Unknown"),
        series: dist.map((d) => d.count),
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  searchByJigFields: async (req, res) => {
    try {
      const { jigFields, processId, stageName } = req.body;
      if (!jigFields || typeof jigFields !== 'object') {
        return res.status(400).json({ status: 400, message: "Invalid jigFields" });
      }

      const scanTokens = parseStickerScanTokensFromJigFields(jigFields);
      if (!scanTokens.length) {
        return res.status(400).json({ status: 400, message: "No search values provided" });
      }

      const query = {
        ...(processId ? { processID: processId } : {}),
        ...(stageName ? { currentStage: stageName } : {}),
        status: { $nin: ["Pass", "Completed", "NG"] },
      };

      const devices = await deviceModel.find(query)
        .select("_id serialNo imeiNo customFields modelName status currentStage processID productType flowVersion flowStartedAt")
        .lean();

      const matchingDevices = findDevicesByScanTokensStrict(devices, scanTokens);

      if (matchingDevices.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "No device matched the scanned sticker values.",
        });
      }

      if (matchingDevices.length > 1) {
        return res.status(409).json({
          status: 409,
          message: "Multiple devices matched the scanned sticker values. Please scan a more specific sticker.",
          data: {
            matchedTokens: scanTokens,
            matchMode: scanTokens.length > 1 ? "multi" : "single",
          },
        });
      }

      const matchedResult = matchingDevices[0];

      return res.status(200).json({
        status: 200,
        data: matchedResult.device,
        matchedTokens: matchedResult.matchedTokens,
        matchedFields: matchedResult.matchedFields,
        matchMode: matchedResult.matchMode,
      });
    } catch (error) {
      console.error("Error in searchByJigFields:", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateStageBySerialNo: async (req, res) => {
    try {
      const serialNo = req.params.serialNo || req.body.serialNo;
      const updates = req.body || {};
      const device = await deviceModel.findOne({ serialNo }).select("_id serialNo currentStage customFields processID modelName").lean();

      if (!device?._id) {
        return res.status(404).json({ message: "Device with serial number not found" });
      }

      // Root-level identification fields persistence
      if (req.body.imeiNo) updates.imeiNo = String(req.body.imeiNo).trim();
      if (req.body.ccid) updates.ccid = String(req.body.ccid).trim();

      // Auto-populate modelName from Order Confirmation if missing or empty
      if (!device.modelName && device.processID) {
        const processDoc = await processModel.findById(device.processID).select("orderConfirmationNo").lean();
        if (processDoc?.orderConfirmationNo) {
          const ocDoc = await OrderConfirmationModel.findOne({ orderConfirmationNo: processDoc.orderConfirmationNo }).select("modelName").lean();
          if (ocDoc?.modelName) {
            updates.modelName = ocDoc.modelName;
          }
        }
      }


      if (updates.customFields) {
        let incomingCustomFields = updates.customFields;
        if (typeof incomingCustomFields === "string") {
          try {
            incomingCustomFields = JSON.parse(incomingCustomFields);
          } catch (error) {
            incomingCustomFields = {};
          }
        }

        const currentStageName = updates.currentStage || device.currentStage || "Unknown Stage";
        let existingCustomFields = device.customFields || {};
        if (typeof existingCustomFields !== "object" || Array.isArray(existingCustomFields)) {
          existingCustomFields = {};
        }
        existingCustomFields[currentStageName] = {
          ...(existingCustomFields[currentStageName] || {}),
          ...incomingCustomFields,
        };
        updates.customFields = existingCustomFields;
      }

      const updateResult = await deviceModel.updateOne({ _id: device._id }, { $set: updates });
      if (!updateResult?.acknowledged || !updateResult?.matchedCount) {
        return res.status(404).json({ message: "Device not found" });
      }
      return res.status(200).json({
        status: 200,
        message: "Device updated successfully",
        data: {
          _id: device._id,
          serialNo: device.serialNo,
          currentStage: updates.currentStage || device.currentStage || "",
          status: updates.status || "",
        },
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  updateStageByDeviceId: async (req, res) => {
    try {
      const deviceId = req.params.deviceId;
      const updates = req.body || {};
      const device = await deviceModel.findById(deviceId).select("_id serialNo currentStage customFields processID modelName").lean();
      if (!device?._id) {
        return res.status(404).json({ message: "Device not found" });
      }

      // Root-level identification fields persistence
      if (req.body.imeiNo) updates.imeiNo = String(req.body.imeiNo).trim();
      if (req.body.ccid) updates.ccid = String(req.body.ccid).trim();

      // Auto-populate modelName from Order Confirmation if missing or empty
      if (!device.modelName && device.processID) {
        const processDoc = await processModel.findById(device.processID).select("orderConfirmationNo").lean();
        if (processDoc?.orderConfirmationNo) {
          const ocDoc = await OrderConfirmationModel.findOne({ orderConfirmationNo: processDoc.orderConfirmationNo }).select("modelName").lean();
          if (ocDoc?.modelName) {
            updates.modelName = ocDoc.modelName;
          }
        }
      }


      if (updates.customFields) {
        let incomingCustomFields = updates.customFields;
        if (typeof incomingCustomFields === "string") {
          try {
            incomingCustomFields = JSON.parse(incomingCustomFields);
          } catch (error) {
            incomingCustomFields = {};
          }
        }

        const currentStageName = updates.currentStage || device.currentStage || "Unknown Stage";
        let existingCustomFields = device.customFields || {};
        if (typeof existingCustomFields !== "object" || Array.isArray(existingCustomFields)) {
          existingCustomFields = {};
        }
        existingCustomFields[currentStageName] = {
          ...(existingCustomFields[currentStageName] || {}),
          ...incomingCustomFields,
        };
        updates.customFields = existingCustomFields;
      }

      const updateResult = await deviceModel.updateOne({ _id: device._id }, { $set: updates });
      if (!updateResult?.acknowledged || !updateResult?.matchedCount) {
        return res.status(404).json({ message: "Device not found" });
      }

      if (updates.status && String(updates.status).toLowerCase().includes("resolved")) {
        try {
          await DeviceAttempt.updateMany(
            { deviceId: device._id },
            { $set: { attemptCount: 0, stageAttempts: {}, lastAttemptAt: new Date() } }
          );
        } catch (error) {
          console.warn("Failed to reset attempt count on resolved update:", error);
        }
      }

      return res.status(200).json({
        status: 200,
        message: "Device updated successfully",
        data: {
          _id: device._id,
          serialNo: device.serialNo,
          currentStage: updates.currentStage || device.currentStage || "",
          status: updates.status || "",
        },
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },
  markAsResolved: async (req, res) => {
    try {
      const { deviceId, serialNumber, serialNo } = req.body;

      if (!deviceId || !(serialNumber || serialNo)) {
        return res.status(400).json({ message: "deviceId and serialNumber are required" });
      }

      if (!mongoose.Types.ObjectId.isValid(deviceId)) {
        return res.status(400).json({ message: "Invalid deviceId" });
      }

      const device = await deviceModel.findById(deviceId);
      if (!device) {
        return res.status(404).json({ message: "Device not found" });
      }

      const incomingSerial = serialNumber || serialNo;
      if (device.serialNo !== incomingSerial) {
        return res.status(400).json({ message: "Serial number does not match the device" });
      }

      const process = await processModel.findById(device.processID);
      if (!process) {
        return res.status(404).json({ message: "Process not found for device" });
      }

      const firstStageName = Array.isArray(process.stages) && process.stages.length > 0
        ? (process.stages[0]?.stageName || "")
        : "";

      const selectedStage = req.body.currentStage || req.body.nextStage || req.body.selectedStage || "";

      const incomingStatus = req.body.status || "QC Resolved";
      const isTRC = (incomingStatus || "").toUpperCase().includes("TRC") || !!req.body.trcRemarks;
      let parsedTrcRemarks = undefined;
      if (req.body.trcRemarks) {
        try {
          parsedTrcRemarks = typeof req.body.trcRemarks === "string"
            ? JSON.parse(req.body.trcRemarks)
            : req.body.trcRemarks;
        } catch (e) {
          parsedTrcRemarks = { parseError: true, raw: req.body.trcRemarks };
        }
      }
      const testRecordPayload = {
        deviceId: device._id,
        processId: device.processID,
        serialNo: device.serialNo,
        stageName: isTRC ? "TRC" : "QC",
        status: incomingStatus,
        assignedDeviceTo: isTRC ? "TRC" : "QC",
        flowVersion: Number(device.flowVersion || 1),
        flowBoundary: false,
        flowType: "resolve",
        previousFlowVersion: null,
        ...(isTRC ? { trcRemarks: parsedTrcRemarks ? [parsedTrcRemarks] : [] } : {}),
      };

      const testRecord = new deviceTestRecords(testRecordPayload);
      const savedRecord = await testRecord.save();

      const nextStage = selectedStage || device.currentStage || firstStageName;
      const updatedDevice = await deviceModel.findByIdAndUpdate(
        device._id,
        { $set: { status: incomingStatus || "", currentStage: nextStage } },
        { new: true, runValidators: true }
      );

      try {
        await DeviceAttempt.updateMany(
          { deviceId: device._id },
          { $set: { attemptCount: 0, stageAttempts: {}, lastAttemptAt: new Date() } }
        );
      } catch (e) {
        console.warn("Failed to reset attempt count on resolve:", e);
      }

      return res.status(200).json({
        status: 200,
        message: "Device marked as resolved",
        data: {
          device: updatedDevice,
          testRecord: savedRecord,
        },
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getDeviceTestHistoryByOperatorId: async (req, res) => {
    try {
      const id = req.params.id;
      const { date, startDate, endDate, serialNo } = req.query;

      let query = { operatorId: id };

      if (serialNo) {
        query.serialNo = { $regex: serialNo, $options: "i" };
      }

      if (date) {
        const targetDate = new Date(date);
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: startOfDay, $lte: endOfDay };
      } else if (startDate && endDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: start, $lte: end };
      }

      const deviceTestRecord = await deviceTestRecords
        .find(query)
        .populate("operatorId", "name employeeCode")
        .populate("productId", "name")
        .populate("planId", "processName")
        .sort({ createdAt: -1 });

      if (deviceTestRecord.length === 0) {
        return res.status(200).json({
          status: 200,
          message: "No device records found",
          data: [],
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Device records retrieved successfully",
        data: deviceTestRecord,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        error: error.message,
      });
    }
  },

  getDeviceById: async (req, res) => {
    try {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid deviceId" });
      }
      const device = await deviceModel
        .findById(id)
        .populate("productType", "name")
        .populate("processID", "processName pid processID")
        .lean();

      if (!device) {
        return res.status(404).json({ status: 404, message: "Device not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "Device fetched successfully",
        data: device
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  seedStageHistory: async (req, res) => {
    try {
      const { processId, serials, stages, stageOperatorMap } = req.body || {};

      if (!processId || !mongoose.Types.ObjectId.isValid(processId)) {
        return res.status(400).json({ status: 400, message: "Valid processId is required" });
      }
      if (!Array.isArray(serials) || serials.length === 0) {
        return res.status(400).json({ status: 400, message: "serials must be a non-empty array" });
      }
      if (!Array.isArray(stages) || stages.length === 0) {
        return res.status(400).json({ status: 400, message: "stages must be a non-empty array" });
      }
      if (!stageOperatorMap || typeof stageOperatorMap !== "object") {
        return res.status(400).json({ status: 400, message: "stageOperatorMap is required" });
      }

      const requester = await User.findById(req.user.id).lean();
      if (!requester || String(requester.userType || "").toLowerCase() !== "admin") {
        return res.status(403).json({ status: 403, message: "Only admin can seed stage history" });
      }

      const devices = await deviceModel.find({
        serialNo: { $in: serials },
        processID: processId,
      });

      if (!devices || devices.length === 0) {
        return res.status(404).json({ status: 404, message: "No matching devices found" });
      }

      await deviceModel.updateMany(
        { _id: { $in: devices.map((d) => d._id) } },
        {
          $set: {
            currentStage: "Packaging",
            status: "Pass",
            flowVersion: 1,
            flowStartedAt: null,
            updatedAt: new Date(),
          },
        }
      );

      await deviceTestRecords.deleteMany({
        processId: new mongoose.Types.ObjectId(processId),
        serialNo: { $in: serials },
        stageName: { $in: stages },
      });

      const now = new Date();
      const testRecords = [];
      devices.forEach((device) => {
        stages.forEach((stageName, idx) => {
          const operatorId = stageOperatorMap[stageName];
          if (!operatorId || !mongoose.Types.ObjectId.isValid(operatorId)) {
            throw new Error(`Missing/invalid operatorId for stage: ${stageName}`);
          }
          testRecords.push({
            deviceId: device._id,
            processId: new mongoose.Types.ObjectId(processId),
            operatorId: new mongoose.Types.ObjectId(operatorId),
            serialNo: device.serialNo,
            stageName,
            status: "Pass",
            assignedDeviceTo: "Operator",
            flowVersion: 1,
            flowBoundary: false,
            flowType: "stage",
            previousFlowVersion: null,
            timeConsumed: "00:01:00",
            startTime: new Date(now.getTime() + idx * 60000),
            endTime: new Date(now.getTime() + (idx + 1) * 60000),
            logs: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        });
      });

      const insertResult = await deviceTestRecords.insertMany(testRecords);

      return res.status(200).json({
        status: 200,
        message: "Stage history seeded successfully",
        devicesUpdated: devices.length,
        recordsInserted: insertResult.length,
      });

  getDeviceComprehensiveHistory: async (req, res) => {
    try {
      const { query } = req.query;
      if (!query) {
        return res.status(400).json({ status: 400, message: "Search query is required" });
      }

      const searchStr = String(query).trim();

      // 1. Search for device by multiple fields including nested customFields
      // We use an aggregation to allow searching within the dynamic keys of customFields
      let devices = await deviceModel.aggregate([
        {
          $match: {
            $or: [
              { serialNo: searchStr },
              { imeiNo: searchStr },
              { ccid: searchStr },
              { cartonSerial: searchStr },
              // Fallback: search within customFields if the string looks like an identifier
              // We check if any stage in customFields has an IMEI or CCID matching searchStr
              {
                $expr: {
                  $gt: [
                    {
                      $size: {
                        $filter: {
                          input: {
                            $cond: {
                              if: { $eq: [{ $type: "$customFields" }, "object"] },
                              then: { $objectToArray: "$customFields" },
                              else: []
                            }
                          },
                          as: "stage",
                          cond: {
                            $gt: [
                              {
                                $size: {
                                  $filter: {
                                    input: {
                                      $cond: {
                                        if: { $eq: [{ $type: "$$stage.v" }, "object"] },
                                        then: { $objectToArray: "$$stage.v" },
                                        else: []
                                      }
                                    },
                                    as: "field",
                                    cond: {
                                      $and: [
                                        { $in: ["$$field.k", ["IMEI", "CCID", "imei", "ccid"]] },
                                        { $eq: ["$$field.v", searchStr] }
                                      ]
                                    }
                                  }
                                }
                              },
                              0
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                }
              }
            ]
          }
        },
        {
          $lookup: {
            from: "products",
            localField: "productType",
            foreignField: "_id",
            as: "productType"
          }
        },
        { $unwind: { path: "$productType", preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            // Normalize process ID field
            processLookupId: { $ifNull: ["$processID", "$processId"] }
          }
        },
        {
          $lookup: {
            from: "processes",
            let: { pid: "$processLookupId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $eq: ["$_id", "$$pid"] },
                      { $eq: ["$processID", "$$pid"] }
                    ]
                  }
                }
              }
            ],
            as: "processID"
          }
        },
        { $unwind: { path: "$processID", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "orderconfirmationnumbers",
            let: { ocNo: "$processID.orderConfirmationNo" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $ne: ["$$ocNo", null] },
                      { $eq: [
                        { $trim: { input: "$orderConfirmationNo" } },
                        { $trim: { input: "$$ocNo" } }
                      ]}
                    ]
                  }
                }
              }
            ],
            as: "ocDetails"
          }
        },
        { $unwind: { path: "$ocDetails", preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            resolvedModelName: { 
              $ifNull: [
                "$ocDetails.modelName", 
                { $cond: { if: { $and: [{ $ne: ["$modelName", ""] }, { $ne: ["$modelName", "N/A"] }] }, then: "$modelName", else: null } },
                "$productType.name"
              ] 
            },
            resolvedProcessName: { 
              $ifNull: [
                "$processID.name", 
                "$processID.processName",
                { $cond: { if: { $and: [{ $ne: ["$processName", ""] }, { $ne: ["$processName", "N/A"] }] }, then: "$processName", else: null } }
              ] 
            }
          }
        }
      ]);
      // 2. If searchStr looks like a carton serial or no devices found yet,
      // search in CartonManagement collection to find associated devices.
      let devicesInCartonCount = 0;
      if (devices.length === 0 || searchStr.startsWith("CARTON-")) {
        const carton = await cartonModel.findOne({ cartonSerial: searchStr }).lean();
        if (carton && Array.isArray(carton.devices) && carton.devices.length > 0) {
          devicesInCartonCount = carton.devices.length;
          const cartonDeviceIds = carton.devices.map(id => {
            try { return new mongoose.Types.ObjectId(id); } catch (e) { return null; }
          }).filter(Boolean);
          
          if (cartonDeviceIds.length > 0) {
            // Fetch unique devices needed for this carton
            const moreDevices = await deviceModel.aggregate([
              { $match: { _id: { $in: cartonDeviceIds } } },
              {
                $lookup: {
                  from: "products",
                  localField: "productType",
                  foreignField: "_id",
                  as: "productType"
                }
              },
              { $unwind: { path: "$productType", preserveNullAndEmptyArrays: true } },
              {
                $lookup: {
                  from: "processes",
                  let: { pid: { $ifNull: ["$processID", "$processId"] } },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $or: [
                            { $eq: ["$_id", "$$pid"] },
                            { $eq: ["$processID", "$$pid"] }
                          ]
                        }
                      }
                    }
                  ],
                  as: "processID"
                }
              },
              { $unwind: { path: "$processID", preserveNullAndEmptyArrays: true } },
              {
                $lookup: {
                  from: "orderconfirmationnumbers",
                  let: { ocNo: "$processID.orderConfirmationNo" },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $and: [
                            { $ne: ["$$ocNo", null] },
                            { $eq: [
                              { $trim: { input: "$orderConfirmationNo" } },
                              { $trim: { input: "$$ocNo" } }
                            ]}
                          ]
                        }
                      }
                    }
                  ],
                  as: "ocDetails"
                }
              },
              { $unwind: { path: "$ocDetails", preserveNullAndEmptyArrays: true } },
              {
                $addFields: {
                  resolvedModelName: { 
                    $ifNull: [
                      "$ocDetails.modelName", 
                      { $cond: { if: { $and: [{ $ne: ["$modelName", ""] }, { $ne: ["$modelName", "N/A"] }] }, then: "$modelName", else: null } },
                      "$productType.name"
                    ] 
                  },
                  resolvedProcessName: { 
                    $ifNull: [
                      "$processID.name", 
                      "$processID.processName",
                      { $cond: { if: { $and: [{ $ne: ["$processName", ""] }, { $ne: ["$processName", "N/A"] }] }, then: "$processName", else: null } }
                    ] 
                  }
                }
              }
            ]);

            // Create a map for quick lookup
            const deviceMap = new Map(moreDevices.map(d => [String(d._id), d]));

            // Reconstruct the devices list to match the carton array exactly (including duplicates)
            const orderedDevices = carton.devices.map(id => deviceMap.get(String(id))).filter(Boolean);
            
            // If we are doing a carton search, replace the devices list with the ordered/duplicated list
            if (searchStr.startsWith("CARTON-")) {
              devices = orderedDevices;
            } else {
              // For other searches, just append unique missing ones
              const existingIds = new Set(devices.map(d => String(d._id)));
              const uniqueMissing = moreDevices.filter(d => !existingIds.has(String(d._id)));
              devices = [...devices, ...uniqueMissing];
            }
          }
        }
      }

      if (devices.length === 0) {
        return res.status(404).json({ status: 404, message: "No device found matching the query." });
      }

      // Enrichment helper to find IMEI/CCID in customFields if outer ones are missing
      // Enrichment helper to find IMEI/CCID in customFields with Functional stage priority
      const enrichDeviceIdentifiers = (dev) => {
        let customFields = dev.customFields;
        if (typeof customFields === "string") {
          try {
            customFields = JSON.parse(customFields);
          } catch {
            customFields = null;
          }
        }
        
        if (!customFields || typeof customFields !== "object") return dev;
        
        let foundImei = dev.imeiNo;
        let foundCcid = dev.ccid;
        let resolvedStatus = dev.status;

        if (customFields && typeof customFields === "object") {
          const functional = customFields.Functional || customFields.functional || {};
          if (functional.IMEI || functional.imei) foundImei = functional.IMEI || functional.imei;
          if (functional.CCID || functional.ccid || functional.ICCID || functional.iccid) foundCcid = functional.CCID || functional.ccid || functional.ICCID || functional.iccid;
        }

        // Iterate through stages to find missing identifiers and status
        Object.values(customFields).forEach(stage => {
          if (stage && typeof stage === "object") {
            if (!foundImei && (stage.IMEI || stage.imei)) {
              foundImei = stage.IMEI || stage.imei;
            }
            if (!foundCcid && (stage.CCID || stage.ccid)) {
              foundCcid = stage.CCID || stage.ccid;
            }
            // If status is missing or default, try to pick from stage
            if ((!resolvedStatus || resolvedStatus === "" || resolvedStatus === "Pending") && stage.status) {
              resolvedStatus = stage.status;
            }
          }
        });

        // Final fallback for status: if in a carton, it's generally passed
        if ((!resolvedStatus || resolvedStatus === "" || resolvedStatus === "Pending") && dev.cartonSerial) {
          resolvedStatus = "Pass";
        }

        return {
          ...dev,
          modelName: dev.resolvedModelName || dev.modelName || (dev.productType && dev.productType.name) || "N/A",
          processName: dev.resolvedProcessName || (dev.processID && (dev.processID.name || dev.processID.processName)) || "N/A",
          imeiNo: foundImei || dev.imeiNo || "N/A",
          ccid: foundCcid || dev.ccid || "N/A",
          status: resolvedStatus || dev.status || "Pending"
        };
      };

      // If multiple devices found (e.g. searching by cartonSerial), return the list for selection
      if (devices.length > 1) {
        return res.status(200).json({
          status: 200,
          message: "Multiple devices found.",
          totalCount: devicesInCartonCount || devices.length,
          isMulti: true,
          data: devices.map(enrichDeviceIdentifiers)
        });
      }

      const device = enrichDeviceIdentifiers(devices[0]);

      // 2. Fetch Test History
      const history = await deviceTestRecords.find({
        $or: [{ deviceId: device._id }, { serialNo: device.serialNo }].filter(c => Object.values(c)[0])
      })
      .populate("operatorId", "name employeeCode")
      .sort({ createdAt: 1 })
      .lean();

      // 3. Fetch Carton Details if associated
      let cartonDetails = null;
      if (device.cartonSerial) {
        cartonDetails = await cartonModel.findOne({ cartonSerial: device.cartonSerial }).lean();
      }

      return res.status(200).json({
        status: 200,
        message: "Device history fetched successfully",
        isMulti: false,
        data: {
          device,
          history,
          cartonDetails
        }
      });
    } catch (error) {
      console.error("Error in getDeviceComprehensiveHistory:", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
function getNextIndex(assignedStages, currentIndex) {
  const keys = Object.keys(assignedStages);

  // Sort keys like "0-0", "0-1", ..., "0-10" correctly
  const sortedKeys = keys.sort((a, b) => {
    const [a1, a2] = a.split("-").map(Number);
    const [b1, b2] = b.split("-").map(Number);
    return a1 - b1 || a2 - b2;
  });

  const currentIndexStr = currentIndex.toString();

  const nextIndex = sortedKeys.find((key) => {
    return key > currentIndexStr;
  });

  return nextIndex;
}
function generateSerials(
  lastSerialNo,
  prefix,
  noOfSerialRequired,
  suffix,
  enableZero,
  noOfZeroRequired,
  stepBy = 1,
  repeatTimes = 1,
  startFrom = null
) {
  let start = 1;
  if (startFrom !== null && !isNaN(startFrom)) {
    start = startFrom;
  } else if (lastSerialNo) {
    const match = lastSerialNo.match(/\d+/g);
    if (match) {
      start = parseInt(match[match.length - 1]) + 1;
    }
  }

  const end = start + noOfSerialRequired;
  const serials = [];
  for (let i = start; i < end; i += stepBy) {
    const paddedNumber = enableZero
      ? String(i).padStart(noOfZeroRequired, "0")
      : i;
    for (let r = 0; r < repeatTimes; r++) {
      serials.push(`${prefix}${paddedNumber}${suffix}`);
    }
  }
  return serials;
}




