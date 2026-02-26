const mongoose = require("mongoose");
const moment = require("moment-timezone");

const AssignOperatorToPlan = require("../models/assignOperatorToPlan");
const OperatorWorkSession = require("../models/operatorWorkSession");
const OperatorWorkEvent = require("../models/operatorWorkEvent");

const TZ = process.env.TIMEZONE || "Asia/Kolkata";

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function parseDateOnly(value) {
  if (!value) return null;
  const m = moment.tz(
    value,
    ["YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YYYY", "YYYY/MM/DD", moment.ISO_8601],
    TZ
  );
  return m.isValid() ? m.format("YYYY-MM-DD") : null;
}

function parseTimeOnly(value) {
  if (!value) return null;
  const m = moment.tz(
    value,
    ["HH:mm", "H:mm", "HH:mm:ss", "H:mm:ss", "hh:mm A", "h:mm A", "hh:mm:ss A", "h:mm:ss A"],
    TZ
  );
  return m.isValid() ? m.format("HH:mm:ss") : null;
}

function buildShiftWindow(processShiftMappings, fallbackStartDate) {
  const formattedShiftDate =
    parseDateOnly(processShiftMappings?.formattedShiftDate) ||
    (fallbackStartDate ? moment(fallbackStartDate).tz(TZ).format("YYYY-MM-DD") : null);

  const startTime = processShiftMappings?.startTime || null;
  const endTime = processShiftMappings?.endTime || null;

  const parsedStart = parseTimeOnly(startTime);
  const parsedEnd = parseTimeOnly(endTime);

  if (!formattedShiftDate || !parsedStart || !parsedEnd) {
    return {
      formattedShiftDate: processShiftMappings?.formattedShiftDate ?? null,
      startTime,
      endTime,
      shiftStartAt: null,
      shiftEndAt: null,
    };
  }

  let shiftStartAt = moment.tz(`${formattedShiftDate} ${parsedStart}`, "YYYY-MM-DD HH:mm:ss", TZ);
  let shiftEndAt = moment.tz(`${formattedShiftDate} ${parsedEnd}`, "YYYY-MM-DD HH:mm:ss", TZ);

  // Handle overnight shifts (end before start => next day)
  if (shiftEndAt.isSameOrBefore(shiftStartAt)) {
    shiftEndAt = shiftEndAt.add(1, "day");
  }

  return {
    formattedShiftDate,
    startTime,
    endTime,
    shiftStartAt: shiftStartAt.toDate(),
    shiftEndAt: shiftEndAt.toDate(),
  };
}

