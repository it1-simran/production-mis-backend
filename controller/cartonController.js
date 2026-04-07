const mongoose = require("mongoose");
const processLogModel = require("../models/ProcessLogs");
const cartonModel = require("../models/cartonManagement");
const cartonHistoryModel = require("../models/cartonHistory");
const deviceModel = require("../models/device");
const ProcessModel = require("../models/process");
const productModel = require("../models/Products");
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
}) => {
  if (!carton?._id || !carton?.cartonSerial || !carton?.processId) return null;
  return cartonHistoryModel.create({
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
  });
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
  return cartonHistoryModel.find({ cartonSerial }).sort({ timestamp: -1, createdAt: -1 }).lean();
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
module.exports = {
  createOrUpdate: async (req, res) => {
    try {
      const { processId, devices, packagingData: rawPackagingData } = req.body;
      const deviceIds = Array.isArray(devices) ? devices : [];
      const incomingPackagingData =
        rawPackagingData && typeof rawPackagingData === "object" ? rawPackagingData : {};

      const { processDoc, productDoc } = await getProcessAndProductDocs(processId);
      const resolvedPackaging = resolveEffectivePackagingConfig({
        cartonPackagingData: incomingPackagingData,
        processDoc,
        productDoc,
      });
      const effectivePackagingData = {
        ...incomingPackagingData,
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

      let existingCarton = await cartonModel.findOne({
        processId,
        status: { $in: ["partial", "empty"] },
      });
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

        existingCarton.devices.push(...deviceIds);
        const resolvedExistingCapacity = Number(
          existingCarton.maxCapacity || existingCarton?.packagingData?.maxCapacity || 0,
        );
        if (resolvedExistingCapacity > 0 && existingCarton.devices.length >= resolvedExistingCapacity) {
          existingCarton.status = "full";
        } else {
          existingCarton.status = "partial";
        }
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

      const newCarton = new cartonModel({
        cartonSerial: `CARTON-${Date.now()}`,
        processId,
        devices: deviceIds,
        packagingData: effectivePackagingData,
        cartonSize: {
          width: effectivePackagingData?.cartonWidth
            ? String(effectivePackagingData.cartonWidth)
            : "",
          height: effectivePackagingData?.cartonHeight
            ? String(effectivePackagingData.cartonHeight)
            : "",
          depth: effectivePackagingData?.cartonDepth
            ? String(effectivePackagingData.cartonDepth)
            : "",
        },
        maxCapacity: effectivePackagingData.maxCapacity,
        status:
          Number(effectivePackagingData.maxCapacity || 0) > 0 &&
          deviceIds.length >= Number(effectivePackagingData.maxCapacity || 0)
            ? "full"
            : "partial",
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
        performedBy: req.user?.id,
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
            status: { $in: ["full", "FULL"] },
            cartonStatus: {
              $in: [
                "",
                "PDI",
                "pdi",
                "FG_TO_STORE",
                "fg_to_store",
                "FG to Store",
                "FG TO STORE",
              ],
            },
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
            devices: { $push: "$devices" },
          },
        },
      ]);

      if (!cartons || cartons.length === 0) {
        return res.status(200).json({ cartonSerials: [], cartonDetails: [] });
      }

      // 📦 Separate arrays
      const cartonSerials = cartons.map((c) => c.cartonSerial);

      return res.json({
        cartonSerials,
        cartonDetails: cartons,
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
          $match: {
            processId: processIdMatch,
            status: "full",
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
            devices: { $push: "$devices" },
          },
        },
      ]);
      if (!cartons || cartons.length === 0) {
        return res.status(404).json({ message: "No Carton Found" });
      }
      const cartonSerials = cartons.map((c) => c.cartonSerial);

      return res.json({
        cartonSerials,
        cartonDetails: cartons,
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
            normalizedStatus: "FULL",
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
            devices: { $push: "$devices" },
          },
        },
      ]);
      if (!cartons || cartons.length === 0) {
        return res.status(404).json({ message: "No Carton Found" });
      }
      const cartonSerials = cartons.map((c) => c.cartonSerial);

      return res.json({
        cartonSerials,
        cartonDetails: cartons,
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
      const carton = await cartonModel
        .findOne({
          processId: processIdMatch,
          status: "partial",
          cartonStatus: { $in: [""] },
        })
        .populate("devices");
      if (!carton) {
        return res.status(404).json({ message: "No open carton found." });
      }

      res.status(200).json(carton);
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
      const cartons = await cartonModel
        .find({
          processId: processIdMatch,
          status: "partial",
          cartonStatus: { $in: [""] },
        })
        .populate("devices")
        .lean();

      if (!cartons || cartons.length === 0) {
        return res.status(404).json({ message: "No open cartons found." });
      }

      return res.status(200).json(cartons);
    } catch (error) {
      console.error("Error fetching open cartons:", error);
      res.status(500).json({ error: "Server error" });
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
      const carton = await cartonModel.findOneAndUpdate(
        { cartonSerial: selectedCarton },
        { $set: { cartonStatus: "FG_TO_STORE" } },
        { new: true }
      );

      if (!carton) {
        return res
          .status(404)
          .json({ success: false, message: "Carton not found" });
      }
      const devicesUpdate = await deviceModel.updateMany(
        { _id: { $in: carton.devices } },
        {
          $set: {
            currentStage: "FG_TO_STORE",
          },
        }
      );

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
          performedBy: req.user?.id,
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
        userId: req.user?.id,
        description: `Marked carton ${cartonSerial} as NG in PDI for ${reasonText}. Returned to ${returnDeviceStage}.`,
      });

      await createCartonHistoryEvent({
        carton,
        eventType: "RETURN_TO_PACKAGING",
        performedBy: req.user?.id,
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
      // Step 1: Get processes with status active/complete
      const processes = await ProcessModel.find({
        status: { $in: ["active", "complete"] },
      }).lean();

      // Step 2: Get cartons for each process
      const processData = await Promise.all(
        processes.map(async (process) => {
          const cartons = await cartonModel
            .find({
              processId: process._id,
              cartonStatus: "FG_TO_STORE",
            })
            .lean();

          // Step 3: Fetch devices for each carton
          const cartonsWithDevices = await Promise.all(
            cartons.map(async (carton) => {
              const devices = await deviceModel
                .find({
                  _id: { $in: carton.devices },
                })
                .lean();

              return {
                ...carton,
                devices, // devices + their testRecords
              };
            })
          );

          return {
            ...process,
            cartons: cartonsWithDevices,
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

      // 1. Fetch the carton by carton serial no
      const carton = await cartonModel.findOne({ cartonSerial: selectedCarton });
      if (!carton) {
        return res
          .status(404)
          .json({ success: false, message: "Carton not found" });
      }

      // 2. Fetch all devices in that carton
      const devices = await deviceModel.find({ _id: { $in: carton.devices } });
      if (!devices || devices.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "No devices found in this carton" });
      }

      const deviceCount = devices.length;

      // 3. Create device test entries for each device in the carton
      const testEntries = devices.map((device) => ({
        deviceId: device._id,
        processId,
        operatorId,
        serialNo: device.serialNo,
        stageName: stageName || "FG to Store",
        status: status || "Pass",
        logs: logs || [],
        timeConsumed: timeConsumed || "0",
      }));
      await deviceTestModel.insertMany(testEntries);

      // 4. Update the count for the consumed kits into the process
      const process = await ProcessModel.findById(processId);
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
        { $set: { currentStage: "KEEP_IN_STORE" } }
      );

      // 8. Update carton status to STOCKED
      carton.cartonStatus = "STOCKED";
      await carton.save();

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
        cartonStatus: ""
      }).populate({
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
            // Provide a single normalized status field for UI.
            status: "$storeStatus",
            createdAt: 1,
            updatedAt: 1,
            maxCapacity: 1,
            deviceCount: { $size: "$devices" },
            devices: "$deviceDetails",
          },
        },
        { $sort: { createdAt: -1 } }
      ]);

      return res.status(200).json({
        success: true,
        data: cartons,
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
        const resolvedWidth = Number(packagingData?.cartonWidth ?? cartonWidth);
        const resolvedHeight = Number(packagingData?.cartonHeight ?? cartonHeight);
        const resolvedDepth = Number(packagingData?.cartonDepth ?? cartonDepth);
        const resolvedWeight = Number(packagingData?.cartonWeight ?? cartonWeight);
        const { processDoc, productDoc } = await getProcessAndProductDocs(carton.processId);
        const looseCartonResolvedPackaging = resolveEffectivePackagingConfig({
          cartonPackagingData: {
            ...(packagingData && typeof packagingData === "object" ? packagingData : {}),
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

        if (!resolvedWidth || resolvedWidth <= 0 || !resolvedHeight || resolvedHeight <= 0 || !resolvedDepth || resolvedDepth <= 0) {
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
            cartonWidth: resolvedWidth,
            cartonHeight: resolvedHeight,
            cartonDepth: resolvedDepth,
            cartonWeight: resolvedWeight,
            cartonWeightTolerance: resolvedTolerance,
            maxCapacity: resolvedQty,
          },
          cartonSize: {
            width: String(resolvedWidth),
            height: String(resolvedHeight),
            depth: String(resolvedDepth),
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
          carton.status = "full";
          carton.isLooseCarton = true;
          carton.cartonStatus = "LOOSE_CLOSED";
        } else {
          carton.devices = remainingDevices;
          carton.status = remainingDevices.length >= Number(carton.maxCapacity || remainingDevices.length)
            ? "full"
            : "partial";
          carton.isLooseCarton = false;
          carton.cartonStatus = "";
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
};
