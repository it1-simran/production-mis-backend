const mongoose = require("mongoose");
const KitTransferRequest = require("../models/kitTransferRequest");
const ProcessModel = require("../models/process");
const DeviceModel = require("../models/device");
const DeviceTestRecordModel = require("../models/deviceTestModel");
const User = require("../models/User");

const normalizeSerial = (value) => String(value || "").trim();
const normalizeStage = (value) => String(value || "").trim().toLowerCase();

const buildStageSequence = (processDoc) => {
  const stages = [];
  const pushStage = (stage) => {
    const name = normalizeSerial(stage?.stageName || stage?.name || "");
    if (name) stages.push(name);
  };

  (Array.isArray(processDoc?.stages) ? processDoc.stages : []).forEach(pushStage);
  (Array.isArray(processDoc?.commonStages) ? processDoc.commonStages : []).forEach(pushStage);
  return stages;
};

const getStageIndex = (stageSequence, stageName) =>
  stageSequence.findIndex((stage) => normalizeStage(stage) === normalizeStage(stageName));

const isTransferAuditRecord = (record) => {
  const searchType = normalizeStage(record?.searchType);
  const status = normalizeStage(record?.status);
  const flowType = normalizeStage(record?.flowType);
  return (
    searchType.includes("kit transfer") ||
    status === "transferred" ||
    status === "reset" ||
    flowType === "transfer" ||
    flowType === "reset"
  );
};

