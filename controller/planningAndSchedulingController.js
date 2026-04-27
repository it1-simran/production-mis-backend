const mongoose = require("mongoose");
const moment = require("moment");
const momentTz = require("moment-timezone");
const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
const ProcessLogsModel = require("../models/ProcessLogs");
const RoomPlanModel = require("../models/roomPlan");
const assignedOperatorsToPlanModel = require("../models/assignOperatorToPlan");
const ShiftModel = require("../models/shiftManagement");
const InventoryModel = require("../models/inventoryManagement");
const ProcessModel = require("../models/process");
const assignedJigToPlanModel = require("../models/assignJigToPlan");

const {
  computePlanInsights,
  computeProcessInsights,
  normalizeAssignedStagesPayload,
} = require("../services/planInsightsService");

const TZ = process.env.TIMEZONE || "Asia/Kolkata";

const toObjectId = (id) => {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
};

const parseDateValue = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const getPlanDateRange = (plan) => {
  const start = parseDateValue(plan?.startDate);
  if (!start) return { start: null, end: null };

  const estimationDays = Number(plan?.totalTimeEstimation || 0);
  let end = parseDateValue(plan?.estimatedEndDate);

  if (!end && Number.isFinite(estimationDays) && estimationDays > 0) {
    end = new Date(start);
    end.setTime(start.getTime() + estimationDays * 24 * 60 * 60 * 1000);
  }

  return { start, end };
};

const safeParseJson = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const normalizeCustomOperatorSlot = (slot) => {
  if (Array.isArray(slot)) return slot.filter(Boolean);
  if (!slot) return [];

  if (typeof slot === "string") {
    const trimmed = slot.trim();
    if (!trimmed) return [];
    const parsed = safeParseJson(trimmed, []);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  }

  if (typeof slot === "object") {
    if (Array.isArray(slot.operators)) return slot.operators.filter(Boolean);
    if (slot._id || slot.id || slot.operatorId || slot.userId || slot.name) {
      return [slot];
    }
  }

  return [];
};

const normalizeAssignedCustomStagesOp = (value) => {
  const parsed = safeParseJson(value, []);

  if (Array.isArray(parsed)) {
    return parsed.map((slot) => normalizeCustomOperatorSlot(slot));
  }

  if (parsed && typeof parsed === "object") {
    return Object.keys(parsed)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => normalizeCustomOperatorSlot(parsed[key]));
  }

  return [];
};

const overlapMs = (startA, endA, startB, endB) => {
  if (!startA || !endA || !startB || !endB) return 0;
  const s = Math.max(startA.getTime(), startB.getTime());
  const e = Math.min(endA.getTime(), endB.getTime());
  return Math.max(0, e - s);
};

const getShiftProductiveMinutes = (shift) => {
  if (!shift?.intervals || !Array.isArray(shift.intervals)) {
    const totalBreak = Number(shift?.totalBreakTime || 0);
    if (!shift?.startTime || !shift?.endTime) return 0;
    const start = moment(shift.startTime, ["HH:mm", "HH:mm:ss", "h:mm A"], true);
    const end = moment(shift.endTime, ["HH:mm", "HH:mm:ss", "h:mm A"], true);
    if (!start.isValid() || !end.isValid()) return 0;
    let minutes = end.diff(start, "minutes");
    if (minutes <= 0) minutes += 24 * 60;
    return Math.max(0, minutes - totalBreak);
  }

  return shift.intervals.reduce((sum, interval) => {
    if (!interval?.startTime || !interval?.endTime || interval?.breakTime) return sum;
    const start = moment(interval.startTime, ["HH:mm", "HH:mm:ss", "h:mm A"], true);
    const end = moment(interval.endTime, ["HH:mm", "HH:mm:ss", "h:mm A"], true);
    if (!start.isValid() || !end.isValid()) return sum;
    let minutes = end.diff(start, "minutes");
    if (minutes <= 0) minutes += 24 * 60;
    return sum + minutes;
  }, 0);
};

const getDowntimeOverlapMinutes = (plan, fromDate, toDate) => {
  const from = parseDateValue(fromDate);
  const to = parseDateValue(toDate);
  const downFrom = parseDateValue(plan?.downTime?.from);
  const downTo = parseDateValue(plan?.downTime?.to);
  if (!from || !to || !downFrom || !downTo) return 0;
  return overlapMs(from, to, downFrom, downTo) / (60 * 1000);
};

const getOvertimeSummary = (plan) => {
  const windows = Array.isArray(plan?.overtimeWindows) ? plan.overtimeWindows : [];
  const activeWindows = windows.filter((w) => w?.active);
  const totalMinutes = activeWindows.reduce((sum, w) => {
    const from = parseDateValue(w?.from);
    const to = parseDateValue(w?.to);
    if (!from || !to || to <= from) return sum;
    const gross = (to.getTime() - from.getTime()) / (60 * 1000);
    const downOverlap = getDowntimeOverlapMinutes(plan, from, to);
    return sum + Math.max(0, gross - downOverlap);
  }, 0);

  return {
    totalMinutes: Math.round(totalMinutes),
    totalWindows: activeWindows.length,
    lastUpdatedAt: new Date(),
  };
};

const createProcessLog = async ({ action, processId, userId, description }) => {
  const pId = toObjectId(processId);
  const uId = toObjectId(userId);
  if (!pId || !uId) return;
  await ProcessLogsModel.create({
    action,
    processId: pId,
    userId: uId,
    description: description || "",
    timestamp: new Date(),
  });
};

