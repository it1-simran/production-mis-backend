const mongoose = require("mongoose");
const { getDataAccessFilter } = require("../utils/accessControl");
const CcidTransferRequest = require("../models/ccidTransferRequest");
const ProcessModel = require("../models/process");
const DeviceModel = require("../models/device");
const User = require("../models/User");
const { normalizeForCompare, stripCcidValuesFromObject } = require("../utils/customFieldsCcid");

const normalizeCcid = (value) => String(value || "").trim();
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

const findDispatchedDeviceCcid = (devices = []) => {
  const dispatched = devices.find(
    (device) => normalizeDispatchStatus(device?.dispatchStatus) === "DISPATCHED",
  );
  return dispatched ? normalizeCcid(dispatched.ccid) : "";
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
    ccidCount: Array.isArray(request.ccids) ? request.ccids.length : 0,
  };
};

const getActorId = (user) => String(user?.id || user?._id || "").trim();
const getActorLabel = (user) =>
  user?.name || user?.fullName || user?.employeeCode || user?.username || "";

module.exports = {
  createRequest: async (req, res) => {
    try {
      const { fromProcessId, ccids, remarks } = req.body || {};

      const quantity = Array.isArray(ccids) ? ccids.length : 0;
      const parsedQuantity = Number(quantity);
      const normalizedCcids = Array.from(
        new Set(
          (Array.isArray(ccids) ? ccids : [])
            .map(normalizeCcid)
            .filter(Boolean)
        )
      );

      if (!fromProcessId) {
        return res.status(400).json({ status: 400, message: "From process is required" });
      }
      if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
        return res.status(400).json({ status: 400, message: "At least one CCID must be scanned" });
      }

      const fromProcess = await ProcessModel.findById(fromProcessId).lean();

      if (!fromProcess) {
        return res.status(404).json({ status: 404, message: "Source Process not found" });
      }

      const actorId = getActorId(req.user);
      if (!actorId) {
        return res.status(401).json({ status: 401, message: "Unauthorized user" });
      }

      const requesterUser = await User.findById(actorId).lean();

      const sourceEligibilityError = assertEligibleSourceProcess(fromProcess);
      if (sourceEligibilityError) {
        return res.status(400).json({ status: 400, message: sourceEligibilityError });
      }

      // No product type validation for CCID Transfer

      const availableIssuedKits = Number(fromProcess.issuedKits || 0);
      if (parsedQuantity > availableIssuedKits) {
        return res.status(400).json({
          status: 400,
          message: `Quantity cannot exceed allocated kits (${availableIssuedKits})`,
        });
      }

      // No target capacity validation for ESIM Removal

      if (normalizedCcids.length > 0) {
        if (normalizedCcids.length !== parsedQuantity) {
          return res.status(400).json({
            status: 400,
            message: "Quantity must exactly match the number of scanned CCIDs",
          });
        }
        // No target stage logic for ESIM Removal

        const devices = await DeviceModel.find({
          ccid: { $in: normalizedCcids },
          processID: fromProcess._id,
        }).lean();

        if (devices.length !== normalizedCcids.length) {
          const foundSet = new Set(devices.map((d) => normalizeCcid(d.ccid)));
          const missing = normalizedCcids.filter((ccid) => !foundSet.has(ccid));
          return res.status(400).json({
            status: 400,
            message: `Some CCIDs do not belong to the source process: ${missing.join(", ")}`,
          });
        }

        const dispatchedCcid = findDispatchedDeviceCcid(devices);
        if (dispatchedCcid) {
          return res.status(400).json({
            status: 400,
            message: `Device with CCID ${dispatchedCcid} is dispatched and cannot be removed`,
          });
        }

      }

      const request = await CcidTransferRequest.create({
        fromProcessId: fromProcess._id,
        fromProcessName: fromProcess.name || "",
        productId: fromProcess.selectedProduct,
        productName: fromProcess.productName || "",
        quantity: parsedQuantity,
        ccids: normalizedCcids,
        remarks: String(remarks || "").trim(),
        requesterId: actorId,
        requesterName: getActorLabel(requesterUser) || getActorLabel(req.user),
        department: req.user?.department || "",
      });

      return res.status(201).json({
        status: 201,
        message: "CCID transfer request created successfully",
        request: shapeRequest(request),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: error?.message || "Failed to create CCID transfer request",
        details: error?.details || null,
        error: error?.stack || error?.message || String(error),
      });
    }
  },

  listRequests: async (req, res) => {
    try {
      const filter = buildRequestQuery(req, req.query);
      const pageRaw = req.query.page;
      const limitRaw = req.query.limit;
      const shouldPaginate = Boolean(pageRaw || limitRaw);

      let requests;
      let meta;
      if (shouldPaginate) {
        const page = Math.max(parseInt(pageRaw, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 500);
        const skip = (page - 1) * limit;
        const [rows, total] = await Promise.all([
          CcidTransferRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
          CcidTransferRequest.countDocuments(filter),
        ]);
        requests = rows;
        meta = { page, limit, total };
      } else {
        requests = await CcidTransferRequest.find(filter).sort({ createdAt: -1 }).lean();
      }

      return res.status(200).json({
        status: 200,
        message: "CCID transfer requests fetched successfully",
        requests: requests.map(shapeRequest),
        ...(meta ? { meta } : {}),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Failed to fetch CCID transfer requests",
        error: error.message,
      });
    }
  },

  getRequestById: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid request ID" });
      }
      const request = await CcidTransferRequest.findById(req.params.id).lean();
      if (!request) {
        return res.status(404).json({ status: 404, message: "Transfer request not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "CCID transfer request fetched successfully",
        request: shapeRequest(request),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Failed to fetch CCID transfer request",
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
        const request = await CcidTransferRequest.findById(req.params.id).session(session);
        if (!request) {
          throw new Error("Transfer request not found");
        }
        if (request.status !== "PENDING") {
          throw new Error(`Only pending requests can be approved. Current status: ${request.status}`);
        }

        const [fromProcess, approver] = await Promise.all([
          ProcessModel.findById(request.fromProcessId).session(session),
          User.findById(getActorId(req.user)).session(session),
        ]);

        if (!fromProcess) {
          throw new Error("Related process not found");
        }

        const sourceEligibilityError = assertEligibleSourceProcess(fromProcess);
        if (sourceEligibilityError) {
          throw new Error(sourceEligibilityError);
        }

        const hasCcids = Array.isArray(request.ccids) && request.ccids.length > 0;
        const sourceDevices = hasCcids
          ? await DeviceModel.find({
            ccid: { $in: request.ccids },
            processID: fromProcess._id,
          }).session(session)
          : [];

        if (hasCcids && sourceDevices.length !== request.ccids.length) {
          throw new Error("Some devices are no longer available in the source process");
        }

        const dispatchedCcid = findDispatchedDeviceCcid(sourceDevices);
        if (dispatchedCcid) {
          throw new Error(`Device with CCID ${dispatchedCcid} is dispatched and cannot be removed`);
        }

        // The device stays exactly where it is (same process, same stage, same
        // serialNo) - only its CCID identity is cleared, from the root field and
        // from every matching leaf inside customFields.
        const now = new Date();
        const removedDevices = [];
        for (const device of sourceDevices) {
          const removedCcid = device.ccid;
          // customFields is a Mixed-type path - Mongoose only detects the change
          // and persists it on save() if the reassigned value is deep-different
          // from what it already had tracked. stripCcidValuesFromObject mutates
          // nested sub-objects in place, so a SHALLOW copy shares those nested
          // references with device.customFields itself - the mutation corrupts
          // Mongoose's own "old value" snapshot before it can diff, so isModified
          // comes back false and the change silently never persists. Must deep
          // clone first so the nested objects being mutated are not shared.
          const customFields = structuredClone(device.customFields || {});
          const customFieldsRemoved = stripCcidValuesFromObject(
            customFields,
            new Set([normalizeForCompare(removedCcid)]),
          );

          device.ccid = "";
          device.customFields = customFields;
          device.updatedAt = now;
          await device.save({ session });

          removedDevices.push({
            deviceId: device._id,
            serialNo: device.serialNo,
            imeiNo: device.imeiNo,
            ccid: removedCcid,
            customFieldsRemoved,
          });
        }

        request.status = "APPROVED";
        request.approverId = getActorId(req.user) || null;
        request.approverName = getActorLabel(approver) || getActorLabel(req.user);
        request.approvedAt = now;
        request.removedDevices = removedDevices;
        updatedRequest = await request.save({ session });
      });

      return res.status(200).json({
        status: 200,
        message: "ESIM Removal request approved successfully",
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
      const request = await CcidTransferRequest.findById(req.params.id);
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
        message: "CCID transfer request rejected successfully",
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