const getDeviceFlowVersion = (device) => {
  const parsed = Number(device?.flowVersion);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const getCurrentFlowQuery = (deviceId, flowVersion) => {
  const parsed = Number(flowVersion || 1);
  const filter = { deviceId: mongoose.Types.ObjectId.isValid(deviceId) ? new mongoose.Types.ObjectId(String(deviceId)) : deviceId };
  
  if (parsed > 1) {
    filter.flowVersion = parsed;
  } else {
    filter.$or = [{ flowVersion: 1 }, { flowVersion: { $exists: false } }];
  }
  return filter;
};

const getCurrentFlowHistory = async (deviceId, flowVersion, session) => {
  const query = getCurrentFlowQuery(deviceId, flowVersion);
  let cursor = DeviceTestRecordModel.find(query)
    .select("stageName name status searchType flowType createdAt") // Limit fields
    .sort({ createdAt: 1 })
    .lean();
  if (session) cursor = cursor.session(session);
  return cursor;
};

const getCurrentFlowProgress = (records = [], stageSequence = []) => {
  const passed = new Set();
  for (const record of records) {
    if (isTransferAuditRecord(record)) continue;
    const status = normalizeStage(record?.status);
    if (status === "pass" || status === "completed") {
      passed.add(normalizeStage(record?.stageName || record?.name || ""));
    }
  }

  let highestIndex = -1;
  for (let index = 0; index < stageSequence.length; index += 1) {
    const stageName = stageSequence[index];
    if (!passed.has(normalizeStage(stageName))) {
      break;
    }
    highestIndex = index;
  }

  return {
    passed,
    highestIndex,
  };
};

const getCurrentDeviceStageIndex = (device, stageSequence = [], highestIndex = -1) => {
  if (highestIndex >= 0) {
    return highestIndex;
  }

  const fallbackStage = String(device?.currentStage || "").trim();
  if (!fallbackStage) {
    return -1;
  }

  return getStageIndex(stageSequence, fallbackStage);
};

const buildRequestQuery = (query = {}) => {
  const filter = {};

  if (query.status && query.status !== "all") {
    filter.status = String(query.status).trim().toUpperCase();
  }
  if (query.processId) {
    filter.$or = [
      { fromProcessId: query.processId },
      { toProcessId: query.processId },
    ];
  }
  if (query.requesterId) {
    filter.requesterId = query.requesterId;
  }
  if (query.fromDate || query.toDate) {
    filter.createdAt = {};
    if (query.fromDate) filter.createdAt.$gte = new Date(query.fromDate);
    if (query.toDate) {
      const end = new Date(query.toDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }

  return filter;
};

const shapeRequest = (doc) => {
  if (!doc) return null;
  const request = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    ...request,
    serialCount: Array.isArray(request.serials) ? request.serials.length : 0,
  };
};

const getActorId = (user) => String(user?.id || user?._id || "").trim();
const getActorLabel = (user) =>
  user?.name || user?.fullName || user?.employeeCode || user?.username || "";

module.exports = {
  createRequest: async (req, res) => {
    try {
      console.log(">>> [DEBUG_TRACE] 1: Starting createRequest");
      const { fromProcessId, toProcessId, quantity, serials, targetStage, remarks } = req.body || {};

      const parsedQuantity = Number(quantity);
      console.log(">>> [DEBUG_TRACE] 2: Parsed data:", { fromProcessId, toProcessId, parsedQuantity, serialsCount: serials?.length });
      const normalizedSerials = Array.from(
        new Set(
          (Array.isArray(serials) ? serials : [])
            .map(normalizeSerial)
            .filter(Boolean)
        )
      );

      if (!fromProcessId || !toProcessId) {
        console.log(">>> [DEBUG_TRACE] 3: Validation failed - Missing IDs");
        return res.status(400).json({ status: 400, message: "From and To process are required" });
      }

      if (!mongoose.Types.ObjectId.isValid(fromProcessId) || !mongoose.Types.ObjectId.isValid(toProcessId)) {
        console.log(">>> [DEBUG_TRACE] 3b: Validation failed - Invalid ObjectIds");
        return res.status(400).json({ status: 400, message: "Invalid process ID format" });
      }

      if (String(fromProcessId) === String(toProcessId)) {
        console.log(">>> [DEBUG_TRACE] 4: Validation failed - Same IDs");
        return res.status(400).json({ status: 400, message: "From and To process cannot be the same" });
      }
      if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
        console.log(">>> [DEBUG_TRACE] 5: Validation failed - Quantity invalid");
        return res.status(400).json({ status: 400, message: "Quantity must be a positive integer" });
      }

      console.log(">>> [DEBUG_TRACE] 6: Looking up processes");
      const [fromProcess, toProcess] = await Promise.all([
        ProcessModel.findById(fromProcessId).lean(),
        ProcessModel.findById(toProcessId).lean(),
      ]);

      if (!fromProcess || !toProcess) {
        console.log(">>> [DEBUG_TRACE] 7: Process not found");
        return res.status(404).json({ status: 404, message: "Process not found" });
      }

      console.log(">>> [DEBUG_TRACE] 8: Identifying actor");
      const actorId = getActorId(req.user);
      if (!actorId) {
        console.log(">>> [DEBUG_TRACE] 9: Unauthorized");
        return res.status(401).json({ status: 401, message: "Unauthorized user" });
      }

      const requesterUser = mongoose.Types.ObjectId.isValid(actorId) 
        ? await User.findById(actorId).lean()
        : null;

      if (String(fromProcess.selectedProduct) !== String(toProcess.selectedProduct)) {
        console.log(">>> [DEBUG_TRACE] 10: Product mismatch");
        return res.status(400).json({ status: 400, message: "Transfers are allowed only between same-product processes" });
      }

      const availableIssuedKits = Number(fromProcess.issuedKits || 0);
      if (parsedQuantity > availableIssuedKits) {
        console.log(">>> [DEBUG_TRACE] 11: Insufficient kits");
        return res.status(400).json({
          status: 400,
          message: `Quantity cannot exceed allocated kits (${availableIssuedKits})`,
        });
      }

      if (normalizedSerials.length > 0) {
        console.log(">>> [DEBUG_TRACE] 12: Validating serials");
        if (normalizedSerials.length !== parsedQuantity) {
          console.log(">>> [DEBUG_TRACE] 13: Serial count mismatch");
          return res.status(400).json({
            status: 400,
            message: "Quantity must exactly match the number of scanned serials",
          });
        }
        if (!String(targetStage || "").trim()) {
          console.log(">>> [DEBUG_TRACE] 14: Missing target stage");
          return res.status(400).json({
            status: 400,
            message: "Target stage is required when transferring devices",
          });
        }

        const destinationStageSequence = buildStageSequence(toProcess);
        const targetStageIndex = getStageIndex(destinationStageSequence, targetStage);
        if (targetStageIndex === -1) {
          console.log(">>> [DEBUG_TRACE] 15: Stage doesn't exist");
          return res.status(400).json({
            status: 400,
            message: "Selected target stage does not exist on destination process",
          });
        }

        const devices = await DeviceModel.find({
          serialNo: { $in: normalizedSerials },
          processID: fromProcess._id,
        }).lean();

        if (devices.length !== normalizedSerials.length) {
          console.log(">>> [DEBUG_TRACE] 16: Not all serials found in source");
          const foundSet = new Set(devices.map((d) => normalizeSerial(d.serialNo)));
          const missing = normalizedSerials.filter((serial) => !foundSet.has(serial));
          return res.status(400).json({
            status: 400,
            message: `Some serials do not belong to the source process: ${missing.join(", ")}`,
          });
        }

        console.log(">>> [DEBUG_TRACE] 18: Validating flow eligibility for serials");
        const validationFailures = [];
        console.log(">>> [DEBUG_TRACE] 18: Validating flow eligibility for serials (Sequential for stability)");
        for (const device of devices) {
          const startAudit = Date.now();
          const deviceFlowVersion = getDeviceFlowVersion(device);
          const currentFlowRecords = await getCurrentFlowHistory(device._id, deviceFlowVersion);
          const { highestIndex } = getCurrentFlowProgress(currentFlowRecords, destinationStageSequence);
          const effectiveCurrentIndex = getCurrentDeviceStageIndex(
            device,
            destinationStageSequence,
            highestIndex
          );

          if (targetStageIndex > effectiveCurrentIndex + 1) {
            const currentStageName =
              effectiveCurrentIndex >= 0 ? destinationStageSequence[effectiveCurrentIndex] : "Initial";
            const expectedNextStage = destinationStageSequence[effectiveCurrentIndex + 1] || "";
            validationFailures.push({
              serialNo: device.serialNo,
              currentStage: currentStageName,
              targetStage: targetStage,
              missingStage: expectedNextStage || targetStage,
              reason: `Device ${device.serialNo} must first complete ${expectedNextStage || "the earlier stage"} before moving to ${targetStage}`,
            });
          }
          console.log(`>>> [DEBUG_TRACE] 18b: Device ${device.serialNo} validated in ${Date.now() - startAudit}ms`);
        }

        if (validationFailures.length > 0) {
          console.log(">>> [DEBUG_TRACE] 19: Eligibility failed");
          return res.status(400).json({
            status: 400,
            message: validationFailures[0].reason || "Selected device is not eligible for the target stage",
            details: validationFailures,
          });
        }
      }

      if (!fromProcess.selectedProduct) {
        console.log(">>> [DEBUG_TRACE] 10b: Missing product ID on source process");
        return res.status(400).json({ status: 400, message: "Source process is missing product association" });
      }

      console.log(">>> [DEBUG_TRACE] 20: Creating database record");
      const request = await KitTransferRequest.create({
        fromProcessId: fromProcess._id,
        toProcessId: toProcess._id,
        fromProcessName: fromProcess.name || "",
        toProcessName: toProcess.name || "",
        productId: fromProcess.selectedProduct,
        productName: fromProcess.productName || toProcess.productName || "",
        quantity: parsedQuantity,
        serials: normalizedSerials,
        targetStage: String(targetStage || "").trim(),
        remarks: String(remarks || "").trim(),
        requesterId: actorId,
        requesterName: getActorLabel(requesterUser) || getActorLabel(req.user),
      });

      console.log(">>> [DEBUG_TRACE] 21: Done!");
      return res.status(201).json({
        status: 201,
        message: "Kit transfer request created successfully",
        request: shapeRequest(request),
      });
    } catch (error) {
      console.error(">>> [DEBUG_TRACE] CRASH in createRequest:", error);
      return res.status(500).json({
        status: 500,
        message: error?.message || "Failed to create kit transfer request",
        details: error?.details || error?.errors || null,
        error: error?.stack || String(error),
      });
    }
  },

  listRequests: async (req, res) => {
    try {
      const requests = await KitTransferRequest.find(buildRequestQuery(req.query))
        .sort({ createdAt: -1 })
        .lean();

      return res.status(200).json({
        status: 200,
        message: "Kit transfer requests fetched successfully",
        requests: requests.map(shapeRequest),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Failed to fetch kit transfer requests",
        error: error.message,
      });
    }
  },

  getRequestById: async (req, res) => {
    try {
      const request = await KitTransferRequest.findById(req.params.id).lean();
      if (!request) {
        return res.status(404).json({ status: 404, message: "Transfer request not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "Kit transfer request fetched successfully",
        request: shapeRequest(request),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Failed to fetch kit transfer request",
        error: error.message,
      });
    }
  },

  approveRequest: async (req, res) => {
    const session = await mongoose.startSession();
    try {
      let updatedRequest;
      await session.withTransaction(async () => {
        const request = await KitTransferRequest.findById(req.params.id).session(session);
        if (!request) {
          throw new Error("Transfer request not found");
        }
        if (request.status !== "PENDING") {
          throw new Error(`Only pending requests can be approved. Current status: ${request.status}`);
        }

        const [fromProcess, toProcess, approver] = await Promise.all([
          ProcessModel.findById(request.fromProcessId).session(session),
          ProcessModel.findById(request.toProcessId).session(session),
          User.findById(getActorId(req.user)).session(session),
        ]);

        if (!fromProcess || !toProcess) {
          throw new Error("Related process not found");
        }

        if (Number(fromProcess.issuedKits || 0) < Number(request.quantity || 0)) {
          throw new Error("Source process no longer has enough allocated kits");
        }

        const sourceDevices = Array.isArray(request.serials) && request.serials.length > 0
          ? await DeviceModel.find({
              serialNo: { $in: request.serials },
              processID: fromProcess._id,
            }).session(session)
          : [];

        const transferContext = [];
        if (Array.isArray(request.serials) && request.serials.length > 0) {
          if (sourceDevices.length !== request.serials.length) {
            throw new Error("Some devices are no longer available in the source process");
          }

          const destinationStageSequence = buildStageSequence(toProcess);
          const targetStageIndex = getStageIndex(destinationStageSequence, request.targetStage);
          if (targetStageIndex === -1) {
            throw new Error("Selected target stage does not exist on destination process");
          }

          const validationFailures = [];
          for (const device of sourceDevices) {
            const deviceFlowVersion = getDeviceFlowVersion(device);
            const currentFlowRecords = await getCurrentFlowHistory(device._id, deviceFlowVersion, session);
          const { passed, highestIndex } = getCurrentFlowProgress(
              currentFlowRecords,
              destinationStageSequence,
            );
            const effectiveCurrentIndex = getCurrentDeviceStageIndex(
              device,
              destinationStageSequence,
              highestIndex,
            );
            const targetStageName = destinationStageSequence[targetStageIndex];
            const isBackwardReset = targetStageIndex < effectiveCurrentIndex;

            transferContext.push({
              device,
              deviceFlowVersion,
              isBackwardReset,
              targetStageName,
            });

            if (!isBackwardReset) {
              const requiredStages = destinationStageSequence.slice(0, targetStageIndex);
              const missingStages = requiredStages.filter(
                (stageName) => !passed.has(normalizeStage(stageName)),
              );
              if (missingStages.length > 0) {
                validationFailures.push({
                  serialNo: device.serialNo,
                  currentStage: device.currentStage || "",
                  targetStage: targetStageName,
                  missingStage: missingStages[0],
                  missingStages,
                  direction: "FORWARD",
                });
              }
            }
          }

          if (validationFailures.length > 0) {
            const first = validationFailures[0];
            const error = new Error(
              `Device ${first.serialNo} has not passed prerequisite stage(s) for ${first.targetStage}. Missing: ${first.missingStages.join(", ")}`,
            );
            error.statusCode = 400;
            error.details = validationFailures;
            throw error;
          }
        }

        fromProcess.issuedKits = Number(fromProcess.issuedKits || 0) - Number(request.quantity || 0);
        toProcess.issuedKits = Number(toProcess.issuedKits || 0) + Number(request.quantity || 0);
        if (String(toProcess.status || "").toLowerCase() !== "active") {
          toProcess.status = "waiting_for_line_feeding";
        }
        const requiredKits = Number(toProcess.quantity || 0);
        toProcess.kitStatus =
          Number(toProcess.issuedKits || 0) >= requiredKits
            ? "issued"
            : "partially_issued";

        await Promise.all([
          fromProcess.save({ session }),
          toProcess.save({ session }),
        ]);

        if (transferContext.length > 0) {
          const now = new Date();
          const transferEntries = transferContext.map(({ device, deviceFlowVersion, isBackwardReset }) => ({
            deviceId: device._id,
            processId: toProcess._id,
            operatorId: getActorId(req.user) || null,
            serialNo: device.serialNo,
            stageName: request.targetStage || device.currentStage || "",
            status: isBackwardReset ? "Reset" : "Transferred",
            productId: device.productType || request.productId || null,
            assignedDeviceTo: "",
            ngDescription: `Transferred from ${request.fromProcessName} to ${request.toProcessName}`,
            searchType: "Kit Transfer",
            flowVersion: isBackwardReset ? getDeviceFlowVersion(device) + 1 : getDeviceFlowVersion(device),
            flowBoundary: Boolean(isBackwardReset),
            flowType: isBackwardReset ? "reset" : "transfer",
            previousFlowVersion: getDeviceFlowVersion(device),
            flowStartedAt: isBackwardReset ? now : device.flowStartedAt || null,
            logs: [
              {
                stepName: "Kit Transfer Approval",
                stepType: "manual",
                status: isBackwardReset ? "Reset" : "Pass",
                logData: {
                  reason: "",
                  description: isBackwardReset
                    ? `Reset from ${request.fromProcessName} to ${request.toProcessName} at stage ${request.targetStage || "N/A"}`
                    : `Transferred from ${request.fromProcessName} to ${request.toProcessName} at stage ${request.targetStage || "N/A"}`,
                  transferMeta: {
                    requestId: String(request._id),
                    fromProcessId: String(request.fromProcessId),
                    toProcessId: String(request.toProcessId),
                    targetStage: request.targetStage || "",
                    direction: isBackwardReset ? "RESET" : "FORWARD",
                    approvedBy: approver?.name || approver?.employeeCode || "",
                  },
                },
                createdAt: now,
              },
            ],
            startTime: now,
            endTime: now,
            createdAt: now,
            updatedAt: now,
          }));

          await DeviceTestRecordModel.insertMany(transferEntries, { session });

          for (const context of transferContext) {
            const { device, deviceFlowVersion, isBackwardReset } = context;
            device.processID = toProcess._id;
            device.currentStage = request.targetStage || device.currentStage || "";
            if (isBackwardReset) {
              device.flowVersion = deviceFlowVersion + 1;
              device.flowStartedAt = now;
              device.status = "Rework";
            }
            device.updatedAt = now;
            await device.save({ session });
          }
        }

        request.status = "APPROVED";
        request.approverId = getActorId(req.user) || null;
        request.approverName = getActorLabel(approver) || getActorLabel(req.user);
        request.approvedAt = new Date();
        updatedRequest = await request.save({ session });
      });

      return res.status(200).json({
        status: 200,
        message: "Kit transfer request approved successfully",
        request: shapeRequest(updatedRequest),
      });
    } catch (error) {
      if (error?.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
        return res.status(error.statusCode).json({
          status: error.statusCode,
          message: error.message || "Failed to approve transfer request",
          details: error.details || [],
        });
      }
      return res.status(
        /not found/i.test(error.message) ? 404 : 400
      ).json({
        status: /not found/i.test(error.message) ? 404 : 400,
        message: error.message || "Failed to approve transfer request",
      });
    } finally {
      session.endSession();
    }
  },

  rejectRequest: async (req, res) => {
    try {
      const request = await KitTransferRequest.findById(req.params.id);
      if (!request) {
        return res.status(404).json({ status: 404, message: "Transfer request not found" });
      }
      if (request.status !== "PENDING") {
        return res.status(400).json({
          status: 400,
          message: `Only pending requests can be rejected. Current status: ${request.status}`,
        });
      }

      const actorId = getActorId(req.user);
      if (!actorId) {
        return res.status(401).json({ status: 401, message: "Unauthorized user" });
      }

      const approver = await User.findById(actorId).lean();
      request.status = "REJECTED";
      request.rejectionReason = String(req.body?.rejectionReason || "").trim();
      request.approverId = actorId;
      request.approverName = getActorLabel(approver) || getActorLabel(req.user);
      request.rejectedAt = new Date();

      const updatedRequest = await request.save();

      return res.status(200).json({
        status: 200,
        message: "Kit transfer request rejected successfully",
        request: shapeRequest(updatedRequest),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Failed to reject transfer request",
        error: error.message,
      });
    }
  },
};