function computeBreakTotalMs(breaks, fallbackEndDate = null) {
  if (!Array.isArray(breaks) || breaks.length === 0) return 0;
  let total = 0;
  for (const br of breaks) {
    const start = br?.startedAt ? new Date(br.startedAt).getTime() : null;
    const end = br?.endedAt
      ? new Date(br.endedAt).getTime()
      : fallbackEndDate
        ? new Date(fallbackEndDate).getTime()
        : null;
    if (!start || !end || Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    total += end - start;
  }
  return total;
}

module.exports = {
  startSession: async (req, res) => {
    try {
      const operatorId = req?.user?.id;
      const { processId, planId = null, taskUrl = "" } = req.body || {};

      if (!operatorId || !isValidObjectId(operatorId)) {
        return res.status(401).json({ status: 401, message: "Invalid operator" });
      }
      if (!processId || !isValidObjectId(processId)) {
        return res.status(400).json({ status: 400, message: "Invalid processId" });
      }
      if (planId && !isValidObjectId(planId)) {
        return res.status(400).json({ status: 400, message: "Invalid planId" });
      }

      const operatorObjId = new mongoose.Types.ObjectId(operatorId);
      const processObjId = new mongoose.Types.ObjectId(processId);

      const existing = await OperatorWorkSession.findOne({
        operatorId: operatorObjId,
        processId: processObjId,
        status: "active",
      });
      if (existing) {
        return res.status(200).json({
          status: 200,
          message: "Session already active",
          session: existing,
        });
      }

      const assignment = await AssignOperatorToPlan.findOne({
        userId: operatorObjId,
        processId: processObjId,
      }).lean();

      const scheduledShift = buildShiftWindow(
        assignment?.ProcessShiftMappings,
        assignment?.startDate
      );

      const session = new OperatorWorkSession({
        operatorId: operatorObjId,
        processId: processObjId,
        planId: planId ? new mongoose.Types.ObjectId(planId) : null,
        taskUrl,
        scheduledShift,
        startedAt: new Date(),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await session.save();

      return res.status(201).json({
        status: 201,
        message: "Session started",
        session,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  getActiveSession: async (req, res) => {
    try {
      const operatorId = req?.user?.id;
      const { processId } = req.query || {};

      if (!operatorId || !isValidObjectId(operatorId)) {
        return res.status(401).json({ status: 401, message: "Invalid operator" });
      }

      const query = {
        operatorId: new mongoose.Types.ObjectId(operatorId),
        status: "active",
      };
      if (processId) {
        if (!isValidObjectId(processId)) {
          return res.status(400).json({ status: 400, message: "Invalid processId" });
        }
        query.processId = new mongoose.Types.ObjectId(processId);
      }

      const session = await OperatorWorkSession.findOne(query).sort({ startedAt: -1 });
      return res.status(200).json({ status: 200, session: session || null });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  getSessionById: async (req, res) => {
    try {
      const operatorId = req?.user?.id;
      const { sessionId } = req.params;

      if (!operatorId || !isValidObjectId(operatorId)) {
        return res.status(401).json({ status: 401, message: "Invalid operator" });
      }
      if (!sessionId || !isValidObjectId(sessionId)) {
        return res.status(400).json({ status: 400, message: "Invalid sessionId" });
      }

      const session = await OperatorWorkSession.findOne({
        _id: new mongoose.Types.ObjectId(sessionId),
        operatorId: new mongoose.Types.ObjectId(operatorId),
      }).lean();

      if (!session) {
        return res.status(404).json({ status: 404, message: "Session not found" });
      }

      const endedAt = session.endedAt || null;
      const breakTotalMs = computeBreakTotalMs(session.breaks, endedAt);
      const workTotalMs =
        session.startedAt && endedAt
          ? Math.max(0, new Date(endedAt).getTime() - new Date(session.startedAt).getTime() - breakTotalMs)
          : null;

      return res.status(200).json({
        status: 200,
        session: { ...session, breakTotalMs, workTotalMs },
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  stopSession: async (req, res) => {
    try {
      const operatorId = req?.user?.id;
      const { sessionId } = req.params;
      const { stopReason = "", status = "stopped" } = req.body || {};

      if (!operatorId || !isValidObjectId(operatorId)) {
        return res.status(401).json({ status: 401, message: "Invalid operator" });
      }
      if (!sessionId || !isValidObjectId(sessionId)) {
        return res.status(400).json({ status: 400, message: "Invalid sessionId" });
      }
      if (!["stopped", "completed"].includes(status)) {
        return res.status(400).json({ status: 400, message: "Invalid status" });
      }

      const now = new Date();
      const session = await OperatorWorkSession.findOne({
        _id: new mongoose.Types.ObjectId(sessionId),
        operatorId: new mongoose.Types.ObjectId(operatorId),
      });
      if (!session) {
        return res.status(404).json({ status: 404, message: "Session not found" });
      }
      if (session.status !== "active") {
        return res.status(200).json({
          status: 200,
          message: "Session already stopped",
          session,
        });
      }

      // Auto-close active break (if any)
      if (Array.isArray(session.breaks) && session.breaks.length > 0) {
        const lastBreak = session.breaks[session.breaks.length - 1];
        if (lastBreak && !lastBreak.endedAt) {
          lastBreak.endedAt = now;
        }
      }

      session.endedAt = now;
      session.status = status;
      session.stopReason = stopReason || "";
      session.breakTotalMs = computeBreakTotalMs(session.breaks, now);
      session.updatedAt = now;
      await session.save();

      return res.status(200).json({
        status: 200,
        message: "Session stopped",
        session,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  startBreak: async (req, res) => {
    try {
      const operatorId = req?.user?.id;
      const { sessionId } = req.params;
      const { reason = "" } = req.body || {};

      if (!operatorId || !isValidObjectId(operatorId)) {
        return res.status(401).json({ status: 401, message: "Invalid operator" });
      }
      if (!sessionId || !isValidObjectId(sessionId)) {
        return res.status(400).json({ status: 400, message: "Invalid sessionId" });
      }

      const session = await OperatorWorkSession.findOne({
        _id: new mongoose.Types.ObjectId(sessionId),
        operatorId: new mongoose.Types.ObjectId(operatorId),
        status: "active",
      });
      if (!session) {
        return res.status(404).json({ status: 404, message: "Active session not found" });
      }

      const hasOpenBreak =
        Array.isArray(session.breaks) && session.breaks.some((b) => b && b.startedAt && !b.endedAt);
      if (hasOpenBreak) {
        return res.status(400).json({ status: 400, message: "Break already in progress" });
      }

      const now = new Date();
      session.breaks.push({ startedAt: now, endedAt: null, reason });
      session.updatedAt = now;
      await session.save();

      return res.status(200).json({ status: 200, message: "Break started", session });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  endBreak: async (req, res) => {
    try {
      const operatorId = req?.user?.id;
      const { sessionId } = req.params;

      if (!operatorId || !isValidObjectId(operatorId)) {
        return res.status(401).json({ status: 401, message: "Invalid operator" });
      }
      if (!sessionId || !isValidObjectId(sessionId)) {
        return res.status(400).json({ status: 400, message: "Invalid sessionId" });
      }

      const session = await OperatorWorkSession.findOne({
        _id: new mongoose.Types.ObjectId(sessionId),
        operatorId: new mongoose.Types.ObjectId(operatorId),
        status: "active",
      });
      if (!session) {
        return res.status(404).json({ status: 404, message: "Active session not found" });
      }

      const now = new Date();
      let ended = false;
      for (let i = session.breaks.length - 1; i >= 0; i--) {
        const br = session.breaks[i];
        if (br && br.startedAt && !br.endedAt) {
          br.endedAt = now;
          ended = true;
          break;
        }
      }
      if (!ended) {
        return res.status(400).json({ status: 400, message: "No active break to end" });
      }

      session.breakTotalMs = computeBreakTotalMs(session.breaks, now);
      session.updatedAt = now;
      await session.save();

      return res.status(200).json({ status: 200, message: "Break ended", session });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },

  logEvent: async (req, res) => {
    try {
      const operatorId = req?.user?.id;
      const { sessionId } = req.params;
      const { actionType, actionName, payload = {}, pageUrl = "", clientOccurredAt = null } =
        req.body || {};

      if (!operatorId || !isValidObjectId(operatorId)) {
        return res.status(401).json({ status: 401, message: "Invalid operator" });
      }
      if (!sessionId || !isValidObjectId(sessionId)) {
        return res.status(400).json({ status: 400, message: "Invalid sessionId" });
      }
      if (!actionType || !actionName) {
        return res.status(400).json({ status: 400, message: "actionType and actionName are required" });
      }

      const session = await OperatorWorkSession.findOne({
        _id: new mongoose.Types.ObjectId(sessionId),
        operatorId: new mongoose.Types.ObjectId(operatorId),
      }).lean();
      if (!session) {
        return res.status(404).json({ status: 404, message: "Session not found" });
      }

      let parsedClientTime = null;
      if (clientOccurredAt) {
        const m = moment(clientOccurredAt);
        if (m.isValid()) parsedClientTime = m.toDate();
      }

      const event = new OperatorWorkEvent({
        sessionId: new mongoose.Types.ObjectId(sessionId),
        operatorId: new mongoose.Types.ObjectId(operatorId),
        processId: session.processId,
        planId: session.planId || null,
        occurredAt: new Date(),
        clientOccurredAt: parsedClientTime,
        actionType,
        actionName,
        payload,
        pageUrl,
        userAgent: req.headers["user-agent"] || "",
        ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString(),
        createdAt: new Date(),
      });

      await event.save();
      return res.status(201).json({ status: 201, message: "Event captured", eventId: event._id });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};

