const mongoose = require("mongoose");
const { getDataAccessFilter } = require("../utils/accessControl");
const KitTransferRequest = require("../models/kitTransferRequest");
const ProcessModel = require("../models/process");
const ProductModel = require("../models/Products");
const DeviceModel = require("../models/device");
const DeviceTestRecordModel = require("../models/deviceTestModel");
const User = require("../models/User");

const normalizeSerial = (value) => String(value || "").trim();
const normalizeStage = (value) => String(value || "").trim().toLowerCase();
const normalizeDispatchStatus = (value) => String(value || "").trim().toUpperCase();

const assertEligibleSourceProcess = (processDoc) => {
  if (!processDoc) {
    return "Process not found";
  }
  if (normalizeDispatchStatus(processDoc.dispatchStatus) === "DISPATCHED") {
    return "Dispatched processes cannot be used as a transfer source";
  }
  if (Number(processDoc.issuedKits || 0) <= 0) {
    return "Source process has no allocated kits available for transfer";
  }
  return "";
};

const getDestinationRemainingKitCapacity = (processDoc) => {
  const requiredKits = Number(processDoc?.quantity || 0);
  const issuedKits = Number(processDoc?.issuedKits || 0);
  if (!Number.isFinite(requiredKits) || requiredKits <= 0) {
    return { requiredKits: 0, issuedKits, remaining: 0 };
  }
  return {
    requiredKits,
    issuedKits,
    remaining: Math.max(0, requiredKits - issuedKits),
  };
};

const assertDestinationKitCapacity = (processDoc, transferQuantity) => {
  const { requiredKits, issuedKits, remaining } = getDestinationRemainingKitCapacity(processDoc);
  if (requiredKits <= 0) {
    return "Destination process does not have a valid required quantity";
  }
  if (remaining <= 0) {
    return `Destination process is fully allocated (${issuedKits}/${requiredKits} required kits)`;
  }
  if (Number(transferQuantity) > remaining) {
    return `Quantity cannot exceed destination remaining capacity (${remaining} of ${requiredKits} required kits)`;
  }
  return "";
};

const findDispatchedDeviceSerial = (devices = []) => {
  const dispatched = devices.find(
    (device) => normalizeDispatchStatus(device?.dispatchStatus) === "DISPATCHED",
  );
  return dispatched ? normalizeSerial(dispatched.serialNo) : "";
};

const getStageLabel = (stage) => {
  if (typeof stage === "string") {
    return normalizeSerial(stage);
  }
  return normalizeSerial(stage?.stageName || stage?.name || "");
};

const buildStageSequence = (processDoc) => {
  const stages = [];
  const pushStage = (stage) => {
    const name = getStageLabel(stage);
    if (name) stages.push(name);
  };

  (Array.isArray(processDoc?.stages) ? processDoc.stages : []).forEach(pushStage);
  (Array.isArray(processDoc?.commonStages) ? processDoc.commonStages : []).forEach(pushStage);
  return stages;
};

const resolveTransferStageSequence = async (toProcess, fromProcess) => {
  const destinationStages = buildStageSequence(toProcess);
  if (destinationStages.length > 0) {
    return destinationStages;
  }

  const sourceStages = buildStageSequence(fromProcess);
  if (sourceStages.length > 0) {
    return sourceStages;
  }

  const productId = toProcess?.selectedProduct || fromProcess?.selectedProduct;
  if (!productId) {
    return [];
  }

  const product = await ProductModel.findById(productId).select("stages commonStages").lean();
  return buildStageSequence(product || {});
};

const getStageIndex = (stageSequence, stageName) =>
  stageSequence.findIndex((stage) => normalizeStage(stage) === normalizeStage(stageName));

const getFunctionalStageIndex = (stageSequence) =>
  stageSequence.findIndex((stage) => normalizeStage(stage).includes("functional"));

