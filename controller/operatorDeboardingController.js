const mongoose = require("mongoose");
const { getDataAccessFilter } = require("../utils/accessControl");
const OperatorDeboardingRequest = require("../models/operatorDeboardingRequest");
const AssignOperatorToPlanModel = require("../models/assignOperatorToPlan");
const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
const User = require("../models/User");
const { freeOperatorFromOtherProcesses } = require("./processController");

const normalizeRole = (userType) =>
  String(userType || "").toLowerCase().trim().replace(/[\s-]+/g, "_");

const isAdminRole = (role) => role === "admin" || role === "administrator";
const isHrRole = (role) =>
  role === "hr" || role === "human_resource" || role === "humanresource";

const getActorId = (user) => String(user?.id || user?._id || "").trim();
const getActorLabel = (user) =>
  user?.name || user?.fullName || user?.employeeCode || user?.username || "";

const shapeRequest = (doc) => {
  if (!doc) return null;
  return typeof doc.toObject === "function" ? doc.toObject() : doc;
};

const safeParseSeatMap = (val) => {
  if (!val) return {};
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
};

// Regular seat-based assignments never carry a human-readable stage name on the
// AssignOperatorToPlan record itself (assignOperatorToProcess never sets `stageType`) — the
// stage lives in the process's Planning & Scheduling plan, keyed by seat, exactly like
// processController.js's getVacantOperator resolves it for the "Assigned" badge. A stage's
// display `name` and its `requiredSkill` are often different strings (e.g. "Power Flow &
// Code Flashing" requires skill "Power Flow") — callers that need to match against an
// operator's skills must use `requiredSkill`, not the display name.
const resolveStageInfo = (plan, seatDetails, rawStageType) => {
  const rowIdx = Number(seatDetails?.rowNumber);
  const seatIdx = Number(seatDetails?.seatNumber);
  const hasSeat = Number.isInteger(rowIdx) && Number.isInteger(seatIdx) && rowIdx >= 0 && seatIdx >= 0;
  if (hasSeat) {
    const seatMap = safeParseSeatMap(plan?.assignedStages);
    const seatKey = `${rowIdx}-${seatIdx}`;
    const stageEntry = Array.isArray(seatMap[seatKey])
      ? seatMap[seatKey]
      : seatMap[seatKey] ? [seatMap[seatKey]] : [];
    const stageName = stageEntry
      .map((s) => s?.name || s?.stageName || s?.stage)
      .filter(Boolean)
      .join(", ");
    const requiredSkill = stageEntry
      .map((s) => s?.requiredSkill)
      .filter(Boolean)
      .join(", ");
    if (stageName) return { stageName, requiredSkill: requiredSkill || stageName };
  }
  // Common/custom-stage operators (no seat) are marked with stageType "common" rather than
  // the specific stage's own name — show a readable label instead of the raw marker.
  if (rawStageType === "common") return { stageName: "Common Stage", requiredSkill: "" };
  return { stageName: rawStageType || "", requiredSkill: rawStageType || "" };
};

const buildVacatedAssignments = async (operatorId) => {
  const assignments = await AssignOperatorToPlanModel.find({
    userId: operatorId,
    status: "Occupied",
  })
    .populate("processId", "name processID")
    .lean();

  if (assignments.length === 0) return [];

  const processIds = [
    ...new Set(assignments.map((a) => String(a.processId?._id || a.processId))),
  ].filter((id) => mongoose.isValidObjectId(id));
  const plans = processIds.length
    ? await PlaningAndSchedulingModel.find({ selectedProcess: { $in: processIds } })
      .select("selectedProcess assignedStages")
      .lean()
    : [];
  const planByProcessId = new Map(plans.map((p) => [String(p.selectedProcess), p]));

  return assignments.map((a) => {
    const processIdStr = String(a.processId?._id || a.processId);
    const plan = planByProcessId.get(processIdStr);
    const { stageName, requiredSkill } = resolveStageInfo(plan, a.seatDetails, a.stageType);
    return {
      processId: a.processId?._id || a.processId,
      processName: a.processId?.name || a.processId?.processID || "",
      roomName: a.roomName,
      seatDetails: {
        rowNumber: a.seatDetails?.rowNumber || "",
        seatNumber: a.seatDetails?.seatNumber || "",
      },
      stageType: stageName,
      requiredSkill,
    };
  });
};