const getBottleneckUPH = (processData) => {
  const stages = Array.isArray(processData?.stages) ? processData.stages : [];
  const values = stages
    .map((s) => Number(s?.upha))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (values.length === 0) return 0;
  return Math.min(...values);
};

const syncAssignments = async (plan) => {
  try {
    const processId = toObjectId(plan.selectedProcess);
    if (!processId) return;

    const activeUserIds = [];
    const activeJigIds = [];

    // 1. Sync Operators (Regular)
    const assignedOperators = safeParseJson(plan.assignedOperators, {});
    for (const seatKey in assignedOperators) {
      const operators = Array.isArray(assignedOperators[seatKey])
        ? assignedOperators[seatKey]
        : assignedOperators[seatKey]
          ? [assignedOperators[seatKey]]
          : [];

      for (const op of operators) {
        const userId = toObjectId(op._id || op.userId);
        if (!userId) continue;
        activeUserIds.push(userId);

        const parts = String(seatKey).split("-");
        const rowNumber = parts[0] || "0";
        const seatNumber = parts[1] || "0";

        const data = {
          processId,
          userId,
          roomName: plan.selectedRoom,
          seatDetails: { rowNumber, seatNumber },
          ProcessShiftMappings: plan.ProcessShiftMappings,
          startDate: plan.startDate,
          estimatedEndDate: plan.estimatedEndDate,
          status: "Occupied",
          updatedAt: new Date(),
        };

        await assignedOperatorsToPlanModel.findOneAndUpdate(
          { processId, userId },
          { $set: data },
          { upsert: true, new: true }
        );
      }
    }

    // 2. Sync Operators (Common)
    const customOpsArr = normalizeAssignedCustomStagesOp(plan.assignedCustomStagesOp);
    for (let i = 0; i < customOpsArr.length; i++) {
      const operators = customOpsArr[i];
      for (const op of operators) {
        const userId = toObjectId(op._id || op.userId);
        if (!userId) continue;
        activeUserIds.push(userId);

        const data = {
          processId,
          userId,
          roomName: plan.selectedRoom,
          seatDetails: {},
          stageType: "common",
          ProcessShiftMappings: plan.ProcessShiftMappings,
          startDate: plan.startDate,
          estimatedEndDate: plan.estimatedEndDate,
          status: "Occupied",
          updatedAt: new Date(),
        };

        await assignedOperatorsToPlanModel.findOneAndUpdate(
          { processId, userId },
          { $set: data },
          { upsert: true, new: true }
        );
      }
    }

    // 3. Sync Jigs
    const assignedJigs = safeParseJson(plan.assignedJigs, {});
    for (const seatKey in assignedJigs) {
      const jigs = Array.isArray(assignedJigs[seatKey])
        ? assignedJigs[seatKey]
        : assignedJigs[seatKey]
          ? [assignedJigs[seatKey]]
          : [];

      for (const jig of jigs) {
        const jigId = toObjectId(jig._id || jig.jigId);
        if (!jigId) continue;
        activeJigIds.push(jigId);

        const parts = String(seatKey).split("-");
        const rowNumber = parts[0] || "0";
        const seatNumber = parts[1] || "0";

        const data = {
          processId,
          jigId,
          roomName: plan.selectedRoom,
          seatDetails: { rowNumber, seatNumber },
          ProcessShiftMappings: plan.ProcessShiftMappings,
          startDate: plan.startDate,
          estimatedEndDate: plan.estimatedEndDate,
          status: "Occupied",
          updatedAt: new Date(),
        };

        await assignedJigToPlanModel.findOneAndUpdate(
          { processId, jigId },
          { $set: data },
          { upsert: true, new: true }
        );
      }
    }

    // Optional: Cleanup old assignments for this process that are no longer in the plan
    if (activeUserIds.length > 0) {
      await assignedOperatorsToPlanModel.deleteMany({
        processId,
        userId: { $nin: activeUserIds }
      });
    }
    if (activeJigIds.length > 0) {
      await assignedJigToPlanModel.deleteMany({
        processId,
        jigId: { $nin: activeJigIds }
      });
    }

  } catch (error) {
    console.error("Error in syncAssignments:", error);
  }
};

const recalculatePlanWithOvertime = async (plan) => {
  const summary = getOvertimeSummary(plan);
  plan.overtimeSummary = summary;

  const shift = await ShiftModel.findById(plan.selectedShift).lean();
  const processData = await ProcessModel.findById(plan.selectedProcess).lean();
  const productiveMinutesPerDay = getShiftProductiveMinutes(shift);
  if (!productiveMinutesPerDay || productiveMinutesPerDay <= 0) {
    return plan;
  }

  let baseDays = Number(plan?.totalTimeEstimation || 0);
  const quantity = Number(processData?.quantity || 0);
  const bottleneckUPH = getBottleneckUPH(processData);
  const productiveHoursPerDay = productiveMinutesPerDay / 60;
  const unitsPerDay = bottleneckUPH * productiveHoursPerDay;
  if (quantity > 0 && unitsPerDay > 0) {
    baseDays = quantity / unitsPerDay;
  }

  if (!Number.isFinite(baseDays) || baseDays <= 0) {
    return plan;
  }

  const overtimeDays = summary.totalMinutes / productiveMinutesPerDay;
  const updatedDays = Math.max(0, baseDays - overtimeDays);
  plan.totalTimeEstimation = updatedDays.toFixed(2);

  const start = parseDateValue(plan.startDate);
  if (start) {
    plan.estimatedEndDate = moment(start).tz(TZ).add(updatedDays, "days").toDate();
  }

  return plan;
};