const getDeviceFlowVersion = (device) => {
  const parsed = Number(device?.flowVersion);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const buildRequestQuery = (req, query = {}) => {
  const filter = getDataAccessFilter(req, { createdByField: "requesterId" });

  if (query.status && query.status !== "all") {
    filter.status = String(query.status).trim().toUpperCase();
  }
  if (query.processId) {
    const pId = new mongoose.Types.ObjectId(query.processId);
    filter.$and = filter.$and || [];
    filter.$and.push({
      $or: [
        { fromProcessId: pId },
        { toProcessId: pId },
      ]
    });
  }
  if (query.requesterId) {
    filter.requesterId = new mongoose.Types.ObjectId(query.requesterId);
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

      const requesterUser = await User.findById(actorId).lean();

      const sourceEligibilityError = assertEligibleSourceProcess(fromProcess);
      if (sourceEligibilityError) {
        return res.status(400).json({ status: 400, message: sourceEligibilityError });
      }

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

      const destinationCapacityError = assertDestinationKitCapacity(toProcess, parsedQuantity);
      if (destinationCapacityError) {
        return res.status(400).json({ status: 400, message: destinationCapacityError });
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

        const destinationStageSequence = await resolveTransferStageSequence(toProcess, fromProcess);
        const stageExists = destinationStageSequence.some(
          (stage) => normalizeStage(stage) === normalizeStage(targetStage)
        );
        if (!stageExists) {
          console.log(">>> [DEBUG_TRACE] 15: Stage doesn't exist");
          return res.status(400).json({
            status: 400,
            message: "Selected target stage is not available for this transfer",
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

        const dispatchedSerial = findDispatchedDeviceSerial(devices);
        if (dispatchedSerial) {
          return res.status(400).json({
            status: 400,
            message: `Device ${dispatchedSerial} is dispatched and cannot be transferred`,
          });
        }

        const targetStageIndex = getStageIndex(destinationStageSequence, targetStage);
        if (targetStageIndex === -1) {
          console.log(">>> [DEBUG_TRACE] 17: Stage index -1");
          return res.status(400).json({
            status: 400,
            message: "Selected target stage is not available for this transfer",
          });
        }

        const functionalStageIndex = getFunctionalStageIndex(destinationStageSequence);
        if (functionalStageIndex !== -1 && targetStageIndex > functionalStageIndex) {
          return res.status(400).json({
            status: 400,
            message: "Destination stage must be Functional or earlier for kit transfer",
          });
        }
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
        department: req.user?.department || "",
      });

      console.log(">>> [DEBUG_TRACE] 21: Done!");
      return res.status(201).json({
        status: 201,
        message: "Kit transfer request created successfully",
        request: shapeRequest(request),
      });
    } catch (error) {
      console.error(">>> [DEBUG_TRACE] CRASH:", error);
      return res.status(500).json({
        status: 500,
        message: error?.message || "Failed to create kit transfer request",
        details: error?.details || null,
        error: error?.stack || error?.message || String(error),
      });
    }
  },

  listRequests: async (req, res) => {
    try {
      const requests = await KitTransferRequest.find(buildRequestQuery(req, req.query))
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
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid request ID" });
      }
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
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid request ID" });
      }
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

        const sourceEligibilityError = assertEligibleSourceProcess(fromProcess);
        if (sourceEligibilityError) {
          throw new Error(sourceEligibilityError);
        }

        if (Number(fromProcess.issuedKits || 0) < Number(request.quantity || 0)) {
          throw new Error("Source process no longer has enough allocated kits");
        }

        const destinationCapacityError = assertDestinationKitCapacity(toProcess, request.quantity);
        if (destinationCapacityError) {
          throw new Error(destinationCapacityError);
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

          const dispatchedSerial = findDispatchedDeviceSerial(sourceDevices);
          if (dispatchedSerial) {
            throw new Error(`Device ${dispatchedSerial} is dispatched and cannot be transferred`);
          }

          const destinationStageSequence = await resolveTransferStageSequence(toProcess, fromProcess);
          const targetStageIndex = getStageIndex(destinationStageSequence, request.targetStage);
          if (targetStageIndex === -1) {
            throw new Error("Selected target stage is not available for this transfer");
          }

          const functionalStageIndex = getFunctionalStageIndex(destinationStageSequence);
          if (functionalStageIndex !== -1 && targetStageIndex > functionalStageIndex) {
            throw new Error("Destination stage must be Functional or earlier for kit transfer");
          }

          for (const device of sourceDevices) {
            const deviceFlowVersion = getDeviceFlowVersion(device);
            const targetStageName = destinationStageSequence[targetStageIndex];

            transferContext.push({
              device,
              deviceFlowVersion,
              targetStageName,
            });
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
          const transferEntries = transferContext.map(({ device, deviceFlowVersion }) => ({
            deviceId: device._id,
            processId: toProcess._id,
            operatorId: getActorId(req.user) || null,
            serialNo: device.serialNo,
            stageName: request.targetStage || device.currentStage || "",
            status: "Reset",
            productId: device.productType || request.productId || null,
            assignedDeviceTo: "",
            ngDescription: `Transferred from ${request.fromProcessName} to ${request.toProcessName}`,
            searchType: "Kit Transfer",
            flowVersion: deviceFlowVersion + 1,
            flowBoundary: true,
            flowType: "reset",
            previousFlowVersion: deviceFlowVersion,
            flowStartedAt: now,
            logs: [
              {
                stepName: "Kit Transfer Approval",
                stepType: "manual",
                status: "Reset",
                logData: {
                  reason: "",
                  description: `Reset from ${request.fromProcessName} to ${request.toProcessName} at stage ${request.targetStage || "N/A"}`,
                  transferMeta: {
                    requestId: String(request._id),
                    fromProcessId: String(request.fromProcessId),
                    toProcessId: String(request.toProcessId),
                    targetStage: request.targetStage || "",
                    direction: "RESET",
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
            const { device, deviceFlowVersion } = context;
            device.processID = toProcess._id;
            device.currentStage = request.targetStage || device.currentStage || "";
            device.flowVersion = deviceFlowVersion + 1;
            device.flowStartedAt = now;
            device.status = "";
            device.assignedDeviceTo = "";
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
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid request ID" });
      }
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
