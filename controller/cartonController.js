const mongoose = require("mongoose");
const processLogModel = require("../models/ProcessLogs");
const cartonModel = require("../models/cartonManagement");
const cartonHistoryModel = require("../models/cartonHistory");
const deviceModel = require("../models/device");
const userModel = require("../models/User");
const ProcessModel = require("../models/process");
const productModel = require("../models/Products");
const OrderConfirmationNumberModel = require("../models/orderConfirmationNumber");
const deviceTestModel = require("../models/deviceTestModel");
const inventoryModel = require("../models/inventoryManagement");
const planingModel = require("../models/planingAndSchedulingModel");
// const ProcessModel = require("../models/process");

const PDI_CARTON_NG_REASONS = {
  WEIGHT_MISMATCH: "Weight Verification Mismatched",
  CARTON_DAMAGED: "Carton Damaged",
};

const normalizeObjectIdList = (values = []) =>
  values
    .map((value) => {
      if (!value) return null;
      if (value instanceof mongoose.Types.ObjectId) return value;
      if (mongoose.Types.ObjectId.isValid(String(value))) {
        return new mongoose.Types.ObjectId(String(value));
      }
      return null;
    })
    .filter(Boolean);

const buildProcessIdMatch = (processId) => {
  const normalized = String(processId || "").trim();
  if (!normalized) return null;
  if (mongoose.Types.ObjectId.isValid(normalized)) {
    return {
      $in: [new mongoose.Types.ObjectId(normalized), normalized],
    };
  }
  return normalized;
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

const normalizeStageToken = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isFgToStoreStage = (stageName) => {
  const normalized = normalizeStageToken(stageName);
  if (!normalized) return false;
  if (normalized === "fg to store") return true;
  if (normalized === "keep in store") return true;
  return normalized.includes("fg") && normalized.includes("store");
};

const resolveKeepInStoreAllowedRoles = ({ processDoc = null, productDoc = null } = {}) => {
  const stagePool = [
    ...(Array.isArray(processDoc?.stages) ? processDoc.stages : []),
    ...(Array.isArray(processDoc?.commonStages) ? processDoc.commonStages : []),
    ...(Array.isArray(productDoc?.stages) ? productDoc.stages : []),
    ...(Array.isArray(productDoc?.commonStages) ? productDoc.commonStages : []),
  ];

  const roles = stagePool
    .filter((stage) =>
      isFgToStoreStage(stage?.stageName || stage?.name || stage?.stage),
    )
    .flatMap((stage) => parseManagedByRoles(stage?.managedBy));

  return Array.from(new Set(roles));
};

const normalizeWeightValue = (value) => {
  if (value === undefined || value === null) return null;
  const sanitizedValue = String(value)
    .trim()
    .replace(",", ".")
    .replace(/[^0-9.]/g, "");
  if (!sanitizedValue) return null;
  const parsedValue = Number.parseFloat(sanitizedValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) return null;
  return {
    numeric: parsedValue,
    scaled: Math.round(parsedValue * 1000),
  };
};

const normalizeToleranceValue = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return {
      numeric: 0,
      scaled: 0,
    };
  }
  const sanitizedValue = String(value)
    .trim()
    .replace(",", ".")
    .replace(/[^0-9.]/g, "");
  if (!sanitizedValue) {
    return {
      numeric: 0,
      scaled: 0,
    };
  }
  const parsedValue = Number.parseFloat(sanitizedValue);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return {
      numeric: 0,
      scaled: 0,
    };
  }
  return {
    numeric: parsedValue,
    scaled: Math.round(parsedValue * 1000),
  };
};

const createCartonHistoryEvent = async ({
  carton,
  eventType,
  performedBy,
  fromCartonStatus = "",
  toCartonStatus = "",
  fromDeviceStage = "",
  toDeviceStage = "",
  reasonCode = "",
  reasonText = "",
  notes = "",
  extra = null,
  session = null,
}) => {
  if (!carton?._id || !carton?.cartonSerial || !carton?.processId) return null;
  return cartonHistoryModel.create([{
    cartonSerial: carton.cartonSerial,
    cartonId: carton._id,
    processId: carton.processId,
    eventType,
    fromCartonStatus,
    toCartonStatus,
    fromDeviceStage,
    toDeviceStage,
    reasonCode,
    reasonText,
    notes,
    performedBy: performedBy || null,
    cycleNo: Number(carton?.cartonReworkCount || 0),
    weightAtEvent: String(carton?.weightCarton || ""),
    stickerPrintedState: !!carton?.isStickerPrinted,
    stickerVerifiedState: !!carton?.isStickerVerified,
    extra,
    timestamp: new Date(),
  }], session ? { session } : undefined).then((docs) => docs?.[0] || null);
};

const toFiniteNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const pickPositiveNumber = (...candidates) => {
  for (const candidate of candidates) {
    const parsed = toFiniteNumber(candidate);
    if (parsed !== null && parsed > 0) {
      return parsed;
    }
  }
  return null;
};

const pickHybridTolerance = (...candidates) => {
  let sawZero = false;
  for (const candidate of candidates) {
    const parsed = toFiniteNumber(candidate);
    if (parsed === null || parsed < 0) continue;
    if (parsed > 0) return parsed;
    sawZero = true;
  }
  return sawZero ? 0 : null;
};

const extractPackagingDataFromStages = (stages = []) => {
  const list = Array.isArray(stages) ? stages : [];

  for (const stage of list) {
    const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
    const activePackagingSubStep = subSteps.find(
      (subStep) => subStep?.isPackagingStatus && !subStep?.disabled && subStep?.packagingData,
    );
    if (activePackagingSubStep?.packagingData) {
      return activePackagingSubStep.packagingData;
    }
  }

  for (const stage of list) {
    const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
    const packagingSubStep = subSteps.find(
      (subStep) => subStep?.isPackagingStatus && subStep?.packagingData,
    );
    if (packagingSubStep?.packagingData) {
      return packagingSubStep.packagingData;
    }
  }

  return null;
};

const getProcessAndProductDocs = async (processId) => {
  const processDoc = processId ? await ProcessModel.findById(processId).lean() : null;
  const productId =
    processDoc?.selectedProduct || processDoc?.productType || processDoc?.productId || null;

  let productDoc = null;
  if (productId && mongoose.Types.ObjectId.isValid(String(productId))) {
    productDoc = await productModel.findById(productId).lean();
  }

  return { processDoc, productDoc };
};

const resolveEffectivePackagingConfig = ({
  cartonPackagingData,
  processDoc,
  productDoc,
} = {}) => {
  const cartonPackaging =
    cartonPackagingData && typeof cartonPackagingData === "object" ? cartonPackagingData : {};
  const processPackaging = extractPackagingDataFromStages(processDoc?.stages);
  const productPackaging = extractPackagingDataFromStages(productDoc?.stages);

  const cartonWeight =
    pickPositiveNumber(
      cartonPackaging?.cartonWeight,
      processPackaging?.cartonWeight,
      productPackaging?.cartonWeight,
    ) ?? 0;

  const cartonWeightTolerance =
    pickHybridTolerance(
      cartonPackaging?.cartonWeightTolerance,
      processPackaging?.cartonWeightTolerance,
      productPackaging?.cartonWeightTolerance,
    ) ?? 0;

  const maxCapacity =
    pickPositiveNumber(
      cartonPackaging?.maxCapacity,
      processPackaging?.maxCapacity,
      productPackaging?.maxCapacity,
    ) ?? 0;

  return {
    cartonWeight,
    cartonWeightTolerance,
    maxCapacity,
    processPackaging,
    productPackaging,
  };
};

const getConfiguredCartonWeight = async (carton) => {
  const { processDoc, productDoc } = await getProcessAndProductDocs(carton?.processId);
  const resolvedPackaging = resolveEffectivePackagingConfig({
    cartonPackagingData: carton?.packagingData,
    processDoc,
    productDoc,
  });

  const expectedWeight = normalizeWeightValue(resolvedPackaging.cartonWeight);
  const expectedTolerance = normalizeToleranceValue(resolvedPackaging.cartonWeightTolerance);
  const configuredCapacity = Number(resolvedPackaging.maxCapacity || 0);

  return {
    expectedWeight,
    expectedTolerance,
    configuredCapacity,
    processDoc,
    productDoc,
    resolvedPackaging,
  };
};

const isPartialOrDerivedCarton = (carton, configuredCapacity = 0) => {
  const cartonStatus = String(carton?.status || "").trim().toLowerCase();
  const looseCartonAction = String(carton?.looseCartonAction || "").trim().toLowerCase();
  const cartonCapacity = Number(
    carton?.packagingData?.maxCapacity ??
      carton?.maxCapacity ??
      (Array.isArray(carton?.devices) ? carton.devices.length : 0),
  );
  const looksLikePartialDerivedByCapacity =
    Number.isFinite(configuredCapacity) &&
    configuredCapacity > 0 &&
    Number.isFinite(cartonCapacity) &&
    cartonCapacity > 0 &&
    cartonCapacity < configuredCapacity;

  return (
    cartonStatus === "partial" ||
    !!carton?.isLooseCarton ||
    looseCartonAction === "assign-new" ||
    !!carton?.sourceCartonSerial ||
    Number(carton?.reassignedQuantity || 0) > 0 ||
    looksLikePartialDerivedByCapacity
  );
};

const findDeviceStageForCarton = async (carton) => {
  if (!Array.isArray(carton?.devices) || carton.devices.length === 0) return "";
  const firstDevice = await deviceModel.findOne({ _id: { $in: carton.devices } }).lean();
  return String(firstDevice?.currentStage || "").trim();
};

const findLatestCartonHistory = async (cartonSerial) => {
  if (!cartonSerial) return [];
  return cartonHistoryModel
    .find({ cartonSerial })
    .populate("performedBy", "name empId")
    .sort({ timestamp: -1, createdAt: -1 })
    .lean();
};

const resolveReturnContextForCarton = async (carton) => {
  let returnCartonStatus = String(carton?.previousCartonStatus || "").trim();
  let returnDeviceStage = String(carton?.previousDeviceStage || "").trim();

  if (!returnDeviceStage) {
    const history = await findLatestCartonHistory(carton?.cartonSerial);
    const lastPdiEntry = history.find(
      (event) =>
        ["SHIFT_TO_PDI", "RETURN_TO_PDI"].includes(String(event?.eventType || "")) &&
        String(event?.fromDeviceStage || "").trim() &&
        String(event?.fromDeviceStage || "").trim() !== "PDI",
    );

    if (lastPdiEntry) {
      returnDeviceStage = String(lastPdiEntry.fromDeviceStage || "").trim();
      if (!returnCartonStatus) {
        returnCartonStatus = String(lastPdiEntry.fromCartonStatus || "").trim();
      }
    }
  }

  if (!returnDeviceStage && Array.isArray(carton?.devices) && carton.devices.length > 0) {
    const latestPackagingRecord = await deviceTestModel.findOne({
      deviceId: { $in: carton.devices },
      stageName: {
        $nin: ["", "PDI", "FG to Store", "FG_TO_STORE", "KEEP_IN_STORE", "STOCKED"],
      },
    }).sort({ createdAt: -1 }).lean();

    if (latestPackagingRecord?.stageName) {
      returnDeviceStage = String(latestPackagingRecord.stageName || "").trim();
    }
  }

  return {
    returnCartonStatus,
    returnDeviceStage,
  };
};

const findCartonConflicts = async (deviceIds = [], excludeCartonIds = []) => {
  const normalizedDeviceIds = normalizeObjectIdList(deviceIds);
  if (normalizedDeviceIds.length === 0) return null;

  const normalizedExcludeIds = normalizeObjectIdList(excludeCartonIds);
  return cartonModel.findOne({
    _id: { $nin: normalizedExcludeIds },
    devices: { $in: normalizedDeviceIds },
  });
};

const resolveCartonMaxCapacity = (carton) => {
  const parsedCapacity = pickPositiveNumber(
    carton?.maxCapacity,
    carton?.packagingData?.maxCapacity,
  );
  return parsedCapacity && parsedCapacity > 0 ? Number(parsedCapacity) : 0;
};

const resolveCartonStatusFromDeviceCount = (deviceCount, maxCapacity) => {
  const safeCount = Number(deviceCount) || 0;
  const safeCapacity = Number(maxCapacity) || 0;

  if (safeCount <= 0) {
    return "empty";
  }

  if (safeCapacity > 0 && safeCount >= safeCapacity) {
    return "full";
  }

  return "partial";
};

const isPackagingOpenCarton = (carton) => {
  const lifecycleStatus = String(carton?.cartonStatus || "")
    .trim()
    .toUpperCase();
  const fillStatus = String(carton?.status || "").trim().toLowerCase();

  return (
    (lifecycleStatus === "" || lifecycleStatus === "LOOSE_CLOSED") &&
    ["full", "partial", "empty"].includes(fillStatus)
  );
};

const resolveRepackagingCartonStage = (cartonStatus) => {
  const normalized = normalizeStageToken(cartonStatus);
  if (normalized === "pdi") return "PDI";
  if (normalized === "fg to store") return "FG_TO_STORE";
  if (normalized === "stocked" || normalized === "kept in store") return "STOCKED";
  return "";
};

const isRepackagingCartonStage = (cartonStatus) => {
  return Boolean(resolveRepackagingCartonStage(cartonStatus));
};

const isRepackagingEligibleDeviceStage = (stageName) => {
  const normalized = normalizeStageToken(stageName);
  return (
    normalized === "packaging" ||
    normalized === "pdi" ||
    normalized === "fg to store" ||
    normalized === "stocked" ||
    normalized === "kept in store"
  );
};

const normalizeStageText = (value) => String(value || "").trim();
const normalizeStageKey = (value) =>
  normalizeStageText(value).toLowerCase().replace(/\s+/g, " ");

const safeParseJson = (value, fallback = {}) => {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toStageArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
};

const getStageLabel = (stage) =>
  normalizeStageText(stage?.stageName || stage?.name || stage?.stage);

const isRevertedEquivalentStatus = (status) => {
  const normalized = normalizeStageKey(status);
  return normalized === "reverted" || normalized === "removed";
};

const getRecordStageName = (record = {}) =>
  normalizeStageText(
    record?.currentLogicalStage ||
      record?.stageName ||
      record?.currentStage ||
      record?.nextLogicalStage,
  );