const findOvertimeConflict = async ({ planId, selectedRoom, selectedShift, from, to }) => {
  const roomId = toObjectId(selectedRoom);
  if (!roomId || !from || !to) return null;

  const query = {
    _id: { $ne: planId },
    selectedRoom: roomId,
  };
  if (selectedShift) {
    query.selectedShift = selectedShift;
  }

  const plans = await PlaningAndSchedulingModel.find(query)
    .select("_id processName selectedProcess startDate estimatedEndDate totalTimeEstimation status")
    .lean();

  for (const candidate of plans) {
    if (String(candidate?.status || "").toLowerCase() === "completed") continue;
    const range = getPlanDateRange(candidate);
    if (!range.start || !range.end) continue;
    if (overlapMs(from, to, range.start, range.end) > 0) {
      return candidate;
    }
  }

  return null;
};

module.exports = {
  create: async (req, res) => {
    try {
      const formatDateForMongoose = (dateString) => {
        if (!dateString || typeof dateString !== "string" || dateString === "Invalid Date" || dateString.includes("NaN")) {
          return dateString instanceof Date ? (isNaN(dateString.getTime()) ? undefined : dateString) : undefined;
        }

        if (dateString.includes("/")) {
          const parts = dateString.split("/");
          if (parts.length < 3) return undefined;
          const day = parts[0];
          const month = parts[1];
          const yearAndTime = parts[2];
          const [year, time] = yearAndTime.split(" ");
          
          if (time) {
            const [hours, minutes, seconds] = time.split(":");
            const d = new Date(`20${year.slice(-2)}`, month - 1, day, hours || 0, minutes || 0, seconds || 0);
            return isNaN(d.getTime()) ? undefined : d;
          } else {
            const d = new Date(`20${year.slice(-2)}`, month - 1, day);
            return isNaN(d.getTime()) ? undefined : d;
          }
        }

        if (dateString.includes("-")) {
          const d = new Date(dateString);
          return isNaN(d.getTime()) ? undefined : d;
        }

        const d = new Date(dateString);
        return isNaN(d.getTime()) ? undefined : d;
      };
      const safeParse = (val, fallback) => {
        if (typeof val === "string") {
          try {
            return JSON.parse(val);
          } catch {
            return fallback;
          }
        }
        if (val === undefined || val === null) return fallback;
        return val;
      };
      const data = req?.body;
      const planingId = req?.body?.selectedProcess;
      data.ProcessShiftMappings = safeParse(data?.ProcessShiftMappings, []);
      data.startDate = formatDateForMongoose(data?.startDate);
      data.estimatedEndDate = formatDateForMongoose(data?.estimatedEndDate);
      const newPlanAndScheduling = new PlaningAndSchedulingModel(data);
      await newPlanAndScheduling.save();

      // Trigger backend synchronization of operator/jig assignments
      await syncAssignments(newPlanAndScheduling);

      const processUpdater = await ProcessModel.findByIdAndUpdate(
        planingId,
        {
          $set: {
            status: req?.body?.status,
          },
        },
        { new: true }
      );
      
      return res.status(200).json({
        status: 200,
        message: "Planing And Scheduling Created Successfully!!",
        newPlanAndScheduling,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  update: async (req, res) => {
    try {
      const formatDateForMongoose = (dateString) => {
        if (!dateString || typeof dateString !== "string" || dateString === "Invalid Date" || dateString.includes("NaN")) {
          return dateString instanceof Date ? (isNaN(dateString.getTime()) ? undefined : dateString) : undefined;
        }

        if (dateString.includes("/")) {
          const parts = dateString.split("/");
          if (parts.length < 3) return undefined;
          const day = parts[0];
          const month = parts[1];
          const yearAndTime = parts[2];
          const [year, time] = yearAndTime.split(" ");
          
          if (time) {
            const [hours, minutes, seconds] = time.split(":");
            const d = new Date(`20${year.slice(-2)}`, month - 1, day, hours || 0, minutes || 0, seconds || 0);
            return isNaN(d.getTime()) ? undefined : d;
          } else {
            const d = new Date(`20${year.slice(-2)}`, month - 1, day);
            return isNaN(d.getTime()) ? undefined : d;
          }
        }

        if (dateString.includes("-")) {
          const d = new Date(dateString);
          return isNaN(d.getTime()) ? undefined : d;
        }

        const d = new Date(dateString);
        return isNaN(d.getTime()) ? undefined : d;
      };
      const id = req.params.id;
      const updatedData = req.body;
      const safeParse = (val, fallback) => {
        if (typeof val === "string") {
          try {
            return JSON.parse(val);
          } catch {
            return fallback;
          }
        }
        if (val === undefined || val === null) return fallback;
        return val;
      };
      updatedData.ProcessShiftMappings = safeParse(updatedData.ProcessShiftMappings, []);
      updatedData.startDate = formatDateForMongoose(updatedData.startDate);
      updatedData.estimatedEndDate = formatDateForMongoose(
        updatedData.estimatedEndDate
      );
      const updatedPlaningAndScheduling =
        await PlaningAndSchedulingModel.findByIdAndUpdate(id, updatedData, {
          new: true,
          runValidators: true,
        });

      if (updatedPlaningAndScheduling) {
        // Trigger backend synchronization on update
        await syncAssignments(updatedPlaningAndScheduling);
      } else {
        return res
          .status(404)
          .json({ message: "Planing and Scheduling not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "Planing and Scheduling Updated Successfully!!",
        shift: updatedPlaningAndScheduling,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  view: async (req, res) => {
    try {
      let plans = await PlaningAndSchedulingModel.aggregate([
        {
          $lookup: {
            from: "processes",
            localField: "selectedProcess",
            foreignField: "_id",
            as: "planingData",
          },
        },
        { $unwind: "$planingData" },
        {
          $project: {
            _id: 1,
            processName: 1,
            selectedProcess: 1,
            selectedRoom: 1,
            selectedShift: 1,
            issuedKits: 1,
            issuedCarton: 1,
            ProcessShiftMappings: 1,
            repeatCount: 1,
            startDate: 1,
            assignedJigs: 1,
            assignedOperators: 1,
            assignedStages: 1,
            isDrafted: 1,
            totalUPHA: 1,
            totalTimeEstimation: 1,
            status: "$planingData.status",
            estimatedEndDate: 1,
            consumedKit: 1,
            downTime: 1,
            overtimeWindows: 1,
            overtimeSummary: 1,
            processName: "$planingData.name",
            isActiveProcess: {
              $and: [
                { $eq: [{ $toLower: "$planingData.status" }, "active"] },
                { $lte: ["$startDate", "$$NOW"] }
              ]
            },
          },
        },
        { $sort: { _id: -1 } }
      ]);
      return res.status(200).json({
        status: 200,
        message: "Planning and scheduling fetched successfully!",
        plans,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  checkAvailability: async (req, res) => {
    try {
      const { roomId, shiftId, startDate, expectedEndDate, shiftDataChange } =
        req.body;
      const safeParse = (val, fallback) => {
        if (typeof val === "string") {
          try {
            return JSON.parse(val);
          } catch {
            return fallback;
          }
        }
        if (val === undefined || val === null) return fallback;
        return val;
      };
      let changedData = safeParse(shiftDataChange, {});
      if (!roomId || !shiftId || !startDate || !expectedEndDate) {
        return res.status(400).json({
          error:
            "Room ID, Shift ID, Start Date, and Expected End Date are required.",
        });
      }
      const parseFlexibleDateTimeUtc = (value) => {
        if (value === undefined || value === null) return moment.invalid();

        if (value instanceof Date) {
          return moment.utc(value);
        }

        if (typeof value === "number") {
          const parsedNumeric = moment.utc(value);
          return parsedNumeric.isValid() ? parsedNumeric : moment.invalid();
        }

        const normalized = String(value).trim();
        if (!normalized) return moment.invalid();

        // First try ISO 8601
        const parsedIso = moment.utc(normalized, moment.ISO_8601, true);
        if (parsedIso.isValid()) return parsedIso;

        const supportedFormats = [
          "DD/MM/YY HH:mm:ss",
          "DD/MM/YYYY HH:mm:ss",
          "DD-MM-YY HH:mm:ss",
          "DD-MM-YYYY HH:mm:ss",
          "YYYY-MM-DD HH:mm:ss",
          "YYYY-MM-DDTHH:mm:ss",
          "YYYY-MM-DDTHH:mm:ss.SSS",
          "DD/MM/YYYY",
          "DD-MM-YYYY",
          "YYYY-MM-DD",
          "DD/MM/YY",
          "DD-MM-YY"
        ];

        for (const format of supportedFormats) {
          const parsed = moment.utc(normalized, format, true);
          if (parsed.isValid()) return parsed;
        }

        // Final fallback: non-strict parsing
        const looseParsed = moment.utc(normalized);
        if (looseParsed.isValid()) return looseParsed;

        return moment.invalid();
      };

      const parsedStartDate = parseFlexibleDateTimeUtc(startDate);
      const parsedEndDate = parseFlexibleDateTimeUtc(expectedEndDate);
      if (!parsedStartDate.isValid() || !parsedEndDate.isValid()) {
        return res.status(400).json({
          status: 400,
          error:
            "Invalid date format. Expected format: DD/MM/YY HH:mm:ss.",
        });
      }
      if (parsedStartDate.isAfter(parsedEndDate)) {
        return res.status(400).json({
          status: 400,
          error: "Start Date must be earlier than Expected End Date.",
        });
      }
      const shift = await ShiftModel.findById(shiftId);
      if (!shift) {
        return res.status(404).json({
          status: 404,
          error: "Shift not found.",
        });
      }
      let shiftStartTime, shiftEndTime;
      shiftStartTime = moment(changedData.startTime, "HH:mm");
      shiftEndTime = moment(changedData.endTime, "HH:mm");
      const query = [
        {
          $match: {
            selectedRoom: new mongoose.Types.ObjectId(roomId),
            isDrafted: 0,
          },
        },
        {
          $lookup: {
            from: "processes",
            localField: "selectedProcess",
            foreignField: "_id",
            as: "processDetails",
          },
        },
        {
          $unwind: {
            path: "$processDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $match: {
            "processDetails.status": {
              $nin: ["completed", "waiting_schedule"],
            },
            $or: [
              {
                startDate: {
                  $gte: parsedStartDate.toDate(),
                  $lte: parsedEndDate.toDate(),
                },
              },
              {
                estimatedEndDate: {
                  $gte: parsedStartDate.toDate(),
                  $lte: parsedEndDate.toDate(),
                },
              },
              {
                $and: [
                  { startDate: { $lte: parsedStartDate.toDate() } },
                  { estimatedEndDate: { $gte: parsedEndDate.toDate() } },
                ],
              },
              { "processDetails.status": "active" }, // Catch-all for active processes
            ],
          },
        },
      ];
      const plans = await PlaningAndSchedulingModel.aggregate(query);
      const filteredPlans = plans.filter((plan) => {
        const { startTime, endTime } = plan.ProcessShiftMappings || {};
        if (!startTime || !endTime) return false;
        const planStartTime = moment(startTime, "HH:mm");
        const planEndTime = moment(endTime, "HH:mm");
        return (
          shiftStartTime.isSameOrBefore(planEndTime.startOf("minute")) &&
          shiftEndTime.isSameOrAfter(planStartTime.startOf("minute"))
        );
      });

      if (filteredPlans.length === 0) {
        return res.status(200).json({
          status: 200,
          message:
            "Available seats fetched successfully!",
          plans: filteredPlans,
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Available seats fetched successfully!",
        plans: filteredPlans,
      });
    } catch (error) {
      console.error("Error in checkAvailability: ", error.message);
      return res.status(500).json({
        status: 500,
        error: "Internal server error.",
        details: error.message,
      });
    }
  },
  checkAvailabilityFromCurrentDate: async (req, res) => {
    try {
      const { roomId, shiftId } = req.body;

      if (!roomId || !shiftId) {
        return res.status(400).json({
          status: 400,
          error: "Room ID and Shift ID are required.",
        });
      }

      const currentDate = moment.utc().startOf("day");
      const endDate = moment.utc().add(30, "days").endOf("day");

      // ✅ Check if room exists
      const roomPlan = await RoomPlanModel.findById(roomId).lean();
      if (!roomPlan) {
        return res.status(404).json({
          status: 404,
          error: "Room not found.",
        });
      }

      const totalSeatsInRoom =
        roomPlan.lines?.reduce(
          (totalSeats, line) => totalSeats + (line.seats?.length || 0),
          0
        ) || 0;

      // ✅ Fetch plans with process status
      const plans = await PlaningAndSchedulingModel.aggregate([
        {
          $match: {
            selectedRoom: new mongoose.Types.ObjectId(roomId),
            selectedShift: new mongoose.Types.ObjectId(shiftId),
            isDrafted: 0,
          },
        },
        {
          $lookup: {
            from: "processes",
            localField: "selectedProcess",
            foreignField: "_id",
            as: "processDetails",
          },
        },
        { $unwind: "$processDetails" },
        {
          $match: {
            "processDetails.status": { $nin: ["completed", "waiting_schedule"] },
          },
        },
      ]);

      if (!plans || plans.length === 0) {
        // ✅ Return empty seat availability
        return res.status(200).json({
          status: 200,
          message: "No planning data available.",
          seatAvailability: {},
        });
      }

      // ✅ Build seat availability
      const seatAvailability = {};
      for (const plan of plans) {
        const planStartDate = moment(plan.startDate).startOf("day");
        let planEndDate = moment(plan.estimatedEndDate).endOf("day");

        // If the process is still active, consider it occupying seats until today at least
        if (plan.processDetails?.status === "active" && planEndDate.isBefore(moment())) {
          planEndDate = moment().endOf("day");
        }

        let currentDateInRange = planStartDate.clone();
        while (currentDateInRange.isSameOrBefore(planEndDate)) {
          const dateString = currentDateInRange.format("YYYY-MM-DD");

          if (!seatAvailability[dateString]) {
            seatAvailability[dateString] = totalSeatsInRoom;
          }

          let assignedStages = 0;
          try {
            const parsedStages = JSON.parse(plan?.assignedStages || "{}");
            assignedStages = Object.keys(parsedStages).length;
          } catch (err) {
            console.warn(
              "Invalid JSON in assignedStages:",
              plan.assignedStages
            );
          }

          seatAvailability[dateString] -= assignedStages;
          currentDateInRange.add(1, "days");
        }
      }

      return res.status(200).json({
        status: 200,
        message: "Planning and scheduling fetched successfully!",
        seatAvailability,
      });
    } catch (error) {
      console.error(
        "Error in checkAvailabilityFromCurrentDate:",
        error.message
      );
      return res.status(500).json({
        status: 500,
        error: "Internal server error.",
        details: error.message,
      });
    }
  },
  delete: async (req, res) => {
    try {
      const planId = req.params.id;
      const planingAndScheduling =
        await PlaningAndSchedulingModel.findByIdAndDelete(planId);
      await ProcessLogsModel.deleteMany({ planId });
      if (!planingAndScheduling) {
        return res
          .status(404)
          .json({ message: "Planing & Scheduling not found" });
      }
      res.status(200).json({
        message: "Planing & Scheduling deleted successfully",
        planingAndScheduling,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deletePlaningMultiple: async (req, res) => {
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
      const result = await PlaningAndSchedulingModel.deleteMany({
        _id: { $in: objectIds },
      });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} item(s) deleted successfully`,
      });
    } catch (error) {
      if (error.message.startsWith("Invalid ObjectId")) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error deleting multiple items:", error);
      return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
  },
  getPlaningAnDschedulingByID: async (req, res) => {
    try {
      const id = req.params.id;
      const PlaningAndScheduling = await PlaningAndSchedulingModel.aggregate([
        {
          $match: { _id: new mongoose.Types.ObjectId(id) },
        },
        {
          $lookup: {
            from: "assignkitstolines",
            let: { planId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$planId", "$$planId"] },
                },
              },
              {
                $project: {
                  _id: 0,
                  issuedKits: 1,
                  seatDetails: 1,
                  status: 1,
                  issuedKitsStatus: 1,
                },
              },
            ],
            as: "assignKitsToLinesDetails",
          },
        },
        {
          $unwind: {
            path: "$assignKitsToLinesDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "shifts",
            let: { shiftId: "$selectedShift" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$_id", "$$shiftId"] },
                },
              },
              {
                $project: {
                  _id: 1,
                  startTime: 1,
                  endTime: 1,
                  intervals: 1,
                  totalBreakTime: 1,
                },
              },
            ],
            as: "shiftDetails",
          },
        },
        {
          $unwind: { path: "$shiftDetails", preserveNullAndEmptyArrays: true },
        },
        {
          $lookup: {
            from: "processes",
            let: { processId: "$selectedProcess" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$_id", "$$processId"] },
                },
              },
              {
                $project: {
                  _id: 1,
                  name: 1,
                  processID: 1,
                  status: 1,
                  quantity: 1,
                  issuedKits: 1,
                  consumedKits: 1,
                  selectedProduct: 1,
                  stages: 1,
                  commonStages: 1,
                  orderConfirmationNo: 1,
                },
              },
            ],
            as: "processDetails",
          },
        },
        {
          $unwind: {
            path: "$processDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "orderconfirmationnumbers",
            let: { ocNo: "$processDetails.orderConfirmationNo" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$orderConfirmationNo", "$$ocNo"] },
                },
              },
              {
                $project: {
                  customerName: 1,
                  modelName: 1,
                },
              },
            ],
            as: "ocDetails",
          },
        },
        {
          $unwind: {
            path: "$ocDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            _id: 1,
            processName: 1,
            selectedProcess: 1,
            selectedRoom: 1,
            selectedShift: 1,
            issuedKits: 1,
            issuedCarton: 1,
            ProcessShiftMappings: 1,
            repeatCount: 1,
            startDate: 1,
            assignedJigs: 1,
            assignedOperators: 1,
            assignedStages: 1,
            isDrafted: 1,
            totalUPHA: 1,
            totalTimeEstimation: 1,
            status: 1,
            estimatedEndDate: 1,
            consumedKit: 1,
            downTime: 1,
            overtimeWindows: 1,
            overtimeSummary: 1,
            assignedIssuedKits: "$assignKitsToLinesDetails.issuedKits",
            assignedSeatDetails: "$assignKitsToLinesDetails.seatDetails",
            assignedStatus: "$assignKitsToLinesDetails.status",
            assignedIssuedKitsStatus:
              "$assignKitsToLinesDetails.issuedKitsStatus",
            assignedCustomStages: 1,
            assignedCustomStagesOp: 1,
            processStatus: "$processDetails.status",
            startTime: "$shiftDetails.startTime",
            processQuantity: "$processDetails.quantity",
            processIssuedKits: "$processDetails.issuedKits",
            processConsumedKits: "$processDetails.consumedKits",
            orderConfirmationNo: "$processDetails.orderConfirmationNo",
            customerName: "$ocDetails.customerName",
            modelName: "$ocDetails.modelName",
            endTime: "$shiftDetails.endTime",
            totalBreakTime: "$shiftDetails.totalBreakTime",
            isActiveProcess: {
              $and: [
                { $eq: [{ $toLower: "$processDetails.status" }, "active"] },
                { $lte: ["$startDate", "$$NOW"] }
              ]
            }
          },
        },
      ]);

      if (!PlaningAndScheduling) {
        return res.status(404).json({ error: "Product not found" });
      }
      const currentPlan = PlaningAndScheduling?.[0];
      if (!currentPlan) {
        return res.status(404).json({ error: "Product not found" });
      }

      currentPlan.assignedCustomStagesOp = JSON.stringify(
        normalizeAssignedCustomStagesOp(currentPlan.assignedCustomStagesOp),
      );

      return res.status(200).json(currentPlan);
    } catch (error) {
      console.error("Error Fetching Planing And Scheduling :", error);
      return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
  },
  getPlaningAnDschedulingByProcessId: async (req, res) => {
    try {
      const id = req.params.id;
      const PlaningAndScheduling = await PlaningAndSchedulingModel.find({
        selectedProcess: id,
      });
      if (!PlaningAndScheduling) {
        return res.status(404).json({ error: "Product not found" });
      }
      return res.status(200).json(PlaningAndScheduling[0]);
    } catch (error) {
      console.error("Error Fetching Planing And Scheduling :", error);
      return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
  },
  getPlanInsights: async (req, res) => {
    try {
      const planId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(String(planId || ""))) {
        return res.status(400).json({
          status: 400,
          message: "Invalid plan id",
        });
      }

      const plan = await PlaningAndSchedulingModel.findById(planId).lean();
      if (!plan) {
        return res.status(404).json({
          status: 404,
          message: "Plan not found",
        });
      }

      const process = plan?.selectedProcess
        ? await ProcessModel.findById(plan.selectedProcess).lean()
        : null;
      if (!process) {
        return res.status(404).json({
          status: 404,
          message: "Process not found",
        });
      }

      const shift = plan?.selectedShift
        ? await ShiftModel.findById(plan.selectedShift).lean()
        : null;

      const normalizedAssignedStages = normalizeAssignedStagesPayload(
        safeParseJson(plan?.assignedStages, {}),
        process?.stages || [],
        process?.commonStages || [],
      );

      const insights = await computePlanInsights({
        planId,
        processId: process?._id || "",
        assignedStages: normalizedAssignedStages,
        processStages: process?.stages || [],
        commonStages: process?.commonStages || [],
        selectedProduct: process?.selectedProduct || "",
        quantity: process?.quantity || 0,
        shift,
      });

      return res.status(200).json({
        status: 200,
        message: "Plan insights fetched successfully",
        data: insights,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "Failed to fetch plan insights",
        error: error.message,
      });
    }
  },
  fetchAllPlaningModel: async (req, res) => {
    try {
      const PlaningAndScheduling = await PlaningAndSchedulingModel.find();
      return res.status(200).json({
        status: 200,
        message: "Planing Model Fetched Successfully!!",
        PlaningAndScheduling,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  planingAndSchedulingLogs: async (req, res) => {
    try {
      const data = req?.body;
      const processLogs = new ProcessLogsModel(data);
      await processLogs.save();
      return res.status(200).json({
        status: 200,
        message: "Process Logs Created Successfully!!",
        processLogs,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getProcessLogsByProcessId: async (req, res) => {
    try {
      const id = req.params.id;
      const processLogs = await ProcessLogsModel.aggregate([
        {
          $match: {
            processId: new mongoose.Types.ObjectId(id),
          },
        },
        {
          $lookup: {
            from: "processes",
            localField: "processId",
            foreignField: "_id",
            as: "planingData",
          },
        },
        { $unwind: "$planingData" },
        {
          $project: {
            _id: 1,
            action: 1,
            processId: 1,
            userId: 1,
            description: 1,
            timestamp: 1,
            processtName: "$planingData.name",
          },
        },
      ]);
      if (!processLogs) {
        return res.status(404).json({ error: "Product not found" });
      }
      return res.status(200).json(processLogs);
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateDownTime: async (req, res) => {
    try {
      const id = req.params.id;
      const selectedProcess = req.body.selectedProcess;
      const downTime = req.body.downTime;

      const downtimeData = JSON.parse(downTime);

      const processData = {
        status: "down_time_hold",
      };
      const planingData = {
        downTime: {
          from: downtimeData.downTimeFrom,
          to: downtimeData.downTimeTo,
          description: downtimeData.downTimeDesc,
          downTimeType: downtimeData.downTimeDesc
        },
        status: "down_time_hold",
      };
      const planing = await PlaningAndSchedulingModel.findByIdAndUpdate(
        id,
        planingData,
        {
          new: true,
          runValidators: true,
        }
      );
      const process = await ProcessModel.findByIdAndUpdate(
        selectedProcess,
        processData,
        {
          new: true,
          runValidators: true,
        }
      );
      if (!process) {
        return res.status(404).json({
          status: 404,
          message: "Process not found with given ID.",
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Planning and Process updated successfully.",
        process,
      });
    } catch (error) {
      console.error("Error in updateDownTime:", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateProcessStatus: async (req, res) => {
    try {
      const id = req.params.id;
      const selectedProcess = req.body.selectedProcess;
      const processData = {
        status: req.body.status,
      };

      const isResuming = req.body.status === "active";

      const planingData = {
        status: req.body.status,
      };

      if (isResuming) {
        planingData.downTime = {
          from: null,
          to: null,
          downTimeType: "",
          description: ""
        };
      }
      const planing = await PlaningAndSchedulingModel.findByIdAndUpdate(
        id,
        planingData,
        {
          new: true,
          runValidators: true,
        }
      );
      const process = await ProcessModel.findByIdAndUpdate(
        selectedProcess,
        processData,
        {
          new: true,
          runValidators: true,
        }
      );
      if (!process) {
        return res.status(404).json({
          status: 404,
          message: "Process not found with given ID.",
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Planning and Process updated successfully.",
        process,
      });
    } catch (error) {
      console.error("Error in updateProcessStatus:", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getPlaningAndSchedulingDateWise: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;

      let filterStartDate, filterEndDate;

      if (startDate && endDate) {
        const parsedStart = moment.tz(startDate, "YYYY-MM-DD", "Asia/Kolkata");
        const parsedEnd = moment.tz(endDate, "YYYY-MM-DD", "Asia/Kolkata");

        if (!parsedStart.isValid() || !parsedEnd.isValid()) {
          return res.status(400).json({
            status: 400,
            error: "Invalid date format. Use YYYY-MM-DD.",
          });
        }

        filterStartDate = parsedStart.startOf("day").toDate();
        filterEndDate = parsedEnd.endOf("day").toDate();
      } else {
        const today = moment.tz("Asia/Kolkata");
        filterStartDate = today.clone().startOf("isoWeek").toDate();
        filterEndDate = today.clone().endOf("isoWeek").toDate();
      }

      const response = await PlaningAndSchedulingModel.aggregate([
        {
          $match: {
            startDate: {
              $gte: filterStartDate,
              $lte: filterEndDate,
            },
          },
        },
        {
          $lookup: {
            from: "processes",
            localField: "selectedProcess",
            foreignField: "_id",
            as: "processDetails",
          },
        },
        {
          $unwind: "$processDetails",
        },
        {
          $sort: { startDate: 1 },
        },
      ]);

      // compute active flag based on Asia/Kolkata current datetime and process status
      const now = moment.tz("Asia/Kolkata").toDate();
      const plansWithActive = response.map((p) => {
        const start = p.startDate ? new Date(p.startDate) : null;
        const processActive =
          p.processDetails &&
          typeof p.processDetails.status === "string" &&
          p.processDetails.status.toLowerCase() === "active";
        const inRange = start && start <= now;
        return Object.assign({}, p, { isActiveProcess: processActive && inRange });
      });

      return res.status(200).json({
        status: 200,
        message: "Planning and Scheduling data fetched successfully",
        plans: plansWithActive,
      });
    } catch (error) {
      console.error("API Error:", error.message);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  addOvertime: async (req, res) => {
    try {
      const id = req.params.id;
      const userId = req?.user?.id || null;
      const { from, to, reason = "", replaceWindowId = null } = req.body || {};

      const fromDate = parseDateValue(from);
      const toDate = parseDateValue(to);

      if (!fromDate || !toDate || toDate <= fromDate) {
        return res.status(400).json({
          status: 400,
          message: "Valid overtime 'from' and 'to' are required.",
        });
      }

      const plan = await PlaningAndSchedulingModel.findById(id);
      if (!plan) {
        return res.status(404).json({ status: 404, message: "Planning not found" });
      }

      const conflict = await findOvertimeConflict({
        planId: plan._id,
        selectedRoom: plan.selectedRoom,
        selectedShift: plan.selectedShift,
        from: fromDate,
        to: toDate,
      });

      if (conflict) {
        return res.status(409).json({
          status: 409,
          message: "Overtime overlaps with another active plan in the same room/shift window.",
          conflict: {
            planId: conflict._id,
            selectedProcess: conflict.selectedProcess,
            processName: conflict.processName || "",
            startDate: conflict.startDate,
            estimatedEndDate: conflict.estimatedEndDate,
          },
        });
      }

      let action = "OVERTIME_ADDED";
      let updatedWindow = null;

      if (replaceWindowId) {
        const target = (plan.overtimeWindows || []).find(
          (w) => String(w._id) === String(replaceWindowId)
        );
        if (!target) {
          return res.status(404).json({ status: 404, message: "Overtime window not found" });
        }
        target.from = fromDate;
        target.to = toDate;
        target.reason = reason || "";
        target.updatedAt = new Date();
        target.active = true;
        updatedWindow = target;
        action = "OVERTIME_UPDATED";
      } else {
        updatedWindow = {
          from: fromDate,
          to: toDate,
          reason: reason || "",
          createdBy: toObjectId(userId),
          createdAt: new Date(),
          updatedAt: new Date(),
          active: true,
        };
        plan.overtimeWindows = [...(plan.overtimeWindows || []), updatedWindow];
      }

      await recalculatePlanWithOvertime(plan);
      await plan.save();

      await createProcessLog({
        action,
        processId: plan.selectedProcess,
        userId,
        description: `Overtime ${action === "OVERTIME_ADDED" ? "added" : "updated"} from ${fromDate.toISOString()} to ${toDate.toISOString()}${reason ? ` (${reason})` : ""}.`,
      });

      return res.status(200).json({
        status: 200,
        message: "Overtime saved successfully",
        overtimeSummary: plan.overtimeSummary,
        overtimeWindows: plan.overtimeWindows,
        totalTimeEstimation: plan.totalTimeEstimation,
        estimatedEndDate: plan.estimatedEndDate,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  removeOvertime: async (req, res) => {
    try {
      const id = req.params.id;
      const windowId = req.params.windowId;
      const userId = req?.user?.id || null;

      const plan = await PlaningAndSchedulingModel.findById(id);
      if (!plan) {
        return res.status(404).json({ status: 404, message: "Planning not found" });
      }

      const target = (plan.overtimeWindows || []).find(
        (w) => String(w._id) === String(windowId)
      );
      if (!target) {
        return res.status(404).json({ status: 404, message: "Overtime window not found" });
      }

      target.active = false;
      target.updatedAt = new Date();

      await recalculatePlanWithOvertime(plan);
      await plan.save();

      await createProcessLog({
        action: "OVERTIME_REMOVED",
        processId: plan.selectedProcess,
        userId,
        description: `Overtime removed for window ${windowId}.`,
      });

      return res.status(200).json({
        status: 200,
        message: "Overtime removed successfully",
        overtimeSummary: plan.overtimeSummary,
        overtimeWindows: plan.overtimeWindows,
        totalTimeEstimation: plan.totalTimeEstimation,
        estimatedEndDate: plan.estimatedEndDate,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getOvertime: async (req, res) => {
    try {
      const id = req.params.id;
      const plan = await PlaningAndSchedulingModel.findById(id)
        .select("_id selectedProcess overtimeWindows overtimeSummary totalTimeEstimation estimatedEndDate")
        .lean();

      if (!plan) {
        return res.status(404).json({ status: 404, message: "Planning not found" });
      }

      return res.status(200).json({
        status: 200,
        overtimeWindows: plan.overtimeWindows || [],
        overtimeSummary: plan.overtimeSummary || { totalMinutes: 0, totalWindows: 0, lastUpdatedAt: null },
        totalTimeEstimation: plan.totalTimeEstimation,
        estimatedEndDate: plan.estimatedEndDate,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  checkTestRecordsDateWise: async (req, res) => {
    try {
    } catch (error) {
      console.error(" Api Error :", error.message);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getProcessInsights: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid Process ID" });
      }

      const process = await ProcessModel.findById(id).lean();
      if (!process) {
        return res.status(404).json({ status: 404, message: "Process not found" });
      }

      const insights = await computeProcessInsights({
        processId: id,
        processStages: process.stages || [],
        commonStages: process.commonStages || [],
        selectedProduct: process.productType,
        quantity: Number(process.quantity || 0),
      });

      return res.status(200).json({
        status: 200,
        message: "Process insights fetched successfully",
        data: {
          ...insights,
          process: {
            _id: process._id,
            name: process.name,
            productType: process.productType,
            quantity: process.quantity,
            issuedKits: process.issuedKits,
            consumedKits: process.consumedKits,
          },
        },
      });
    } catch (error) {
      console.error("Error in getProcessInsights:", error);
      return res.status(500).json({ status: 500, message: error.message });
    }
  },
  getDowntimeReasons: async (req, res) => {
    try {
      const reasons = [
        "Machine Breakdown",
        "Power Failure",
        "Material Shortage",
        "Quality Issue",
        "Scheduled Maintenance",
        "Operator Unavailable",
        "System Update",
        "Other"
      ];
      return res.status(200).json({ status: 200, reasons });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