module.exports = {
  createRequest: async (req, res) => {
    try {
      const requesterRole = normalizeRole(req.user?.userType);
      if (!isAdminRole(requesterRole) && !isHrRole(requesterRole)) {
        return res.status(403).json({
          status: 403,
          message: "Only Admin or HR can initiate a final deboarding request.",
        });
      }

      const { operatorId } = req.body || {};
      const reason = String(req.body?.reason || "").trim();

      if (!mongoose.isValidObjectId(operatorId)) {
        return res.status(400).json({ status: 400, message: "Invalid operator id" });
      }
      if (!reason) {
        return res.status(400).json({
          status: 400,
          message: "A reason for deboarding is required.",
        });
      }

      const operator = await User.findById(operatorId).lean();
      if (!operator) {
        return res.status(404).json({ status: 404, message: "Operator not found." });
      }
      if (operator.status === "Discarded") {
        return res.status(400).json({
          status: 400,
          message: "This operator has already been deboarded.",
        });
      }

      const existingPending = await OperatorDeboardingRequest.findOne({
        operatorId,
        status: "PENDING",
      }).lean();
      if (existingPending) {
        return res.status(409).json({
          status: 409,
          message: "A deboarding request is already pending approval for this operator.",
        });
      }

      const actorId = getActorId(req.user);
      if (!actorId) {
        return res.status(401).json({ status: 401, message: "Unauthorized user" });
      }
      const requesterUser = await User.findById(actorId).lean();

      const vacatedAssignments = await buildVacatedAssignments(operatorId);

      const request = await OperatorDeboardingRequest.create({
        operatorId,
        operatorName: operator.name || "",
        employeeCode: operator.employeeCode || "",
        skills: Array.isArray(operator.skills) ? operator.skills : [],
        reason,
        requesterId: actorId,
        requesterName: getActorLabel(requesterUser) || getActorLabel(req.user),
        vacatedAssignments,
      });

      return res.status(201).json({
        status: 201,
        message: "Final deboarding request submitted for Production Manager approval.",
        request: shapeRequest(request),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: error?.message || "Failed to submit deboarding request",
      });
    }
  },

  listRequests: async (req, res) => {
    try {
      const filter = getDataAccessFilter(req, { createdByField: "requesterId" });
      const { status } = req.query || {};
      if (status && status !== "all") {
        filter.status = String(status).trim().toUpperCase();
      }

      const requests = await OperatorDeboardingRequest.find(filter)
        .sort({ createdAt: -1 })
        .limit(2000)
        .lean();

      return res.status(200).json({
        status: 200,
        message: "Operator deboarding requests fetched successfully",
        requests,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Failed to fetch operator deboarding requests",
        error: error.message,
      });
    }
  },

  getRequestById: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid request ID" });
      }
      const request = await OperatorDeboardingRequest.findById(req.params.id).lean();
      if (!request) {
        return res.status(404).json({ status: 404, message: "Deboarding request not found" });
      }
      return res.status(200).json({
        status: 200,
        message: "Operator deboarding request fetched successfully",
        request,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Failed to fetch operator deboarding request",
        error: error.message,
      });
    }
  },

  approveRequest: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid request ID" });
      }
      const request = await OperatorDeboardingRequest.findById(req.params.id);
      if (!request) {
        return res.status(404).json({ status: 404, message: "Deboarding request not found" });
      }
      if (request.status !== "PENDING") {
        return res.status(400).json({
          status: 400,
          message: `Only pending requests can be approved. Current status: ${request.status}`,
        });
      }

      const operator = await User.findById(request.operatorId);
      if (!operator) {
        return res.status(404).json({ status: 404, message: "Operator not found." });
      }

      const actorId = getActorId(req.user);
      if (!actorId) {
        return res.status(401).json({ status: 401, message: "Unauthorized user" });
      }
      const approver = await User.findById(actorId).lean();

      if (operator.status !== "Discarded") {
        // Reuses the same seat-map + assignment cleanup already trusted for reassignment,
        // so approval can never leave a stale seat/assignment behind.
        await freeOperatorFromOtherProcesses(operator._id, null);

        operator.status = "Discarded";
        operator.deboardedAt = new Date();
        operator.deboardedBy = actorId;
        operator.deboardReason = request.reason;
        await operator.save();
      }

      request.status = "APPROVED";
      request.approverId = actorId;
      request.approverName = getActorLabel(approver) || getActorLabel(req.user);
      request.approvedAt = new Date();
      await request.save();

      return res.status(200).json({
        status: 200,
        message: "Deboarding request approved. The operator has been deboarded.",
        request: shapeRequest(request),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: error?.message || "Failed to approve deboarding request",
      });
    }
  },

  // Persists that a vacated seat's replacement has been picked, so the "Assign Replacement"
  // button stays gone (replaced by "Replacement Assigned: <name>") across reloads/reopens of
  // this request — the actual seat/process assignment itself already happened via the normal
  // /operators/assign endpoint before this call; this only records it against the request.
  markReplacementAssigned: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid request ID" });
      }
      const { processId, replacementOperatorId, replacementOperatorName } = req.body || {};
      if (!mongoose.isValidObjectId(processId) || !mongoose.isValidObjectId(replacementOperatorId)) {
        return res.status(400).json({ status: 400, message: "processId and replacementOperatorId are required" });
      }

      const request = await OperatorDeboardingRequest.findById(req.params.id);
      if (!request) {
        return res.status(404).json({ status: 404, message: "Deboarding request not found" });
      }

      const entry = request.vacatedAssignments.find(
        (a) => String(a.processId) === String(processId),
      );
      if (!entry) {
        return res.status(404).json({ status: 404, message: "Vacated seat not found on this request." });
      }

      entry.replacementOperatorId = replacementOperatorId;
      entry.replacementOperatorName = replacementOperatorName || "";
      entry.replacementAssignedAt = new Date();
      await request.save();

      return res.status(200).json({
        status: 200,
        message: "Replacement recorded",
        request: shapeRequest(request),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: error?.message || "Failed to record replacement",
      });
    }
  },

  rejectRequest: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid request ID" });
      }
      const request = await OperatorDeboardingRequest.findById(req.params.id);
      if (!request) {
        return res.status(404).json({ status: 404, message: "Deboarding request not found" });
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
      await request.save();

      return res.status(200).json({
        status: 200,
        message: "Deboarding request rejected.",
        request: shapeRequest(request),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Failed to reject deboarding request",
        error: error.message,
      });
    }
  },
};