const incrementStageTotalUPHA = (stageEntry, delta = 0) => {
  const current = Number(stageEntry?.totalUPHA || 0);
  const updated = current + Number(delta || 0);
  stageEntry.totalUPHA = Math.max(updated, 0);
};

const decrementStageCount = (stageEntry, key, delta = 1) => {
  const current = Number(stageEntry?.[key] || 0);
  const updated = current - Number(delta || 0);
  stageEntry[key] = Math.max(updated, 0);
};

const adjustAssignedStagesForCartonRemoval = ({
  assignedStages = {},
  currentSeatKey = "",
  currentStageName = "",
  nextSeatKey = "",
  nextStageName = "",
}) => {
  const patched = assignedStages && typeof assignedStages === "object"
    ? { ...assignedStages }
    : {};

  const applySeatStageUpdate = (seatKey, stageName, updater) => {
    const resolvedSeatKey = normalizeStageText(seatKey);
    const resolvedStageName = normalizeStageText(stageName);
    if (!resolvedSeatKey || !patched[resolvedSeatKey]) return false;

    const seatStages = toStageArray(patched[resolvedSeatKey]).map((item) => ({ ...item }));
    if (seatStages.length === 0) return false;

    const normalizedTargetStage = normalizeStageKey(resolvedStageName);
    let stageIndex = seatStages.findIndex(
      (entry) => normalizeStageKey(getStageLabel(entry)) === normalizedTargetStage,
    );

    if (stageIndex === -1 && seatStages.length === 1) {
      stageIndex = 0;
    }
    if (stageIndex === -1) return false;

    updater(seatStages[stageIndex]);
    patched[resolvedSeatKey] = seatStages;
    return true;
  };

  const currentApplied = applySeatStageUpdate(
    currentSeatKey,
    currentStageName,
    (entry) => {
      decrementStageCount(entry, "passedDevice", 1);
      incrementStageTotalUPHA(entry, 1);
    },
  );

  const nextApplied = applySeatStageUpdate(
    nextSeatKey,
    nextStageName,
    (entry) => {
      incrementStageTotalUPHA(entry, -1);
    },
  );

  return {
    assignedStages: patched,
    currentApplied,
    nextApplied,
  };
};

const normalizeOrderConfirmationNo = (value) => String(value || "").trim();

const buildOrderConfirmationModelMap = async (orderConfirmationNos = []) => {
  const normalizedNumbers = Array.from(
    new Set(orderConfirmationNos.map((value) => normalizeOrderConfirmationNo(value)).filter(Boolean))
  );

  if (normalizedNumbers.length === 0) return new Map();

  const records = await OrderConfirmationNumberModel.find({
    orderConfirmationNo: { $in: normalizedNumbers },
  })
    .select("orderConfirmationNo modelName")
    .lean();

  return new Map(
    records.map((record) => [
      normalizeOrderConfirmationNo(record.orderConfirmationNo),
      String(record.modelName || "").trim(),
    ])
  );
};

const attachModelNamesToCartons = async (cartons = [], resolveOrderConfirmationNo = () => "") => {
  const modelMap = await buildOrderConfirmationModelMap(
    cartons.map((carton) => resolveOrderConfirmationNo(carton))
  );

  return cartons.map((carton) => {
    const orderConfirmationNo = normalizeOrderConfirmationNo(resolveOrderConfirmationNo(carton));
    const resolvedModelName = String(carton?.modelName || modelMap.get(orderConfirmationNo) || "").trim();

    return {
      ...carton,
      modelName: resolvedModelName,
      devices: Array.isArray(carton?.devices)
        ? carton.devices.map((device) => ({
            ...device,
            modelName: String(device?.modelName || resolvedModelName || "").trim(),
      }))
        : [],
    };
  });
};

const getRecordTimestamp = (record = {}) => {
  const raw = record?.createdAt || record?.updatedAt || 0;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const toStatusLabel = (value = "") => {
  const normalized = normalizeStageKey(value);
  if (normalized === "pass") return "Pass";
  if (normalized === "completed") return "Completed";
  if (normalized === "ng") return "NG";
  if (normalized === "fail") return "Fail";
  return normalizeStageText(value);
};

const isMissingIdentityValue = (value = "") => {
  const normalized = normalizeStageText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return (
    !normalized ||
    normalized === "notcaptured" ||
    normalized === "na" ||
    normalized === "none" ||
    normalized === "null" ||
    normalized === "undefined"
  );
};

const parseIdentitySource = (source) => {
  if (!source) return null;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return null;
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  return typeof source === "object" ? source : null;
};

const doesIdentityKeyMatch = (rawKey, preferredKeys = []) => {
  const keySegments = normalizeStageText(rawKey)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (keySegments.length === 0) return false;

  return (Array.isArray(preferredKeys) ? preferredKeys : [])
    .map((key) => normalizeStageText(key).toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean)
    .some((preferred) => keySegments.includes(preferred));
};

const tryResolveIdentityFromFieldEntry = (entry, preferredKeys = ["imei"]) => {
  const parsedEntry = parseIdentitySource(entry);
  if (!parsedEntry || typeof parsedEntry !== "object" || Array.isArray(parsedEntry)) {
    return "";
  }

  const keyCandidates = [
    parsedEntry?.fieldName,
    parsedEntry?.name,
    parsedEntry?.key,
    parsedEntry?.slug,
    parsedEntry?.label,
    parsedEntry?.title,
    parsedEntry?.id,
    parsedEntry?.code,
    parsedEntry?.type,
  ];
  const keyMatched = keyCandidates.some((candidate) =>
    doesIdentityKeyMatch(candidate, preferredKeys),
  );
  if (!keyMatched) return "";

  return resolveIdentityValue(
    parsedEntry?.value,
    parsedEntry?.fieldValue,
    parsedEntry?.inputValue,
    parsedEntry?.scannedValue,
    parsedEntry?.data,
    parsedEntry?.result,
  );
};

const extractIdentityFromCustomFields = (source, preferredKeys = ["imei"]) => {
  const parsedSource = parseIdentitySource(source);
  if (!parsedSource || typeof parsedSource !== "object") return "";
  const directFieldEntry = tryResolveIdentityFromFieldEntry(
    parsedSource,
    preferredKeys,
  );
  if (directFieldEntry) return directFieldEntry;

  if (Array.isArray(parsedSource)) {
    for (const entry of parsedSource) {
      const nestedValue = extractIdentityFromCustomFields(entry, preferredKeys);
      if (nestedValue) return nestedValue;
    }
    return "";
  }

  for (const [rawKey, rawValue] of Object.entries(parsedSource)) {
    const fromFieldEntry = tryResolveIdentityFromFieldEntry(rawValue, preferredKeys);
    if (fromFieldEntry) return fromFieldEntry;

    const nestedSource = parseIdentitySource(rawValue);
    if (nestedSource && typeof nestedSource === "object") {
      const nestedValue = extractIdentityFromCustomFields(nestedSource, preferredKeys);
      if (nestedValue) return nestedValue;
    }

    if (doesIdentityKeyMatch(rawKey, preferredKeys)) {
      const candidate = normalizeStageText(rawValue);
      if (candidate && !isMissingIdentityValue(candidate)) return candidate;
    }
  }
  return "";
};

const resolveIdentityValue = (...candidates) => {
  for (const candidate of candidates) {
    const normalized = normalizeStageText(candidate);
    if (normalized && !isMissingIdentityValue(normalized)) {
      return normalized;
    }
  }
  return "";
};

const pickLatestNonRevertedRecord = (records = []) => {
  let latestRecord = null;
  (Array.isArray(records) ? records : []).forEach((record) => {
    if (!record || isRevertedEquivalentStatus(record?.status)) return;
    if (!latestRecord || getRecordTimestamp(record) >= getRecordTimestamp(latestRecord)) {
      latestRecord = record;
    }
  });
  return latestRecord;
};

const collectCartonDeviceIds = (cartons = []) => {
  const ids = [];
  (Array.isArray(cartons) ? cartons : []).forEach((carton) => {
    const devices = Array.isArray(carton?.devices) ? carton.devices : [];
    devices.forEach((device) => {
      const candidateId = device && typeof device === "object" ? device._id : device;
      if (candidateId) ids.push(candidateId);
    });
  });
  return normalizeObjectIdList(ids);
};

const buildLatestRecordMapByDeviceIds = async (deviceIds = []) => {
  const normalizedDeviceIds = normalizeObjectIdList(deviceIds);
  if (normalizedDeviceIds.length === 0) return new Map();

  const latestRecords = await deviceTestModel.aggregate([
    {
      $match: {
        deviceId: { $in: normalizedDeviceIds },
      },
    },
    {
      $addFields: {
        normalizedStatus: {
          $toLower: {
            $trim: {
              input: { $ifNull: ["$status", ""] },
            },
          },
        },
      },
    },
    {
      $match: {
        normalizedStatus: { $nin: ["reverted", "removed"] },
      },
    },
    {
      $sort: {
        createdAt: -1,
        updatedAt: -1,
        _id: -1,
      },
    },
    {
      $group: {
        _id: "$deviceId",
        latest: { $first: "$$ROOT" },
      },
    },
    {
      $replaceRoot: {
        newRoot: "$latest",
      },
    },
    {
      $project: {
        _id: 1,
        deviceId: 1,
        serialNo: 1,
        stageName: 1,
        currentLogicalStage: 1,
        currentStage: 1,
        status: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ]);

  const map = new Map();
  latestRecords.forEach((record) => {
    map.set(String(record?.deviceId || ""), record);
  });
  return map;
};

const getProcessFallbackModelName = async (processId) => {
  if (!processId || !mongoose.Types.ObjectId.isValid(String(processId))) return "";

  const processDoc = await ProcessModel.findById(processId)
    .select("orderConfirmationNo")
    .lean();
  const orderConfirmationNo = normalizeOrderConfirmationNo(processDoc?.orderConfirmationNo);
  if (!orderConfirmationNo) return "";

  const modelMap = await buildOrderConfirmationModelMap([orderConfirmationNo]);
  return normalizeStageText(modelMap.get(orderConfirmationNo));
};

const enrichCartonDevicesForResponse = ({
  cartons = [],
  fallbackModelName = "",
  latestRecordByDeviceId = null,
} = {}) => {
  const resolvedFallbackModelName = normalizeStageText(fallbackModelName);

  return (Array.isArray(cartons) ? cartons : []).map((carton) => {
    const cartonModelName = normalizeStageText(carton?.modelName || resolvedFallbackModelName);
    const rawDevices = Array.isArray(carton?.devices) ? carton.devices : [];
    
    // ✅ Identify if some devices were lost during aggregation/population (e.g. non-existent ObjectIds)
    const expectedCount = Number(carton?.actualDeviceCount) || 0;
    const currentCount = rawDevices.length;
    
    // ✅ Create placeholders for missing devices to maintain correct "Net Qty" count
    const paddedDevices = [...rawDevices];
    if (expectedCount > currentCount) {
      for (let i = currentCount; i < expectedCount; i++) {
        paddedDevices.push({
          _id: null,
          serialNo: "MISSING DEVICE",
          isMissing: true,
          status: "Data Error",
          currentStage: "N/A"
        });
      }
    }

    const enrichedDevices = paddedDevices.map((rawDevice, index) => {
      const device = rawDevice && typeof rawDevice === "object"
        ? { ...rawDevice }
        : { _id: rawDevice, serialNo: normalizeStageText(rawDevice), status: "", currentStage: "" };
      const deviceId = normalizeStageText(device?._id);
      const fromMap = latestRecordByDeviceId instanceof Map ? latestRecordByDeviceId.get(deviceId) : null;
      const latestRecord = fromMap || pickLatestNonRevertedRecord(device?.testRecords || []);

      const displayModel = normalizeStageText(
        device?.displayModel ||
        device?.modelName ||
        device?.model ||
        device?.productModel ||
        cartonModelName,
      ) || "N/A";

      const displayImei = resolveIdentityValue(
        device?.displayImei,
        device?.imeiNo,
        device?.imei,
        device?.ccid,
        device?.iccid,
        extractIdentityFromCustomFields(device?.customFields, ["imei"]),
        extractIdentityFromCustomFields(device?.custom_fields, ["imei"]),
        extractIdentityFromCustomFields(device?.customFields, ["ccid", "iccid"]),
        extractIdentityFromCustomFields(device?.custom_fields, ["ccid", "iccid"]),
        extractIdentityFromCustomFields(device, ["imei"]),
        extractIdentityFromCustomFields(device, ["ccid", "iccid"]),
        latestRecord?.imeiNo,
        latestRecord?.imei,
        latestRecord?.ccid,
        latestRecord?.iccid,
        extractIdentityFromCustomFields(latestRecord?.customFields, ["imei"]),
        extractIdentityFromCustomFields(latestRecord?.customFields, ["ccid", "iccid"]),
        extractIdentityFromCustomFields(latestRecord?.logData, ["imei"]),
        extractIdentityFromCustomFields(latestRecord?.logData, ["ccid", "iccid"]),
        extractIdentityFromCustomFields(latestRecord?.logs, ["imei"]),
        extractIdentityFromCustomFields(latestRecord?.logs, ["ccid", "iccid"]),
      ) || "Not Captured";

      const displayStageStatus = toStatusLabel(
        normalizeStageText(
          device?.displayStageStatus ||
          latestRecord?.status ||
          device?.currentStage ||
          latestRecord?.currentLogicalStage ||
          latestRecord?.stageName ||
          latestRecord?.currentStage ||
          device?.status ||
          "Pending",
        )
      ) || "Pending";

      const serialNo = normalizeStageText(
        device?.serialNo ||
        device?.serial_no ||
        device?.serial ||
        latestRecord?.serialNo ||
        "",
      ) || normalizeStageText(device?._id || (device?.isMissing ? `MISSING DEVICE (${index + 1})` : `UNKNOWN-${index + 1}`));

      return {
        ...device,
        serialNo,
        modelName: normalizeStageText(device?.modelName || displayModel),
        displayModel,
        displayImei,
        displayStageStatus,
        latestTestRecord: latestRecord || null,
      };
    });

    return {
      ...carton,
      modelName: normalizeStageText(carton?.modelName || cartonModelName),
      devices: enrichedDevices,
    };
  });
};

module.exports = {
  createOrUpdate: async (req, res) => {
    try {
      const { processId, devices, packagingData: rawPackagingData, selectedCarton: rawSelectedCarton } = req.body;
      const deviceIds = Array.from(
        new Set(
          (Array.isArray(devices) ? devices : [])
            .map((deviceId) => String(deviceId || "").trim())
            .filter(Boolean),
        ),
      );
      const selectedCarton = String(rawSelectedCarton || "").trim();
      const incomingPackagingData =
        rawPackagingData && typeof rawPackagingData === "object" ? rawPackagingData : {};
      const processIdMatch = buildProcessIdMatch(processId);

      if (!processIdMatch) {
        return res.status(400).json({
          status: 400,
          message: "Invalid process id.",
        });
      }

      const { processDoc, productDoc } = await getProcessAndProductDocs(processId);
      const resolvedPackaging = resolveEffectivePackagingConfig({
        cartonPackagingData: incomingPackagingData,
        processDoc,
        productDoc,
      });
      const resolvedCartonLength =
        pickPositiveNumber(
          incomingPackagingData?.cartonLength,
          incomingPackagingData?.cartonDepth,
          resolvedPackaging?.processPackaging?.cartonLength,
          resolvedPackaging?.processPackaging?.cartonDepth,
          resolvedPackaging?.productPackaging?.cartonLength,
          resolvedPackaging?.productPackaging?.cartonDepth,
        ) ?? 0;
      const effectivePackagingData = {
        ...incomingPackagingData,
        cartonLength: resolvedCartonLength,
        cartonDepth: resolvedCartonLength,
        cartonWeight:
          pickPositiveNumber(
            incomingPackagingData?.cartonWeight,
            resolvedPackaging.cartonWeight,
          ) ?? 0,
        cartonWeightTolerance:
          pickHybridTolerance(
            incomingPackagingData?.cartonWeightTolerance,
            resolvedPackaging.cartonWeightTolerance,
          ) ?? 0,
        maxCapacity:
          pickPositiveNumber(
            incomingPackagingData?.maxCapacity,
            resolvedPackaging.maxCapacity,
          ) ?? 0,
      };

      if (deviceIds.length === 0) {
        return res.status(400).json({
          status: 400,
          message: "At least one device is required.",
        });
      }

      let existingCarton = null;

      if (selectedCarton) {
        existingCarton = await cartonModel.findOne({
          processId: processIdMatch,
          cartonSerial: selectedCarton,
          status: { $in: ["partial", "empty"] },
          cartonStatus: { $in: [""] },
        });

        if (!existingCarton) {
          return res.status(409).json({
            status: 409,
            message: `Selected carton ${selectedCarton} is not open for packaging updates.`,
          });
        }
      } else {
        existingCarton = await cartonModel
          .findOne({
            processId: processIdMatch,
            status: { $in: ["partial", "empty"] },
            cartonStatus: { $in: [""] },
          })
          .sort({ updatedAt: -1, createdAt: -1, _id: -1 });
      }

      if (existingCarton) {
        const existingDeviceSet = new Set(
          Array.isArray(existingCarton.devices)
            ? existingCarton.devices.map((deviceId) => String(deviceId))
            : [],
        );
        const alreadyInThisCarton = deviceIds.some((deviceId) =>
          existingDeviceSet.has(String(deviceId)),
        );
        if (alreadyInThisCarton) {
          return res.status(400).json({
            status: 400,
            message: "Device already exists in this carton.",
          });
        }

        const conflict = await findCartonConflicts(deviceIds, [existingCarton._id]);
        if (conflict) {
          return res.status(409).json({
            status: 409,
            message: `Device already assigned to carton ${conflict.cartonSerial}.`,
          });
        }

        const existingPackagingData =
          existingCarton?.packagingData && typeof existingCarton.packagingData === "object"
            ? existingCarton.packagingData
            : {};
        const existingTolerance = Number(existingPackagingData?.cartonWeightTolerance ?? 0);
        const existingWeight = Number(existingPackagingData?.cartonWeight ?? 0);
        const existingCapacity = Number(existingCarton.maxCapacity || existingPackagingData?.maxCapacity || 0);

        if (existingTolerance <= 0 && Number(effectivePackagingData.cartonWeightTolerance || 0) > 0) {
          existingCarton.packagingData = {
            ...existingPackagingData,
            cartonWeightTolerance: Number(effectivePackagingData.cartonWeightTolerance || 0),
          };
        }
        if (existingWeight <= 0 && Number(effectivePackagingData.cartonWeight || 0) > 0) {
          existingCarton.packagingData = {
            ...(existingCarton.packagingData || {}),
            cartonWeight: Number(effectivePackagingData.cartonWeight || 0),
          };
        }
        if (existingCapacity <= 0 && Number(effectivePackagingData.maxCapacity || 0) > 0) {
          existingCarton.maxCapacity = String(Number(effectivePackagingData.maxCapacity || 0));
          existingCarton.packagingData = {
            ...(existingCarton.packagingData || {}),
            maxCapacity: Number(effectivePackagingData.maxCapacity || 0),
          };
        }

        const resolvedExistingCapacity = resolveCartonMaxCapacity(existingCarton);
        if (
          resolvedExistingCapacity > 0 &&
          existingCarton.devices.length + deviceIds.length > resolvedExistingCapacity
        ) {
          return res.status(409).json({
            status: 409,
            message: `Carton capacity exceeded. Allowed max is ${resolvedExistingCapacity}.`,
          });
        }

        existingCarton.devices.push(...deviceIds);
        existingCarton.status = resolveCartonStatusFromDeviceCount(
          existingCarton.devices.length,
          resolvedExistingCapacity,
        );
        await existingCarton.save();
        return res.status(200).json({
          status: 200,
          message: "Device added to existing carton",
          carton: existingCarton,
        });
      }

      const conflict = await findCartonConflicts(deviceIds);
      if (conflict) {
        return res.status(409).json({
          status: 409,
          message: `Device already assigned to carton ${conflict.cartonSerial}.`,
        });
      }

      const resolvedNewCartonCapacity = Number(effectivePackagingData.maxCapacity || 0);
      if (resolvedNewCartonCapacity > 0 && deviceIds.length > resolvedNewCartonCapacity) {
        return res.status(409).json({
          status: 409,
          message: `Carton capacity exceeded. Allowed max is ${resolvedNewCartonCapacity}.`,
        });
      }

      const newCarton = new cartonModel({
        cartonSerial: `CARTON-${Date.now()}`,
        processId,
        devices: deviceIds,
        packagingData: effectivePackagingData,
        cartonSize: {
          length: effectivePackagingData?.cartonLength
            ? String(effectivePackagingData.cartonLength)
            : "",
          width: effectivePackagingData?.cartonWidth
            ? String(effectivePackagingData.cartonWidth)
            : "",
          height: effectivePackagingData?.cartonHeight
            ? String(effectivePackagingData.cartonHeight)
            : "",
          depth: effectivePackagingData?.cartonLength
            ? String(effectivePackagingData.cartonLength)
            : "",
        },
        maxCapacity: effectivePackagingData.maxCapacity,
        status: resolveCartonStatusFromDeviceCount(
          deviceIds.length,
          Number(effectivePackagingData.maxCapacity || 0),
        ),
      });

      await newCarton.save();

      return res.status(201).json({
        status: 201,
        message: "New carton created",
        carton: newCarton,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "An error occurred while creating/updating carton.",
        error: error.message,
      });
    }
  },
  verifySticker: async (req, res) => {
    try {
      const { cartonSerial } = req.body;
      if (!cartonSerial) {
        return res
          .status(400)
          .json({ status: 400, message: "Carton serial is required." });
      }

      const updatedCarton = await cartonModel.findOne({ cartonSerial });
      if (!updatedCarton) {
        return res
          .status(404)
          .json({ status: 404, message: "Carton not found." });
      }

      updatedCarton.isStickerVerified = true;
      await updatedCarton.save();

      const currentDeviceStage = await findDeviceStageForCarton(updatedCarton);
      await createCartonHistoryEvent({
        carton: updatedCarton,
        eventType: updatedCarton.isReturnedFromPdi ? "STICKER_REVERIFIED" : "STICKER_VERIFIED",
        performedBy: req.user?.id || req.user?._id,
        fromCartonStatus: String(updatedCarton.cartonStatus || "").trim(),
        toCartonStatus: String(updatedCarton.cartonStatus || "").trim(),
        fromDeviceStage: currentDeviceStage,
        toDeviceStage: currentDeviceStage,
      });

      return res.status(200).json({ status: 200, message: "Sticker verified successfully.", carton: updatedCarton });
    } catch (error) {
      return res.status(500).json({ status: 500, message: "Error verifying sticker.", error: error.message });
    }
  },
  getCartonByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;
      const processIdMatch = buildProcessIdMatch(processId);
      if (!processIdMatch) {
        return res.status(400).json({ message: "Invalid process id." });
      }

      const cartons = await cartonModel.aggregate([
        {
          $match: {
            processId: processIdMatch,
            status: { $in: ["full", "partial", "empty"] },
            $or: [
              { cartonStatus: { $in: ["", "LOOSE_CLOSED"] } },
              { cartonStatus: null },
              { cartonStatus: { $exists: false } },
            ],
          },
        },
        {
          $addFields: {
            actualDeviceCount: { $size: { $ifNull: ["$devices", []] } },
          },
        },
        {
          $lookup: {
            from: "devices",
            localField: "devices",
            foreignField: "_id",
            as: "devices",
          },
        },
        { $unwind: { path: "$devices", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "devicetestrecords",
            localField: "devices._id",
            foreignField: "deviceId",
            as: "deviceTestRecords",
          },
        },

        // ✅ Merge testRecords into devices
        {
          $addFields: {
            "devices.testRecords": "$deviceTestRecords",
          },
        },

        // 🌀 Group back to carton level
        {
          $group: {
            _id: "$_id",
            cartonSize: { $first: "$cartonSize" },
            packagingData: { $first: "$packagingData" },
            cartonSerial: { $first: "$cartonSerial" },
            processId: { $first: "$processId" },
            maxCapacity: { $first: "$maxCapacity" },
            status: { $first: "$status" },
            isStickerVerified: { $first: "$isStickerVerified" },
            isStickerPrinted: { $first: "$isStickerPrinted" },
            isWeightVerified: { $first: "$isWeightVerified" },
            isLooseCarton: { $first: "$isLooseCarton" },
            looseCartonAction: { $first: "$looseCartonAction" },
            sourceCartonSerial: { $first: "$sourceCartonSerial" },
            reassignedQuantity: { $first: "$reassignedQuantity" },
            weightCarton: { $first: "$weightCarton" },
            createdAt: { $first: "$createdAt" },
            updatedAt: { $first: "$updatedAt" },
            __v: { $first: "$__v" },
            cartonStatus: { $first: "$cartonStatus" },
            previousCartonStatus: { $first: "$previousCartonStatus" },
            previousDeviceStage: { $first: "$previousDeviceStage" },
            isReturnedFromPdi: { $first: "$isReturnedFromPdi" },
            returnedFromPdiAt: { $first: "$returnedFromPdiAt" },
            lastSentToPdiAt: { $first: "$lastSentToPdiAt" },
            cartonReworkCount: { $first: "$cartonReworkCount" },
            lastPdiNgReasonCode: { $first: "$lastPdiNgReasonCode" },
            lastPdiNgReasonText: { $first: "$lastPdiNgReasonText" },
            lastPdiNgNotes: { $first: "$lastPdiNgNotes" },
            actualDeviceCount: { $first: "$actualDeviceCount" },
            devices: { $push: "$devices" },
          },
        },
        { $sort: { _id: -1 } }
      ]);

      if (!cartons || cartons.length === 0) {
        return res.status(200).json({ cartonSerials: [], cartonDetails: [] });
      }

      // 📦 Separate arrays
      const fallbackModelName = await getProcessFallbackModelName(processId);
      const enrichedCartons = enrichCartonDevicesForResponse({
        cartons,
        fallbackModelName,
      });
      const cartonSerials = enrichedCartons.map((c) => c.cartonSerial);

      return res.json({
        cartonSerials,
        cartonDetails: enrichedCartons,
      });
    } catch (error) {
      console.error("Error fetching carton:", error);
      res.status(500).json({ error: "Server error: " + error.message });
    }
  },
  getCartonsIntoStore: async (req, res) => {
    try {
      const { processId } = req.params;
      const processIdMatch = buildProcessIdMatch(processId);
      if (!processIdMatch) {
        return res.status(400).json({ message: "Invalid process id." });
      }

      const cartons = await cartonModel.aggregate([
        {
          $addFields: {
            actualDeviceCount: { $size: { $ifNull: ["$devices", []] } },
          },
        },
        {
          $match: {
            processId: processIdMatch,
            status: { $in: ["full", "partial", "empty", "FULL", "PARTIAL", "EMPTY"] },
            cartonStatus: "FG_TO_STORE",
          },
        },
        {
          $lookup: {
            from: "devices",
            localField: "devices",
            foreignField: "_id",
            as: "devices",
          },
        },
        { $unwind: { path: "$devices", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "devicetestrecords",
            localField: "devices._id",
            foreignField: "deviceId",
            as: "deviceTestRecords",
          },
        },
        {
          $addFields: {
            "devices.testRecords": "$deviceTestRecords",
          },
        },
        {
          $group: {
            _id: "$_id",
            cartonSize: { $first: "$cartonSize" },
            packagingData: { $first: "$packagingData" },
            cartonSerial: { $first: "$cartonSerial" },
            processId: { $first: "$processId" },
            maxCapacity: { $first: "$maxCapacity" },
            status: { $first: "$status" },
            isStickerVerified: { $first: "$isStickerVerified" },
            isStickerPrinted: { $first: "$isStickerPrinted" },
            isWeightVerified: { $first: "$isWeightVerified" },
            weightCarton: { $first: "$weightCarton" },
            createdAt: { $first: "$createdAt" },
            updatedAt: { $first: "$updatedAt" },
            __v: { $first: "$__v" },
            cartonStatus: { $first: "$cartonStatus" },
            previousCartonStatus: { $first: "$previousCartonStatus" },
            previousDeviceStage: { $first: "$previousDeviceStage" },
            isReturnedFromPdi: { $first: "$isReturnedFromPdi" },
            returnedFromPdiAt: { $first: "$returnedFromPdiAt" },
            lastSentToPdiAt: { $first: "$lastSentToPdiAt" },
            cartonReworkCount: { $first: "$cartonReworkCount" },
            lastPdiNgReasonCode: { $first: "$lastPdiNgReasonCode" },
            lastPdiNgReasonText: { $first: "$lastPdiNgReasonText" },
            lastPdiNgNotes: { $first: "$lastPdiNgNotes" },
            isLooseCarton: { $first: "$isLooseCarton" },
            looseCartonAction: { $first: "$looseCartonAction" },
            sourceCartonSerial: { $first: "$sourceCartonSerial" },
            reassignedQuantity: { $first: "$reassignedQuantity" },
            actualDeviceCount: { $first: "$actualDeviceCount" },
            devices: { $push: "$devices" },
          },
        },
        { $sort: { _id: -1 } }
      ]);
      if (!cartons || cartons.length === 0) {
        return res.status(404).json({ message: "No Carton Found" });
      }
      const fallbackModelName = await getProcessFallbackModelName(processId);
      const enrichedCartons = enrichCartonDevicesForResponse({
        cartons,
        fallbackModelName,
      });
      const cartonSerials = enrichedCartons.map((c) => c.cartonSerial);

      return res.json({
        cartonSerials,
        cartonDetails: enrichedCartons,
      });
    } catch (error) {
      console.error("Error fetching carton:", error);
      res.status(500).json({ error: "Server error: " + error.message });
    }
  },
  getCartonByProcessIdToPDI: async (req, res) => {
    try {
      const { processId } = req.params;
      const processIdMatch = buildProcessIdMatch(processId);
      if (!processIdMatch) {
        return res.status(400).json({ message: "Invalid process id." });
      }

      const cartons = await cartonModel.aggregate([
        {
          $match: {
            processId: processIdMatch,
          },
        },
        {
          $addFields: {
            actualDeviceCount: { $size: { $ifNull: ["$devices", []] } },
            normalizedStatus: {
              $toUpper: {
                $trim: {
                  input: { $ifNull: ["$status", ""] },
                },
              },
            },
            normalizedCartonStatus: {
              $toUpper: {
                $trim: {
                  input: { $ifNull: ["$cartonStatus", ""] },
                },
              },
            },
          },
        },
        {
          $match: {
            normalizedStatus: { $in: ["FULL", "PARTIAL", "EMPTY"] },
            normalizedCartonStatus: "PDI",
          },
        },
        {
          $lookup: {
            from: "devices",
            localField: "devices",
            foreignField: "_id",
            as: "devices",
          },
        },
        { $unwind: { path: "$devices", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "devicetestrecords",
            localField: "devices._id",
            foreignField: "deviceId",
            as: "deviceTestRecords",
          },
        },
        {
          $addFields: {
            "devices.testRecords": "$deviceTestRecords",
          },
        },
        {
          $group: {
            _id: "$_id",
            cartonSize: { $first: "$cartonSize" },
            packagingData: { $first: "$packagingData" },
            cartonSerial: { $first: "$cartonSerial" },
            processId: { $first: "$processId" },
            maxCapacity: { $first: "$maxCapacity" },
            status: { $first: "$status" },
            isStickerVerified: { $first: "$isStickerVerified" },
            isStickerPrinted: { $first: "$isStickerPrinted" },
            isWeightVerified: { $first: "$isWeightVerified" },
            weightCarton: { $first: "$weightCarton" },
            createdAt: { $first: "$createdAt" },
            updatedAt: { $first: "$updatedAt" },
            __v: { $first: "$__v" },
            cartonStatus: { $first: "$cartonStatus" },
            previousCartonStatus: { $first: "$previousCartonStatus" },
            previousDeviceStage: { $first: "$previousDeviceStage" },
            isReturnedFromPdi: { $first: "$isReturnedFromPdi" },
            returnedFromPdiAt: { $first: "$returnedFromPdiAt" },
            lastSentToPdiAt: { $first: "$lastSentToPdiAt" },
            cartonReworkCount: { $first: "$cartonReworkCount" },
            lastPdiNgReasonCode: { $first: "$lastPdiNgReasonCode" },
            lastPdiNgReasonText: { $first: "$lastPdiNgReasonText" },
            lastPdiNgNotes: { $first: "$lastPdiNgNotes" },
            isLooseCarton: { $first: "$isLooseCarton" },
            looseCartonAction: { $first: "$looseCartonAction" },
            sourceCartonSerial: { $first: "$sourceCartonSerial" },
            reassignedQuantity: { $first: "$reassignedQuantity" },
            actualDeviceCount: { $first: "$actualDeviceCount" },
            devices: { $push: "$devices" },
          },
        },
        { $sort: { _id: -1 } }
      ]);
      if (!cartons || cartons.length === 0) {
        return res.status(404).json({ message: "No Carton Found" });
      }
      const fallbackModelName = await getProcessFallbackModelName(processId);
      const enrichedCartons = enrichCartonDevicesForResponse({
        cartons,
        fallbackModelName,
      });
      const cartonSerials = enrichedCartons.map((c) => c.cartonSerial);

      return res.json({
        cartonSerials,
        cartonDetails: enrichedCartons,
      });
    } catch (error) {
      console.error("Error fetching carton:", error);
      res.status(500).json({ error: "Server error: " + error.message });
    }
  },
  // getCartonByProcessId: async (req, res) => {
  //   try {
  //     const { processId } = req.params;
  //     // const carton = await cartonModel
  //     //   .find({
  //     //     processId,
  //     //     status: { $in: ["full"] },
  //     //     cartonStatus: { $in: ["PDI"] },
  //     //   })
  //     //   .populate({
  //     //     path: "devices",
  //     //     populate: {
  //     //       path: "testRecords", // virtual field in Device schema
  //     //       model: "deviceTest",
  //     //     },
  //     //   });
  //     const carton = await cartonModel.aggregate([
  //       {
  //         $match: {
  //           processId: new mongoose.Types.ObjectId(processId),
  //           status: { $in: ["full"] },
  //           cartonStatus: { $in: ["PDI"] },
  //         },
  //       },
  //       {
  //         $lookup: {
  //           from: "devices", // exact name of your devices collection (check in MongoDB)
  //           localField: "devices",
  //           foreignField: "_id",
  //           as: "devices",
  //         },
  //       },
  //       {
  //         $unwind: "$devices",
  //       },
  //       {
  //         $lookup: {
  //           from: "devicetestrecords", // exact name of the test record collection
  //           localField: "devices._id",
  //           foreignField: "deviceId",
  //           as: "devices.testRecords", // this won't nest, but we'll fix that later
  //         },
  //       },
  //       {
  //         $group: {
  //           _id: "$_id",
  //           cartonSize: { $first: "$cartonSize" },
  //           cartonSerial: { $first: "$cartonSerial" },
  //           processId: { $first: "$processId" },
  //           maxCapacity: { $first: "$maxCapacity" },
  //           status: { $first: "$status" },
  //           weightCarton: { $first: "$weightCarton" },
  //           createdAt: { $first: "$createdAt" },
  //           updatedAt: { $first: "$updatedAt" },
  //           __v: { $first: "$__v" },
  //           cartonStatus: { $first: "$cartonStatus" },
  //           devices: {
  //             $push: {
  //               $mergeObjects: [
  //                 "$devices",
  //                 { testRecords: "$devices.testRecords" },
  //               ],
  //             },
  //           },
  //         },
  //       },
  //     ]);

  //     if (!carton) {
  //       return res.status(404).json({ message: "No Carton Found" });
  //     }
  //     res.json(carton);
  //   } catch (error) {
  //     console.error("Error fetching carton:", error);
  //     res.status(500).json({ error: "Server error" + error.message });
  //   }
  // },
  getPartialCarton: async (req, res) => {
    try {
      const { processId } = req.params;
      const processIdMatch = buildProcessIdMatch(processId);
      if (!processIdMatch) {
        return res.status(400).json({ message: "Invalid process id." });
      }
      const cartons = await cartonModel.aggregate([
        {
          $match: {
            processId: processIdMatch,
            status: { $in: ["partial", "empty"] },
            cartonStatus: { $in: [""] },
          },
        },
        {
          $sort: { updatedAt: -1, createdAt: -1, _id: -1 },
        },
        {
          $limit: 1,
        },
        {
          $addFields: {
            actualDeviceCount: { $size: { $ifNull: ["$devices", []] } },
          },
        },
        {
          $lookup: {
            from: "devices",
            localField: "devices",
            foreignField: "_id",
            as: "devices",
          },
        },
      ]);
      const carton = cartons[0];
      if (!carton) {
        return res.status(200).json([]);
      }
      const fallbackModelName = await getProcessFallbackModelName(processId);
      const latestRecordByDeviceId = await buildLatestRecordMapByDeviceIds(
        collectCartonDeviceIds([carton]),
      );
      const enrichedCarton = enrichCartonDevicesForResponse({
        cartons: [carton],
        fallbackModelName,
        latestRecordByDeviceId,
      })[0] || carton;

      res.status(200).json(enrichedCarton);
    } catch (error) {
      console.error("Error fetching carton:", error);
      res.status(500).json({ error: "Server error" });
    }
  },
  getOpenCartonsByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;
      const processIdMatch = buildProcessIdMatch(processId);
      if (!processIdMatch) {
        return res.status(400).json({ message: "Invalid process id." });
      }
      const cartons = await cartonModel.aggregate([
        {
          $match: {
            processId: processIdMatch,
            status: { $in: ["partial", "empty"] },
            cartonStatus: { $in: [""] },
          },
        },
        {
          $sort: { updatedAt: -1, createdAt: -1, _id: -1 },
        },
        {
          $addFields: {
            actualDeviceCount: { $size: { $ifNull: ["$devices", []] } },
          },
        },
        {
          $lookup: {
            from: "devices",
            localField: "devices",
            foreignField: "_id",
            as: "devices",
          },
        },
      ]);

      if (!cartons || cartons.length === 0) {
        return res.status(200).json([]);
      }
      const fallbackModelName = await getProcessFallbackModelName(processId);
      const latestRecordByDeviceId = await buildLatestRecordMapByDeviceIds(
        collectCartonDeviceIds(cartons),
      );
      const enrichedCartons = enrichCartonDevicesForResponse({
        cartons,
        fallbackModelName,
        latestRecordByDeviceId,
      });

      return res.status(200).json(enrichedCartons);
    } catch (error) {
      console.error("Error fetching open cartons:", error);
      res.status(500).json({ error: "Server error" });
    }
  },

  removeDevice: async (req, res) => {
    try {
      const {
        processId,
        cartonSerial: rawCartonSerial,
        deviceSerial: rawDeviceSerial,
        deviceId: rawDeviceId,
      } = req.body || {};

      const cartonSerial = String(rawCartonSerial || "").trim();
      const deviceSerial = String(rawDeviceSerial || "").trim();
      const normalizedDeviceSerial = deviceSerial.toLowerCase();
      const deviceId = String(rawDeviceId || "").trim();
      const processIdMatch = buildProcessIdMatch(processId);
      const buildHttpError = (status, message) => {
        const error = new Error(message);
        error.status = status;
        return error;
      };

      if (!processIdMatch) {
        return res.status(400).json({
          status: 400,
          message: "Invalid process id.",
        });
      }
      if (!cartonSerial) {
        return res.status(400).json({
          status: 400,
          message: "Carton serial is required.",
        });
      }
      if (!deviceSerial && !deviceId) {
        return res.status(400).json({
          status: 400,
          message: "Device serial or device id is required.",
        });
      }

      const carton = await cartonModel.findOne({
        processId: processIdMatch,
        cartonSerial,
      }).lean();

      if (!carton) {
        return res.status(404).json({
          status: 404,
          message: "Carton not found for this process.",
        });
      }

      if (!isPackagingOpenCarton(carton)) {
        return res.status(409).json({
          status: 409,
          message:
            "Device removal is allowed only for cartons in packaging state (full/partial/empty).",
        });
      }

      const cartonDeviceIds = normalizeObjectIdList(carton.devices);
      const cartonDeviceDocs = cartonDeviceIds.length
        ? await deviceModel
          .find({ _id: { $in: cartonDeviceIds } })
          .select("_id serialNo")
          .lean()
        : [];

      const targetDevice = cartonDeviceDocs.find((deviceDoc) => {
        const currentDeviceId = String(deviceDoc?._id || "").trim();
        const currentSerial = String(deviceDoc?.serialNo || "")
          .trim()
          .toLowerCase();

        return (
          (deviceId && currentDeviceId === deviceId) ||
          (normalizedDeviceSerial && currentSerial === normalizedDeviceSerial)
        );
      });

      if (!targetDevice?._id) {
        return res.status(404).json({
          status: 404,
          message: "Device not found in the selected carton.",
        });
      }

      const targetDeviceId = String(targetDevice._id);
      const targetDeviceSerial = String(targetDevice.serialNo || deviceSerial || "").trim();

      const processDoc = await ProcessModel.findById(carton.processId)
        .select("stages commonStages")
        .lean();
      const stageConfig = [
        ...(Array.isArray(processDoc?.stages) ? processDoc.stages : []),
        ...(Array.isArray(processDoc?.commonStages) ? processDoc.commonStages : []),
      ];
      const packagingStageNames = Array.from(
        new Set(
          stageConfig
            .filter((stage) => {
              const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
              return subSteps.some(
                (subStep) => subStep?.isPackagingStatus && !subStep?.disabled,
              );
            })
            .map((stage) => getStageLabel(stage))
            .filter(Boolean),
        ),
      );

      const latestPassQuery = {
        deviceId: targetDevice._id,
        processId: carton.processId,
        status: { $regex: /^(pass|completed)$/i },
      };
      if (packagingStageNames.length > 0) {
        latestPassQuery.$or = [
          { stageName: { $in: packagingStageNames } },
          { currentLogicalStage: { $in: packagingStageNames } },
        ];
      }

      let latestPassRecord = await deviceTestModel
        .findOne(latestPassQuery)
        .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
        .lean();

      if (!latestPassRecord?._id) {
        // Fallback path: allow packaging carton removal even when historical
        // packaging pass records are missing. We skip rollback bookkeeping
        // and only remove from carton safely.
        let refreshedCarton = null;

        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const cartonDoc = await cartonModel.findOne({
              _id: carton._id,
              processId: carton.processId,
              cartonSerial,
            }).session(session);

            if (!cartonDoc) {
              throw buildHttpError(404, "Carton not found for this process.");
            }
            if (!isPackagingOpenCarton(cartonDoc)) {
              throw buildHttpError(
                409,
                "Device removal is allowed only for cartons in packaging state (full/partial/empty).",
              );
            }

            const beforeDeviceIds = Array.isArray(cartonDoc.devices) ? [...cartonDoc.devices] : [];
            const deviceExistsInCarton = beforeDeviceIds.some(
              (cartonDeviceId) => String(cartonDeviceId) === targetDeviceId,
            );
            if (!deviceExistsInCarton) {
              throw buildHttpError(409, "Device is no longer present in the selected carton.");
            }

            cartonDoc.devices = beforeDeviceIds.filter(
              (cartonDeviceId) => String(cartonDeviceId) !== targetDeviceId,
            );
            const resolvedCapacity = resolveCartonMaxCapacity(cartonDoc);
            cartonDoc.status = resolveCartonStatusFromDeviceCount(
              cartonDoc.devices.length,
              resolvedCapacity,
            );
            cartonDoc.isStickerPrinted = false;
            cartonDoc.isStickerVerified = false;
            cartonDoc.isWeightVerified = false;
            await cartonDoc.save({ session });

            let removedDeviceStageName = "";
            const deviceDoc = await deviceModel.findById(targetDevice._id).session(session);
            if (deviceDoc) {
              removedDeviceStageName = normalizeStageText(deviceDoc.currentStage);
              deviceDoc.cartonSerial = "";
              deviceDoc.updatedAt = new Date();
              await deviceDoc.save({ session });
            }

            await createCartonHistoryEvent({
              carton: cartonDoc,
              eventType: "CARTON_DEVICE_REMOVED",
              performedBy: req.user?.id,
              fromCartonStatus: normalizeStageText(cartonDoc.cartonStatus),
              toCartonStatus: normalizeStageText(cartonDoc.cartonStatus),
              fromDeviceStage: removedDeviceStageName,
              toDeviceStage: removedDeviceStageName,
              notes: `Removed device ${targetDeviceSerial} from carton. Rollback skipped because no packaging pass record was found.`,
              extra: {
                removedDeviceId: targetDeviceId,
                removedDeviceSerial: targetDeviceSerial,
                remainingDeviceCount: Number(cartonDoc.devices.length || 0),
                maxCapacity: resolvedCapacity,
                rollbackSkipped: true,
                rollbackSkipReason: "PACKAGING_PASS_RECORD_MISSING",
              },
              session,
            });

            refreshedCarton = await cartonModel
              .findById(cartonDoc._id)
              .populate("devices")
              .session(session)
              .lean();
          });
        } finally {
          await session.endSession();
        }

        return res.status(200).json({
          status: 200,
          message: "Device removed from carton successfully.",
          carton: refreshedCarton || carton,
          rollback: {
            skipped: true,
            reason: "PACKAGING_PASS_RECORD_MISSING",
          },
        });
      }

      const DOWNSTREAM_STAGE_KEYS = new Set([
        "pdi",
        "fg to store",
        "fg_to_store",
        "fg-to-store",
        "store",
        "dispatch",
      ]);
      const isDownstreamStage = (stageName = "") =>
        DOWNSTREAM_STAGE_KEYS.has(normalizeStageKey(stageName));

      let rollbackStageName = getRecordStageName(latestPassRecord);
      if (isDownstreamStage(rollbackStageName)) {
        const previousDeviceStage = normalizeStageText(carton?.previousDeviceStage);
        if (previousDeviceStage && !isDownstreamStage(previousDeviceStage)) {
          const previousStageScopedRecord = await deviceTestModel
            .findOne({
              deviceId: targetDevice._id,
              processId: carton.processId,
              status: { $regex: /^(pass|completed)$/i },
              $or: [
                { stageName: previousDeviceStage },
                { currentLogicalStage: previousDeviceStage },
              ],
            })
            .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
            .lean();

          if (previousStageScopedRecord?._id) {
            latestPassRecord = previousStageScopedRecord;
            rollbackStageName = getRecordStageName(previousStageScopedRecord);
          }
        }
      }

      if (packagingStageNames.length > 0 && isDownstreamStage(rollbackStageName)) {
        const packagingScopedPassRecord = await deviceTestModel
          .findOne({
            deviceId: targetDevice._id,
            processId: carton.processId,
            status: { $regex: /^(pass|completed)$/i },
            $or: [
              { stageName: { $in: packagingStageNames } },
              { currentLogicalStage: { $in: packagingStageNames } },
            ],
          })
          .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
          .lean();

        if (packagingScopedPassRecord?._id) {
          latestPassRecord = packagingScopedPassRecord;
          rollbackStageName = getRecordStageName(packagingScopedPassRecord);
        }
      }

      if (!rollbackStageName) {
        return res.status(409).json({
          status: 409,
          message: "Cannot rollback carton removal because source stage could not be resolved.",
        });
      }
      if (isDownstreamStage(rollbackStageName)) {
        return res.status(409).json({
          status: 409,
          message:
            "Cannot rollback carton removal because a packaging-stage source record could not be resolved.",
        });
      }

      const stageOrderMap = new Map();
      [...(Array.isArray(processDoc?.stages) ? processDoc.stages : []), ...(Array.isArray(processDoc?.commonStages) ? processDoc.commonStages : [])]
        .forEach((stage, index) => {
          const key = normalizeStageKey(getStageLabel(stage));
          if (key && !stageOrderMap.has(key)) {
            stageOrderMap.set(key, index);
          }
        });
      const rollbackStageKey = normalizeStageKey(rollbackStageName);
      const rollbackStageIndex = stageOrderMap.has(rollbackStageKey)
        ? Number(stageOrderMap.get(rollbackStageKey))
        : -1;

      const downstreamQuery = {
        deviceId: targetDevice._id,
        processId: carton.processId,
        createdAt: { $gt: latestPassRecord.createdAt },
        _id: { $ne: latestPassRecord._id },
      };
      if (latestPassRecord?.planId && mongoose.Types.ObjectId.isValid(String(latestPassRecord.planId))) {
        downstreamQuery.planId = latestPassRecord.planId;
      }
      const downstreamRecords = await deviceTestModel
        .find(downstreamQuery)
        .select("status stageName currentLogicalStage currentStage createdAt")
        .sort({ createdAt: 1, _id: 1 })
        .lean();

      const downstreamRecord = (Array.isArray(downstreamRecords) ? downstreamRecords : []).find((record) => {
        if (isRevertedEquivalentStatus(record?.status)) return false;
        const recordStageName = getRecordStageName(record);
        const recordStageKey = normalizeStageKey(recordStageName);
        if (!recordStageKey || recordStageKey === rollbackStageKey) return false;

        if (rollbackStageIndex >= 0 && stageOrderMap.has(recordStageKey)) {
          return Number(stageOrderMap.get(recordStageKey)) > rollbackStageIndex;
        }

        return true;
      });

      if (downstreamRecord) {
        return res.status(409).json({
          status: 409,
          message:
            "Cannot remove this device from carton because newer downstream stage activity already exists.",
          downstreamStage: getRecordStageName(downstreamRecord),
        });
      }

      let refreshedCarton = null;
      let revertedDevice = null;
      let rollbackSummary = null;

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const cartonDoc = await cartonModel.findOne({
            _id: carton._id,
            processId: carton.processId,
            cartonSerial,
          }).session(session);

          if (!cartonDoc) {
            throw buildHttpError(404, "Carton not found for this process.");
          }
          if (!isPackagingOpenCarton(cartonDoc)) {
            throw buildHttpError(
              409,
              "Device removal is allowed only for cartons in packaging state (full/partial/empty).",
            );
          }

          const latestPassRecordDoc = await deviceTestModel
            .findById(latestPassRecord._id)
            .session(session);
          if (!latestPassRecordDoc) {
            throw buildHttpError(
              409,
              "Unable to rollback carton removal because the packaging pass record is missing.",
            );
          }

          const latestStatus = normalizeStageKey(latestPassRecordDoc.status);
          if (!["pass", "completed"].includes(latestStatus)) {
            throw buildHttpError(
              409,
              "This carton removal has already been reverted or superseded by another update.",
            );
          }

          const beforeDeviceIds = Array.isArray(cartonDoc.devices) ? [...cartonDoc.devices] : [];
          const deviceExistsInCarton = beforeDeviceIds.some(
            (cartonDeviceId) => String(cartonDeviceId) === targetDeviceId,
          );
          if (!deviceExistsInCarton) {
            throw buildHttpError(409, "Device is no longer present in the selected carton.");
          }

          if (!latestPassRecordDoc?.planId || !mongoose.Types.ObjectId.isValid(String(latestPassRecordDoc.planId))) {
            throw buildHttpError(
              409,
              "Cannot rollback carton removal because planning context is missing.",
            );
          }

          const planDoc = await planingModel.findById(latestPassRecordDoc.planId).session(session);
          if (!planDoc) {
            throw buildHttpError(
              404,
              "Planning data not found for rollback. Please contact production manager.",
            );
          }

          const assignedStagesRaw = safeParseJson(planDoc.assignedStages, {});
          const currentSeatKey = normalizeStageText(
            latestPassRecordDoc.currentSeatKey || latestPassRecordDoc.seatNumber,
          );
          const nextSeatKey = normalizeStageText(latestPassRecordDoc.assignedSeatKey);
          const nextStageName = normalizeStageText(latestPassRecordDoc.nextLogicalStage);
          const adjustment = adjustAssignedStagesForCartonRemoval({
            assignedStages: assignedStagesRaw,
            currentSeatKey,
            currentStageName: rollbackStageName,
            nextSeatKey,
            nextStageName,
          });
          planDoc.assignedStages = JSON.stringify(adjustment.assignedStages || {});
          await planDoc.save({ session });

          const existingDescription = normalizeStageText(latestPassRecordDoc.ngDescription);
          const rollbackOperator = normalizeStageText(
            req.user?.id ||
              req.user?._id ||
              latestPassRecordDoc.operatorId,
          );
          const rollbackReason = `Removed from carton ${cartonSerial} at ${new Date().toISOString()} by ${rollbackOperator || "system"}`;
          latestPassRecordDoc.status = "Reverted";
          latestPassRecordDoc.ngDescription = existingDescription
            ? `${existingDescription} | ${rollbackReason}`
            : rollbackReason;
          await latestPassRecordDoc.save({ session });

          const deviceDoc = await deviceModel.findById(targetDevice._id).session(session);
          if (!deviceDoc) {
            throw buildHttpError(404, "Device not found while applying rollback.");
          }
          deviceDoc.cartonSerial = "";
          deviceDoc.currentStage = rollbackStageName;
          deviceDoc.status = "Pending";
          deviceDoc.updatedAt = new Date();
          await deviceDoc.save({ session });

          cartonDoc.devices = beforeDeviceIds.filter(
            (cartonDeviceId) => String(cartonDeviceId) !== targetDeviceId,
          );
          const resolvedCapacity = resolveCartonMaxCapacity(cartonDoc);
          cartonDoc.status = resolveCartonStatusFromDeviceCount(
            cartonDoc.devices.length,
            resolvedCapacity,
          );
          cartonDoc.isStickerPrinted = false;
          cartonDoc.isStickerVerified = false;
          cartonDoc.isWeightVerified = false;
          await cartonDoc.save({ session });

          await createCartonHistoryEvent({
            carton: cartonDoc,
            eventType: "CARTON_DEVICE_REMOVED",
            performedBy: req.user?.id || req.user?._id,
            fromCartonStatus: normalizeStageText(cartonDoc.cartonStatus),
            toCartonStatus: normalizeStageText(cartonDoc.cartonStatus),
            fromDeviceStage: rollbackStageName,
            toDeviceStage: rollbackStageName,
            notes: `Removed device ${targetDeviceSerial} from carton and reverted packaging pass.`,
            extra: {
              removedDeviceId: targetDeviceId,
              removedDeviceSerial: targetDeviceSerial,
              remainingDeviceCount: Number(cartonDoc.devices.length || 0),
              maxCapacity: resolvedCapacity,
              revertedTestRecordId: String(latestPassRecordDoc._id),
              revertedStatus: "Reverted",
              rollbackReason,
              rollbackOperator,
              rollbackStageName,
              currentSeatKey,
              nextSeatKey,
              nextStageName,
              countersRollbackApplied: {
                currentStage: adjustment.currentApplied,
                nextStage: adjustment.nextApplied,
              },
            },
            session,
          });

          refreshedCarton = await cartonModel
            .findById(cartonDoc._id)
            .populate("devices")
            .session(session)
            .lean();

          revertedDevice = {
            id: String(deviceDoc._id),
            serialNo: normalizeStageText(deviceDoc.serialNo || targetDeviceSerial),
            currentStage: normalizeStageText(deviceDoc.currentStage),
            status: normalizeStageText(deviceDoc.status || "Pending"),
          };

          rollbackSummary = {
            recordId: String(latestPassRecordDoc._id),
            status: normalizeStageText(latestPassRecordDoc.status || "Reverted"),
            reason: rollbackReason,
            operatorId: rollbackOperator || "",
          };
        });
      } finally {
        await session.endSession();
      }

      return res.status(200).json({
        status: 200,
        message: "Device removed from carton successfully.",
        carton: refreshedCarton || carton,
        revertedDevice,
        rollback: rollbackSummary,
      });
    } catch (error) {
      console.error("Error removing device from carton:", error);
      const statusCode = Number(error?.status || 500);
      return res.status(statusCode).json({
        status: statusCode,
        message: error?.message || "Error removing device from carton.",
        error: error.message,
      });
    }
  },

  shiftToNextCommonStage: async (req, res) => {
    try {
      const { selectedCarton } = req.body;

      if (!selectedCarton) {
        return res
          .status(400)
          .json({ success: false, message: "Carton serial is required" });
      }
      const carton = await cartonModel.findOne({ cartonSerial: selectedCarton });

      if (!carton) {
        return res
          .status(404)
          .json({ success: false, message: "Carton not found" });
      }
      const fromCartonStatus = String(carton.cartonStatus || "").trim();
      const fromDeviceStage = await findDeviceStageForCarton(carton);
      carton.cartonStatus = "FG_TO_STORE";
      await carton.save();

      const devicesUpdate = await deviceModel.updateMany(
        { _id: { $in: carton.devices } },
        {
          $set: {
            currentStage: "FG_TO_STORE",
          },
        }
      );

      await createCartonHistoryEvent({
        carton,
        eventType: "SHIFT_TO_FG_TO_STORE",
        performedBy: req.user?.id || req.user?._id,
        fromCartonStatus,
        toCartonStatus: "FG_TO_STORE",
        fromDeviceStage,
        toDeviceStage: "FG_TO_STORE",
      });

      return res.status(200).json({
        success: true,
        carton,
        updatedDevices: devicesUpdate.modifiedCount,
        message: `Carton and ${devicesUpdate.modifiedCount} devices shifted to FG_TO_STORE successfully`,
      });
    } catch (error) {
      console.error("Error updating carton/devices:", error);
      res.status(500).json({ error: "Server error" });
    }
  },

  verifySticker: async (req, res) => {
    try {
      const { cartonSerial } = req.body;
      if (!cartonSerial) {
        return res
          .status(400)
          .json({ status: 400, message: "Carton serial is required." });
      }

      const updatedCarton = await cartonModel.findOneAndUpdate(
        { cartonSerial },
        { isStickerVerified: true },
        { new: true }
      );

      if (!updatedCarton) {
        return res
          .status(404)
          .json({ status: 404, message: "Carton not found." });
      }

      return res.status(200).json({
        status: 200,
        message: "Carton verified successfully.",
        carton: updatedCarton,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Error verifying carton.",
        error: error.message,
      });
    }
  },
  shiftToPDI: async (req, res) => {
    try {
      const { cartons } = req.body;

      if (!cartons || (Array.isArray(cartons) && cartons.length === 0)) {
        return res
          .status(400)
          .json({ success: false, message: "No cartons provided" });
      }

      const cartonArray = Array.isArray(cartons) ? cartons : [cartons];

      const unverifiedCartons = await cartonModel.find({
        cartonSerial: { $in: cartonArray },
        isStickerVerified: { $ne: true },
      });

      if (unverifiedCartons.length > 0) {
        const unverifiedSerials = unverifiedCartons.map((c) => c.cartonSerial);
        return res.status(400).json({
          success: false,
          message:
            "Some cartons are not verified. Please verify all cartons before shifting to PDI.",
          unverifiedCartons: unverifiedSerials,
        });
      }

      const affectedCartons = await cartonModel.find({
        cartonSerial: { $in: cartonArray },
      });

      if (!affectedCartons.length) {
        return res.status(404).json({
          success: false,
          message: "No cartons found for the provided serials.",
        });
      }

      await processLogModel.create({
        action: "SHIFT_CARTON",
        processId: affectedCartons[0].processId,
        userId: req.user.id,
        description: `Shifted ${cartonArray.length} cartons to PDI: ${cartonArray.join(", ")}`,
      });

      const allDeviceIds = [];
      for (const carton of affectedCartons) {
        const fromCartonStatus = String(carton.cartonStatus || "").trim();
        const fromDeviceStage = await findDeviceStageForCarton(carton);
        const wasReturnedFromPdi = Boolean(carton.isReturnedFromPdi);
        carton.previousCartonStatus = fromCartonStatus;
        carton.previousDeviceStage = fromDeviceStage;
        carton.lastSentToPdiAt = new Date();
        carton.isReturnedFromPdi = false;
        carton.cartonStatus = "PDI";
        await carton.save();
        allDeviceIds.push(...(Array.isArray(carton.devices) ? carton.devices : []));

        await createCartonHistoryEvent({
          carton,
          eventType: wasReturnedFromPdi ? "RETURN_TO_PDI" : "SHIFT_TO_PDI",
          performedBy: req.user?.id || req.user?._id,
          fromCartonStatus,
          toCartonStatus: "PDI",
          fromDeviceStage,
          toDeviceStage: "PDI",
          reasonCode: wasReturnedFromPdi ? carton.lastPdiNgReasonCode || "" : "",
          reasonText: wasReturnedFromPdi ? carton.lastPdiNgReasonText || "" : "",
          notes: wasReturnedFromPdi ? carton.lastPdiNgNotes || "" : "",
        });
      }

      await deviceModel.updateMany(
        { _id: { $in: allDeviceIds } },
        { $set: { currentStage: "PDI" } }
      );

      return res.status(200).json({
        success: true,
        shifted: affectedCartons.length,
        message: "Cartons and devices shifted to PDI successfully",
      });
    } catch (error) {
      console.error("Error in shiftToPDI:", error);
      return res
        .status(500)
        .json({ success: false, error: "Failed to shift cartons" });
    }
  },
  markPdiCartonNg: async (req, res) => {
    try {
      const { cartonSerial, reasonCode, notes = "" } = req.body;

      if (!cartonSerial || !reasonCode) {
        return res.status(400).json({
          success: false,
          message: "Carton serial and reason are required.",
        });
      }

      const reasonText = PDI_CARTON_NG_REASONS[reasonCode];
      if (!reasonText) {
        return res.status(400).json({
          success: false,
          message: "Invalid carton NG reason.",
        });
      }

      const carton = await cartonModel.findOne({ cartonSerial });
      if (!carton) {
        return res.status(404).json({
          success: false,
          message: "Carton not found.",
        });
      }

      if (String(carton.cartonStatus || "").trim() !== "PDI") {
        return res.status(400).json({
          success: false,
          message: "Only cartons in PDI can be marked NG.",
        });
      }

      const { returnCartonStatus, returnDeviceStage } = await resolveReturnContextForCarton(carton);
      if (!returnDeviceStage) {
        return res.status(400).json({
          success: false,
          message: "Previous packaging stage not found for this carton.",
        });
      }

      const fromDeviceStage = (await findDeviceStageForCarton(carton)) || "PDI";
      const fromCartonStatus = String(carton.cartonStatus || "").trim();

      await createCartonHistoryEvent({
        carton,
        eventType: "PDI_CARTON_NG",
        performedBy: req.user?.id,
        fromCartonStatus,
        toCartonStatus: returnCartonStatus,
        fromDeviceStage,
        toDeviceStage: returnDeviceStage,
        reasonCode,
        reasonText,
        notes,
      });

      carton.cartonStatus = returnCartonStatus;
      carton.isWeightVerified = false;
      carton.isStickerPrinted = false;
      carton.isStickerVerified = false;
      carton.isReturnedFromPdi = true;
      carton.returnedFromPdiAt = new Date();
      carton.cartonReworkCount = Number(carton.cartonReworkCount || 0) + 1;
      carton.lastPdiNgReasonCode = reasonCode;
      carton.lastPdiNgReasonText = reasonText;
      carton.lastPdiNgNotes = String(notes || "").trim();
      await carton.save();

      await deviceModel.updateMany(
        { _id: { $in: carton.devices } },
        { $set: { currentStage: returnDeviceStage } }
      );

      await processLogModel.create({
        action: "PDI_CARTON_NG",
        processId: carton.processId,
        userId: req.user?.id || req.user?._id,
        description: `Marked carton ${cartonSerial} as NG in PDI for ${reasonText}. Returned to ${returnDeviceStage}.`,
      });

      await createCartonHistoryEvent({
        carton,
        eventType: "RETURN_TO_PACKAGING",
        performedBy: req.user?.id || req.user?._id,
        fromCartonStatus,
        toCartonStatus: returnCartonStatus,
        fromDeviceStage,
        toDeviceStage: returnDeviceStage,
        reasonCode,
        reasonText,
        notes,
      });

      return res.status(200).json({
        success: true,
        message: `Carton ${cartonSerial} returned to packaging successfully.`,
        carton,
      });
    } catch (error) {
      console.error("Error marking PDI carton NG:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to mark carton NG.",
        error: error.message,
      });
    }
  },
  getCartonHistory: async (req, res) => {
    try {
      const { cartonSerial } = req.params;
      if (!cartonSerial) {
        return res.status(400).json({
          success: false,
          message: "Carton serial is required.",
        });
      }

      const history = await findLatestCartonHistory(cartonSerial);
      const pdiNgEvents = history.filter((event) => event.eventType === "PDI_CARTON_NG");
      const latestNgEvent = pdiNgEvents[0] || null;

      return res.status(200).json({
        success: true,
        cartonSerial,
        history,
        summary: {
          totalNgCount: pdiNgEvents.length,
          lastNgReasonCode: latestNgEvent?.reasonCode || "",
          lastNgReasonText: latestNgEvent?.reasonText || "",
          lastNgAt: latestNgEvent?.timestamp || null,
        },
      });
    } catch (error) {
      console.error("Error fetching carton history:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch carton history.",
        error: error.message,
      });
    }
  },
  fetchCurrentRunningProcessFG: async (req, res) => {
    try {
      const processes = await ProcessModel.find({
        status: { $in: ["active", "complete"] },
      }).lean();

      const orderConfirmationModelMap = await buildOrderConfirmationModelMap(
        processes.map((process) => process.orderConfirmationNo)
      );

      const processData = await Promise.all(
        processes.map(async (process) => {
          const cartons = await cartonModel
            .find({
              processId: process._id,
              cartonStatus: "FG_TO_STORE",
            })
            .lean();

          const cartonsWithDevices = await Promise.all(
            cartons.map(async (carton) => {
              const devices = await deviceModel
                .find({
                  _id: { $in: carton.devices },
                })
                .lean();

              return {
                ...carton,
                devices,
              };
            })
          );

          const resolvedModelName =
            orderConfirmationModelMap.get(normalizeOrderConfirmationNo(process.orderConfirmationNo)) || "";

          return {
            ...process,
            modelName: resolvedModelName,
            cartons: cartonsWithDevices.map((carton) => ({
              ...carton,
              modelName: String(carton?.modelName || resolvedModelName || "").trim(),
              devices: Array.isArray(carton?.devices)
                ? carton.devices.map((device) => ({
                    ...device,
                    modelName: String(device?.modelName || resolvedModelName || "").trim(),
                  }))
                : [],
            })),
          };
        })
      );

      return res.status(200).json({
        success: true,
        data: processData,
      });
    } catch (error) {
      console.error(
        "Error fetching processes with FG_TO_STORE cartons:",
        error
      );
      res.status(500).json({ success: false, error: "Server error" });
    }
  },

  keepInStore: async (req, res) => {
    try {
      const { processId } = req.params;
      const {
        selectedCarton,
        operatorId,
        planId,
        status,
        stageName,
        logs,
        timeConsumed,
      } = req.body;

      if (!selectedCarton) {
        return res
          .status(400)
          .json({ success: false, message: "Carton serial is required" });
      }

      if (!mongoose.Types.ObjectId.isValid(String(processId || ""))) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid process id." });
      }
      const processIdMatch = buildProcessIdMatch(processId);

      const process = await ProcessModel.findById(processId);
      if (!process) {
        return res
          .status(404)
          .json({ success: false, message: "Process not found." });
      }

      const requesterId = String(req.user?.id || req.user?._id || operatorId || "").trim();
      let requesterUserType = normalizeRoleToken(req.user?.userType);
      if (!requesterUserType && requesterId && mongoose.Types.ObjectId.isValid(requesterId)) {
        const requesterDoc = await userModel
          .findById(requesterId)
          .select("userType")
          .lean();
        requesterUserType = normalizeRoleToken(requesterDoc?.userType);
      }

      const productDoc = process?.selectedProduct
        ? await productModel
            .findById(process.selectedProduct)
            .select("stages commonStages")
            .lean()
        : null;

      const allowedRoles = resolveKeepInStoreAllowedRoles({
        processDoc: process,
        productDoc,
      });
      const isAdminRequester = requesterUserType === "admin";
      const hasRoleAccess =
        isAdminRequester ||
        allowedRoles.length === 0 ||
        allowedRoles.includes(requesterUserType);

      if (!hasRoleAccess) {
        const allowedRolesLabel = allowedRoles.join(", ");
        return res.status(403).json({
          success: false,
          message: allowedRolesLabel
            ? `You are not authorized to keep cartons in store. Allowed role(s): ${allowedRolesLabel}.`
            : "You are not authorized to keep cartons in store.",
          requiredRoles: allowedRoles,
        });
      }

      // 1. Fetch the carton by carton serial no
      const carton = await cartonModel.findOne({
        cartonSerial: selectedCarton,
        processId: processIdMatch,
      });
      if (!carton) {
        return res
          .status(404)
          .json({ success: false, message: "Carton not found for this process" });
      }

      const cartonWorkflowStatus = normalizeStageToken(carton?.cartonStatus);
      if (cartonWorkflowStatus !== "fg to store") {
        return res.status(409).json({
          success: false,
          message: "Keep in Store is allowed only for cartons currently in FG_TO_STORE status.",
        });
      }

      // 2. Fetch all devices in that carton
      const devices = await deviceModel.find({ _id: { $in: carton.devices } });
      if (!devices || devices.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "No devices found in this carton" });
      }

      const deviceCount = devices.length;
      const actorOperatorId = requesterId || String(operatorId || "").trim();
      const resolvedOperatorId = mongoose.Types.ObjectId.isValid(actorOperatorId)
        ? actorOperatorId
        : null;

      // 3. Create device test entries for each device in the carton
      const testEntries = devices.map((device) => ({
        deviceId: device._id,
        processId,
        operatorId: resolvedOperatorId,
        serialNo: device.serialNo,
        stageName: stageName || "FG to Store",
        status: status || "Pass",
        logs: logs || [],
        timeConsumed: timeConsumed || "0",
      }));
      await deviceTestModel.insertMany(testEntries);

      // 4. Update the count for the consumed kits into the process
      if (process) {
        process.consumedKits = (process.consumedKits || 0) + deviceCount;
        process.fgToStore = (process.fgToStore || 0) + deviceCount;
        await process.save();
      }

      // 5. Update the count for the consumed kits into the planning if planId is provided
      if (planId) {
        const planing = await planingModel.findById(planId);
        if (planing) {
          planing.consumedKit = (planing.consumedKit || 0) + deviceCount;
          await planing.save();
        }
      }

      // 6. Update the inventory of the store
      if (process && process.selectedProduct) {
        const inventory = await inventoryModel.findOne({
          productType: process.selectedProduct,
        });
        if (inventory) {
          inventory.quantity = (inventory.quantity || 0) + deviceCount;
          inventory.status = "In Stock";
          await inventory.save();
        }
      }

      // 7. Update all devices' current stage
      await deviceModel.updateMany(
        { _id: { $in: carton.devices } },
        {
          $set: {
            currentStage: "KEEP_IN_STORE",
            dispatchStatus: "READY",
            dispatchInvoiceId: null,
          },
          $unset: {
            customerName: 1,
            dispatchDate: 1,
            warrantyStartDate: 1,
            warrantyEndDate: 1,
          },
        }
      );

      // 8. Update carton status to STOCKED
      const fromCartonStatus = String(carton.cartonStatus || "").trim();
      const fromDeviceStage = await findDeviceStageForCarton(carton);
      carton.cartonStatus = "STOCKED";
      carton.dispatchStatus = "READY";
      carton.dispatchInvoiceId = null;
      carton.dispatchedCustomerName = "";
      carton.dispatchDate = null;
      carton.gatePassNumber = "";
      carton.reservedAt = null;
      carton.reservedBy = null;
      await carton.save();

      await createCartonHistoryEvent({
        carton,
        eventType: "KEEP_IN_STORE",
        performedBy: req.user?.id,
        fromCartonStatus,
        toCartonStatus: "STOCKED",
        fromDeviceStage,
        toDeviceStage: "KEEP_IN_STORE",
      });

      return res.status(200).json({
        success: true,
        message: `${deviceCount} devices from carton ${selectedCarton} kept in store successfully`,
        devicesProcessed: deviceCount,
      });
    } catch (error) {
      console.error("Error in keepInStore:", error);
      res
        .status(500)
        .json({ success: false, error: "Server error: " + error.message });
    }
  },

  getFullCartons: async (req, res) => {
    try {
      const cartons = await cartonModel.find({
        status: "full",
        $or: [
          { cartonStatus: { $in: ["", "LOOSE_CLOSED"] } },
          { cartonStatus: null },
          { cartonStatus: { $exists: false } },
        ],
      }).sort({ _id: -1 }).populate({
        path: 'processId',
        select: 'name processID'
      });

      return res.status(200).json({
        success: true,
        data: cartons
      });
    } catch (error) {
      console.error("Error fetching full cartons:", error);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  },

  updatePrinting: async (req, res) => {
    try {
      const { cartonSerial } = req.body;
      if (!cartonSerial) {
        return res.status(400).json({ status: 400, message: "Carton serial is required." });
      }

      const updatedCarton = await cartonModel.findOne({ cartonSerial });
      if (!updatedCarton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      updatedCarton.isStickerPrinted = true;
      await updatedCarton.save();

      const currentDeviceStage = await findDeviceStageForCarton(updatedCarton);
      await createCartonHistoryEvent({
        carton: updatedCarton,
        eventType: updatedCarton.isReturnedFromPdi ? "STICKER_REPRINTED" : "STICKER_PRINTED",
        performedBy: req.user?.id,
        fromCartonStatus: String(updatedCarton.cartonStatus || "").trim(),
        toCartonStatus: String(updatedCarton.cartonStatus || "").trim(),
        fromDeviceStage: currentDeviceStage,
        toDeviceStage: currentDeviceStage,
      });

      return res.status(200).json({
        status: 200,
        message: "Carton print status updated successfully.",
        carton: updatedCarton,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Error updating print status.",
        error: error.message,
      });
    }
  },

  updateWeight: async (req, res) => {
    try {
      const { cartonSerial, weight } = req.body;
      if (!cartonSerial || weight === undefined) {
        return res.status(400).json({ status: 400, message: "Carton serial and weight are required." });
      }

      const carton = await cartonModel.findOne({ cartonSerial });
      if (!carton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      const recordedWeight = normalizeWeightValue(weight);
      if (!recordedWeight) {
        return res.status(400).json({
          status: 400,
          message: "Carton weight must be a valid positive number.",
        });
      }

      const { expectedWeight, expectedTolerance, configuredCapacity } = await getConfiguredCartonWeight(carton);
      if (!expectedWeight) {
        return res.status(400).json({
          status: 400,
          message: "No carton weight specification found for this carton.",
        });
      }

      const requiresExactConfiguredWeight = !isPartialOrDerivedCarton(carton, configuredCapacity);

      if (requiresExactConfiguredWeight) {
        const toleranceScaled = Number(expectedTolerance?.scaled || 0);
        if (Math.abs(recordedWeight.scaled - expectedWeight.scaled) > toleranceScaled) {
          return res.status(400).json({
            status: 400,
            message: toleranceScaled > 0
              ? "Carton weight must be within the configured tolerance range."
              : "Weight mismatch! Please enter the correct carton weight.",
          });
        }
      } else if (recordedWeight.scaled > expectedWeight.scaled) {
        return res.status(400).json({
          status: 400,
          message: "Partial carton weight cannot exceed the configured carton weight.",
        });
      }

      carton.weightCarton = recordedWeight.numeric;
      carton.isWeightVerified = true;
      await carton.save();

      const currentDeviceStage = await findDeviceStageForCarton(carton);
      await createCartonHistoryEvent({
        carton,
        eventType: carton.isReturnedFromPdi ? "PACKAGING_WEIGHT_REVERIFIED" : "WEIGHT_VERIFIED",
        performedBy: req.user?.id,
        fromCartonStatus: String(carton.cartonStatus || "").trim(),
        toCartonStatus: String(carton.cartonStatus || "").trim(),
        fromDeviceStage: currentDeviceStage,
        toDeviceStage: currentDeviceStage,
        extra: {
          validationMode: requiresExactConfiguredWeight ? "exact" : "upper_limit",
        },
      });

      return res.status(200).json({
        status: 200,
        message: "Carton weight updated successfully.",
        carton,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Error updating carton weight.",
        error: error.message,
      });
    }
  },

  getStorePortalCartons: async (req, res) => {
    try {
      const cartons = await cartonModel.aggregate([
        {
          // Normalize "store status" across older/newer records:
          // - Prefer cartonStatus when present, otherwise fallback to status
          // - Compare case-insensitively
          $addFields: {
            storeStatus: {
              $toUpper: {
                $ifNull: [
                  {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$cartonStatus", null] },
                          { $ne: ["$cartonStatus", ""] },
                        ],
                      },
                      "$cartonStatus",
                      "$status",
                    ],
                  },
                  "",
                ],
              },
            },
          },
        },
        {
          $match: {
            storeStatus: { $in: ["FG_TO_STORE", "STOCKED", "KEPT_IN_STORE"] },
          },
        },
        {
          $lookup: {
            from: "processes",
            localField: "processId",
            foreignField: "_id",
            as: "processInfo",
          },
        },
        // Don't drop cartons if the process document is missing/mismatched.
        { $unwind: { path: "$processInfo", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "devices",
            localField: "devices",
            foreignField: "_id",
            as: "deviceDetails",
          },
        },
        {
          $project: {
            processId: 1,
            cartonSerial: 1,
            processName: { $ifNull: ["$processInfo.name", "Unknown Process"] },
            processID: { $ifNull: ["$processInfo.processID", ""] },
            orderConfirmationNo: { $ifNull: ["$processInfo.orderConfirmationNo", ""] },
            // Provide a single normalized status field for UI.
            status: "$storeStatus",
            dispatchStatus: 1,
            dispatchedCustomerName: 1,
            dispatchDate: 1,
            gatePassNumber: 1,
            createdAt: 1,
            updatedAt: 1,
            maxCapacity: 1,
            deviceCount: { $size: "$devices" },
            devices: "$deviceDetails",
          },
        },
        { $sort: { createdAt: -1 } }
      ]);

      const enrichedCartons = await attachModelNamesToCartons(
        cartons,
        (carton) => carton.orderConfirmationNo
      );

      return res.status(200).json({
        success: true,
        data: enrichedCartons,
      });
    } catch (error) {
      console.error("Error in getStorePortalCartons:", error);
      res.status(500).json({ success: false, error: "Server error: " + error.message });
    }
  },

  closeLooseCarton: async (req, res) => {
    try {
      const {
        cartonSerial,
        action = "existing",
        quantity,
        packagingData = {},
        cartonLength,
        cartonWidth,
        cartonHeight,
        cartonDepth,
        cartonWeight,
        cartonWeightTolerance,
      } = req.body;

      if (!cartonSerial) {
        return res.status(400).json({ status: 400, message: "Carton serial is required." });
      }

      const carton = await cartonModel.findOne({ cartonSerial });

      if (!carton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      const currentStatus = String(carton.status || "").toLowerCase();
      if (currentStatus !== "partial") {
        return res.status(400).json({
          status: 400,
          message: "Only partial cartons can be closed as loose cartons.",
        });
      }

      if (carton.cartonStatus && String(carton.cartonStatus).trim() !== "") {
        return res.status(400).json({
          status: 400,
          message: "This carton has already been processed.",
        });
      }

      const sourceDevices = Array.isArray(carton.devices) ? carton.devices.filter(Boolean) : [];
      const sourceQuantity = sourceDevices.length;

      if (sourceQuantity === 0) {
        return res.status(400).json({
          status: 400,
          message: "Partial carton has no devices to process.",
        });
      }

      if (action === "assign-new") {
        const resolvedQty = Number(quantity);
        const resolvedLength = Number(
          packagingData?.cartonLength ?? packagingData?.cartonDepth ?? cartonLength ?? cartonDepth,
        );
        const resolvedWidth = Number(packagingData?.cartonWidth ?? cartonWidth);
        const resolvedHeight = Number(packagingData?.cartonHeight ?? cartonHeight);
        const resolvedWeight = Number(packagingData?.cartonWeight ?? cartonWeight);
        const { processDoc, productDoc } = await getProcessAndProductDocs(carton.processId);
        const looseCartonResolvedPackaging = resolveEffectivePackagingConfig({
          cartonPackagingData: {
            ...(packagingData && typeof packagingData === "object" ? packagingData : {}),
            cartonLength: packagingData?.cartonLength ?? packagingData?.cartonDepth ?? cartonLength ?? cartonDepth,
            cartonDepth: packagingData?.cartonLength ?? packagingData?.cartonDepth ?? cartonLength ?? cartonDepth,
            cartonWeight: packagingData?.cartonWeight ?? cartonWeight,
            cartonWeightTolerance: packagingData?.cartonWeightTolerance ?? cartonWeightTolerance,
            maxCapacity: resolvedQty,
          },
          processDoc,
          productDoc,
        });
        const resolvedTolerance = Number(looseCartonResolvedPackaging?.cartonWeightTolerance ?? 0);

        if (!Number.isInteger(resolvedQty) || resolvedQty <= 0) {
          return res.status(400).json({
            status: 400,
            message: "Quantity must be a positive integer.",
          });
        }

        if (resolvedQty > sourceQuantity) {
          return res.status(400).json({
            status: 400,
            message: "Quantity cannot exceed the devices available in the partial carton.",
          });
        }

        if (!resolvedWidth || resolvedWidth <= 0 || !resolvedHeight || resolvedHeight <= 0 || !resolvedLength || resolvedLength <= 0) {
          return res.status(400).json({
            status: 400,
            message: "Carton dimensions must be greater than zero.",
          });
        }

        if (!resolvedWeight || resolvedWeight <= 0) {
          return res.status(400).json({
            status: 400,
            message: "Carton weight must be greater than zero.",
          });
        }

        if (!Number.isFinite(resolvedTolerance) || resolvedTolerance < 0) {
          return res.status(400).json({
            status: 400,
            message: "Carton weight tolerance must be zero or greater.",
          });
        }

        const movedDevices = sourceDevices.slice(0, resolvedQty);
        const remainingDevices = sourceDevices.slice(resolvedQty);
        const conflict = await findCartonConflicts(movedDevices, [carton._id]);
        if (conflict) {
          return res.status(409).json({
            status: 409,
            message: `Device already assigned to carton ${conflict.cartonSerial}.`,
          });
        }
        const newCartonSerial = `CARTON-${Date.now()}`;
        const newCarton = await cartonModel.create({
          cartonSerial: newCartonSerial,
          processId: carton.processId,
          devices: movedDevices,
          packagingData: {
            ...packagingData,
            cartonLength: resolvedLength,
            cartonWidth: resolvedWidth,
            cartonHeight: resolvedHeight,
            cartonDepth: resolvedLength,
            cartonWeight: resolvedWeight,
            cartonWeightTolerance: resolvedTolerance,
            maxCapacity: resolvedQty,
          },
          cartonSize: {
            length: String(resolvedLength),
            width: String(resolvedWidth),
            height: String(resolvedHeight),
            depth: String(resolvedLength),
          },
          maxCapacity: String(resolvedQty),
          status: "full",
          cartonStatus: "",
          weightCarton: String(resolvedWeight),
          isLooseCarton: false,
          looseCartonAction: "assign-new",
          sourceCartonSerial: carton.cartonSerial,
          reassignedQuantity: resolvedQty,
          reassignedCartonSerial: newCartonSerial,
        });

        if (remainingDevices.length === 0) {
          carton.devices = [];
          carton.status = "empty";
          carton.isLooseCarton = true;
          carton.cartonStatus = "LOOSE_CLOSED";
        } else {
          carton.devices = [];
          carton.devices = remainingDevices;
          carton.status = "partial";
          carton.isLooseCarton = true;
          carton.cartonStatus = "LOOSE_CLOSED";
        }
        carton.looseCartonAction = "assign-new";
        carton.sourceCartonSerial = carton.cartonSerial;
        carton.reassignedCartonSerial = newCarton.cartonSerial;
        carton.reassignedQuantity = resolvedQty;
        carton.looseCartonClosedAt = new Date();
        await carton.save();

        return res.status(200).json({
          status: 200,
          message: "Loose carton reassigned successfully.",
          carton,
          newCarton,
        });
      }

      // Existing carton path remains the same: close the partial carton as loose.
      carton.status = "full";
      carton.isLooseCarton = true;
      carton.cartonStatus = "LOOSE_CLOSED";
      carton.looseCartonAction = "existing";
      carton.sourceCartonSerial = carton.cartonSerial;
      carton.reassignedQuantity = sourceQuantity;
      carton.looseCartonClosedAt = new Date();
      await carton.save();

      return res.status(200).json({
        status: 200,
        message: "Loose carton closed successfully. It is now marked as full.",
        carton,
      });
    } catch (error) {
      console.error("Error in closeLooseCarton:", error);
      return res.status(500).json({
        status: 500,
        message: "Error closing loose carton.",
        error: error.message,
      });
    }
  },

  searchCartonForRepackaging: async (req, res) => {
    try {
      const { cartonSerial } = req.params;
      if (!cartonSerial) {
        return res.status(400).json({ status: 400, message: "Carton serial is required." });
      }

      const carton = await cartonModel.findOne({ cartonSerial }).populate("devices").lean();
      if (!carton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      if (!isRepackagingCartonStage(carton?.cartonStatus)) {
        return res.status(400).json({
          status: 400,
          message: `Carton is in ${carton.cartonStatus || "Packaging"} stage. Repackaging is allowed only for cartons in PDI or FG_TO_STORE stage.`,
        });
      }

      const latestRecordByDeviceId = await buildLatestRecordMapByDeviceIds(
        collectCartonDeviceIds([carton])
      );
      const fallbackModelName = await getProcessFallbackModelName(carton.processId);
      const enriched = enrichCartonDevicesForResponse({
        cartons: [carton],
        fallbackModelName,
        latestRecordByDeviceId,
      });

      const processData = await ProcessModel.findById(carton.processId).lean();
      const plan = await planingModel.findOne({
        selectedProcess: carton.processId,
        startDate: { $lte: new Date() },
        expectedEndDate: { $gte: new Date() }
      }).select("_id").lean();

      return res.status(200).json({ 
        status: 200, 
        carton: enriched[0],
        processData,
        planId: plan?._id || null
      });
    } catch (error) {
      console.error("Error searching carton for repackaging:", error);
      return res.status(500).json({ status: 500, message: "Internal server error.", error: error.message });
    }
  },

  validateDeviceForRepackaging: async (req, res) => {
    try {
      const { serialNo } = req.params;
      if (!serialNo) {
        return res.status(400).json({ status: 400, message: "Device serial is required." });
      }

      const device = await deviceModel.findOne({
        $or: [{ serialNo }, { imeiNo: serialNo }, { ccid: serialNo }],
      }).lean();

      if (!device) {
        return res.status(404).json({ status: 404, message: "Device not found." });
      }

      const currentStage = normalizeStageToken(device.currentStage);

      // Check if already in another carton
      if (device.cartonSerial) {
        const otherCarton = await cartonModel.findOne({ cartonSerial: device.cartonSerial }).lean();
        if (otherCarton && !isRepackagingCartonStage(otherCarton?.cartonStatus)) {
          return res.status(400).json({
            status: 400,
            message: `Device is already in carton ${device.cartonSerial} which is in ${otherCarton.cartonStatus || "Packaging"} stage.`,
          });
        }
      }

      // Fetch stage history
      const histories = await deviceTestModel
        .find({ deviceId: device._id })
        .sort({ createdAt: 1 })
        .select("stageName status createdAt flowVersion flowType")
        .lean();

      const latestStatus = histories.length > 0 ? histories[histories.length - 1].status : "Pass";
      const isFailed = latestStatus === "NG" || latestStatus === "Fail";

      const stageHistory = histories.map((history) => ({
        stageName: history?.stageName || "Unknown Stage",
        status: history?.status || "N/A",
        createdAt: history?.createdAt || null,
        flowVersion: history?.flowVersion || 1,
        flowType: history?.flowType || "stage",
      }));

      let isEligible = isRepackagingEligibleDeviceStage(currentStage);
      let message = "";

      if (isFailed) {
        isEligible = false;
        message = `Device has a failing status (NG) at ${histories[histories.length - 1]?.stageName || "current stage"}. It cannot be added to a carton until it passes this stage.`;
      } else if (!isEligible) {
        message = `Device is at ${device.currentStage || "Initial"} stage. Only devices in Packaging, PDI, or FG_TO_STORE can be repackaged.`;
      }

      // Fetch process data for NG assignment options
      const processData = await ProcessModel.findById(device.processID).lean();

      // Find the current active plan for this process and the PDI stage
      // This is needed for createDeviceTestEntry
      const plan = await planingModel.findOne({
        selectedProcess: device.processID,
        startDate: { $lte: new Date() },
        expectedEndDate: { $gte: new Date() }
      }).select("_id").lean();

      return res.status(200).json({ 
        status: 200, 
        isEligible,
        message,
        device: {
          ...device,
          stageHistory,
          processData
        },
        planId: plan?._id || null
      });
    } catch (error) {
      console.error("Error validating device for repackaging:", error);
      return res.status(500).json({ status: 500, message: "Internal server error.", error: error.message });
    }
  },

  repackageCarton: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { cartonSerial, deviceIds, weightCarton, maxCapacity, cartonSize } = req.body;
      if (!cartonSerial || !Array.isArray(deviceIds)) {
        return res.status(400).json({ status: 400, message: "Invalid input data." });
      }

      const carton = await cartonModel.findOne({ cartonSerial }).session(session);
      if (!carton) {
        throw new Error("Carton not found.");
      }

      const cartonWorkflowStage = resolveRepackagingCartonStage(carton?.cartonStatus);
      if (!cartonWorkflowStage) {
        throw new Error("Repackaging is allowed only for cartons in PDI, FG_TO_STORE, or STOCKED stage.");
      }

      // Update carton details if provided
      if (weightCarton !== undefined) carton.weightCarton = String(weightCarton);
      if (maxCapacity !== undefined) carton.maxCapacity = String(maxCapacity);
      if (cartonSize && typeof cartonSize === "object") {
        carton.cartonSize = {
          length: String(cartonSize.length || carton.cartonSize?.length || ""),
          width: String(cartonSize.width || carton.cartonSize?.width || ""),
          height: String(cartonSize.height || carton.cartonSize?.height || ""),
          depth: String(cartonSize.depth || carton.cartonSize?.depth || ""),
        };
      }

      const oldDeviceIds = carton.devices.map(id => String(id));
      const newDeviceIds = deviceIds.map(id => String(id));

      const addedDeviceIds = newDeviceIds.filter(id => !oldDeviceIds.includes(id));
      const removedDeviceIds = oldDeviceIds.filter(id => !newDeviceIds.includes(id));

      // Update carton
      // Ensure unique IDs
      const uniqueDeviceIds = [...new Set(deviceIds.map(id => String(id)))];
      carton.devices = uniqueDeviceIds;
      const maxCap = resolveCartonMaxCapacity(carton);
      carton.status = resolveCartonStatusFromDeviceCount(deviceIds.length, maxCap);
      await carton.save({ session });

      // Update devices added
      if (addedDeviceIds.length > 0) {
        // Remove from any other cartons they might be in
        await cartonModel.updateMany(
          { _id: { $ne: carton._id }, devices: { $in: addedDeviceIds } },
          { $pull: { devices: { $in: addedDeviceIds } } },
          { session }
        );

        // Align added devices to the target carton workflow stage.
        await deviceModel.updateMany(
          { _id: { $in: addedDeviceIds } },
          { $set: { cartonSerial: carton.cartonSerial, currentStage: cartonWorkflowStage } },
          { session }
        );
      }

      // Update devices removed
      if (removedDeviceIds.length > 0) {
        await deviceModel.updateMany(
          { _id: { $in: removedDeviceIds } },
          { $set: { cartonSerial: "" } },
          { session }
        );
      }

      const currentDeviceStage = await findDeviceStageForCarton(carton);
      await createCartonHistoryEvent({
        carton,
        eventType: "REPACKAGE",
        performedBy: req.user?.id,
        fromCartonStatus: cartonWorkflowStage,
        toCartonStatus: cartonWorkflowStage,
        fromDeviceStage: currentDeviceStage,
        toDeviceStage: currentDeviceStage,
        notes: `Repackaged: ${addedDeviceIds.length} added, ${removedDeviceIds.length} removed.`,
        session,
      });

      await session.commitTransaction();
      return res.status(200).json({ status: 200, message: "Carton repackaged successfully." });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error repackaging carton:", error);
      return res.status(500).json({ status: 500, message: error.message });
    } finally {
      session.endSession();
    }
  },

  shuffleDevices: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { 
        sourceCartonSerial, 
        targetCartonSerial, 
        deviceIdsToMove,
        sourceWeight, sourceCapacity, sourceSize,
        targetWeight, targetCapacity, targetSize
      } = req.body;
      
      if (!sourceCartonSerial || !targetCartonSerial || !Array.isArray(deviceIdsToMove)) {
        return res.status(400).json({ status: 400, message: "Invalid input data." });
      }

      const sourceCarton = await cartonModel.findOne({ cartonSerial: sourceCartonSerial }).session(session);
      const targetCarton = await cartonModel.findOne({ cartonSerial: targetCartonSerial }).session(session);

      if (!sourceCarton || !targetCarton) {
        throw new Error("One or both cartons not found.");
      }

      const sourceWorkflowStage = resolveRepackagingCartonStage(sourceCarton?.cartonStatus);
      const targetWorkflowStage = resolveRepackagingCartonStage(targetCarton?.cartonStatus);
      if (!sourceWorkflowStage || !targetWorkflowStage) {
        throw new Error("Shuffle is allowed only for cartons in PDI, FG_TO_STORE, or STOCKED stage.");
      }
      if (sourceWorkflowStage !== targetWorkflowStage) {
        throw new Error("Shuffle is allowed only between cartons in the same stage.");
      }

      // Update source details if provided
      if (sourceWeight !== undefined) sourceCarton.weightCarton = String(sourceWeight);
      if (sourceCapacity !== undefined) sourceCarton.maxCapacity = String(sourceCapacity);
      if (sourceSize && typeof sourceSize === "object") {
        sourceCarton.cartonSize = {
          length: String(sourceSize.length || sourceCarton.cartonSize?.length || ""),
          width: String(sourceSize.width || sourceCarton.cartonSize?.width || ""),
          height: String(sourceSize.height || sourceCarton.cartonSize?.height || ""),
          depth: String(sourceSize.depth || sourceCarton.cartonSize?.depth || ""),
        };
      }

      // Update target details if provided
      if (targetWeight !== undefined) targetCarton.weightCarton = String(targetWeight);
      if (targetCapacity !== undefined) targetCarton.maxCapacity = String(targetCapacity);
      if (targetSize && typeof targetSize === "object") {
        targetCarton.cartonSize = {
          length: String(targetSize.length || targetCarton.cartonSize?.length || ""),
          width: String(targetSize.width || targetCarton.cartonSize?.width || ""),
          height: String(targetSize.height || targetCarton.cartonSize?.height || ""),
          depth: String(targetSize.depth || targetCarton.cartonSize?.depth || ""),
        };
      }

      // Remove from source
      sourceCarton.devices = sourceCarton.devices.filter(id => !deviceIdsToMove.includes(String(id)));
      sourceCarton.status = resolveCartonStatusFromDeviceCount(sourceCarton.devices.length, resolveCartonMaxCapacity(sourceCarton));
      await sourceCarton.save({ session });

      // Add to target
      const targetExistingIds = new Set(targetCarton.devices.map(id => String(id)));
      const filteredMoveIds = deviceIdsToMove.filter(id => !targetExistingIds.has(String(id)));
      
      if (filteredMoveIds.length > 0) {
        targetCarton.devices.push(...filteredMoveIds);
      }
      
      targetCarton.status = resolveCartonStatusFromDeviceCount(targetCarton.devices.length, resolveCartonMaxCapacity(targetCarton));
      await targetCarton.save({ session });

      // Update devices
      await deviceModel.updateMany(
        { _id: { $in: deviceIdsToMove } },
        { $set: { cartonSerial: targetCartonSerial, currentStage: targetWorkflowStage } },
        { session }
      );

      const sourceStage = await findDeviceStageForCarton(sourceCarton);
      const targetStage = await findDeviceStageForCarton(targetCarton);

      await createCartonHistoryEvent({
        carton: sourceCarton,
        eventType: "SHUFFLE_OUT",
        performedBy: req.user?.id,
        fromCartonStatus: sourceWorkflowStage,
        toCartonStatus: sourceWorkflowStage,
        fromDeviceStage: sourceStage,
        toDeviceStage: sourceStage,
        notes: `Moved ${deviceIdsToMove.length} devices to ${targetCartonSerial}`,
        session,
      });

      await createCartonHistoryEvent({
        carton: targetCarton,
        eventType: "SHUFFLE_IN",
        performedBy: req.user?.id,
        fromCartonStatus: targetWorkflowStage,
        toCartonStatus: targetWorkflowStage,
        fromDeviceStage: targetStage,
        toDeviceStage: targetStage,
        notes: `Received ${deviceIdsToMove.length} devices from ${sourceCartonSerial}`,
        session,
      });

      await session.commitTransaction();
      return res.status(200).json({ status: 200, message: "Devices shuffled successfully." });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error shuffling devices:", error);
      return res.status(500).json({ status: 500, message: error.message });
    } finally {
      session.endSession();
    }
  },
  discardCarton: async (req, res) => {
    try {
      const { cartonSerial } = req.params;
      if (!cartonSerial) {
        return res.status(400).json({ status: 400, message: "Carton serial is required." });
      }

      const carton = await cartonModel.findOne({ cartonSerial });
      if (!carton) {
        return res.status(404).json({ status: 404, message: "Carton not found." });
      }

      if (carton.devices && carton.devices.length > 0) {
        return res.status(400).json({
          status: 400,
          message: "Only empty cartons can be discarded. Please remove all devices first.",
        });
      }

      // Create a final history event for audit before deletion
      await createCartonHistoryEvent({
        carton,
        eventType: "DISCARDED",
        performedBy: req.user?.id,
        fromCartonStatus: String(carton.cartonStatus || "").trim(),
        toCartonStatus: "DISCARDED",
        notes: "Empty carton discarded by operator.",
      });

      await cartonModel.deleteOne({ _id: carton._id });

      return res.status(200).json({
        status: 200,
        message: `Carton ${cartonSerial} has been discarded successfully.`,
      });
    } catch (error) {
      console.error("Error discarding carton:", error);
      return res.status(500).json({
        status: 500,
        message: "Error discarding carton.",
        error: error.message,
      });
    }
  },
};
