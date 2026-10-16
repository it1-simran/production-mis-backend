// Loads one day's attempts, work sessions and idle logs and builds each operator's day (see operatorTimeline.js for the rules). Read only.
//
//   loadOperatorTimeline({ planId, date, operator, stage })  -> { ok: true, body } | { ok: false, status, message }

const { buildOperatorTimeline } = require("./operatorTimeline");
const { resolveDay, dayExtentMin } = require("./planHourly");
const { buildWindow } = require("../../utils/planDates");

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = 3600000;
const recordLimit = () => Number(process.env.PLAN_INSIGHTS_SCAN_LIMIT) || 50000;
const sessionMax = () => (Number(process.env.SESSION_MAX_HOURS) || 10) * HOUR;

const loadOperatorTimeline = async ({ planId, date, operator = "", stage = "" }) => {
  const mongoose = require("mongoose");
  const moment = require("moment-timezone");
  const PlaningAndSchedulingModel = require("../../models/planingAndSchedulingModel");
  const ProcessModel = require("../../models/process");
  const ShiftModel = require("../../models/shiftManagement");
  const HolidayModel = require("../../models/holidayModel");
  const RecordModel = require("../../models/deviceTestModel");
  const SessionModel = require("../../models/operatorWorkSession");
  const IdleLogModel = require("../../models/operatorIdleLog");
  const UserModel = require("../../models/User");
  const s = require("../planInsightsService");

  if (!mongoose.Types.ObjectId.isValid(String(planId || ""))) return { ok: false, status: 400, message: "Invalid plan id" };
  if (!DAY_KEY.test(String(date || ""))) return { ok: false, status: 400, message: "date must be a day (YYYY-MM-DD)." };
  if (operator && !mongoose.Types.ObjectId.isValid(String(operator))) return { ok: false, status: 400, message: "Invalid operator." };

  const plan = await PlaningAndSchedulingModel.findById(planId).lean();
  if (!plan) return { ok: false, status: 404, message: "Plan not found" };
  const proc = plan.selectedProcess ? await ProcessModel.findById(plan.selectedProcess).lean() : null;
  if (!proc) return { ok: false, status: 404, message: "Process not found" };

  const [shift, holidays] = await Promise.all([
    plan.selectedShift && mongoose.Types.ObjectId.isValid(String(plan.selectedShift)) ? ShiftModel.findById(plan.selectedShift).lean() : null,
    HolidayModel.find({}, { holidayDate: 1 }).limit(2000).lean(),
  ]);
  const resolved = resolveDay({ plan, process: proc, shift, holidays, date });
  if (resolved.error) return { ok: false, status: 422, message: resolved.error };

  const midnight = moment.tz(date, "YYYY-MM-DD", s.PLANNING_TIMEZONE).startOf("day");
  const dayStartMs = midnight.valueOf();
  const dayStart = new Date(dayStartMs);
  const dayEnd = new Date(dayStartMs + dayExtentMin(buildWindow(resolved.window.startTime, resolved.window.endTime)) * 60000); // to the next midnight; a night shift a little further
  const who = operator ? { operatorId: operator } : {};

  const [records, sessions, idleLogs] = await Promise.all([
    RecordModel.find({ processId: proc._id, ...who, createdAt: { $gte: dayStart, $lt: dayEnd } })
      .select("deviceId serialNo operatorId stageName currentStage status startTime endTime testDurationMs createdAt")
      .sort({ createdAt: 1 })
      .limit(recordLimit())
      .lean(),
    // a session still open from long ago must not be stretched over this day: only sessions that began within 12 hours before it
    SessionModel.find({ processId: proc._id, ...who, startedAt: { $gte: new Date(dayStartMs - 12 * HOUR), $lt: dayEnd }, $or: [{ endedAt: null }, { endedAt: { $gte: dayStart } }] })
      .select("operatorId startedAt endedAt status breaks")
      .limit(2000)
      .lean(),
    IdleLogModel.find({ processId: proc._id, ...who, idleEndTime: { $gte: dayStart }, idleStartTime: { $lt: dayEnd } })
      .select("operatorId idleStartTime idleEndTime reasonLabel reasonCode category remarks stageName")
      .limit(5000)
      .lean(),
  ]);

  const ids = Array.from(new Set([...records, ...sessions, ...idleLogs].map((x) => String(x.operatorId || "")).filter((id) => mongoose.Types.ObjectId.isValid(id))));
  const users = ids.length ? await UserModel.find({ _id: { $in: ids } }).select("name employeeCode").lean() : [];
  const names = new Map(users.map((u) => [String(u._id), { name: u.name || "", employeeCode: u.employeeCode || "" }]));

  const now = moment.tz(s.PLANNING_TIMEZONE);
  const isToday = now.format("YYYY-MM-DD") === date;
  const aliasLookup = s.buildStageAliasLookup({ processStages: proc.stages || [], commonStages: proc.commonStages || [] });
  const built = buildOperatorTimeline({
    dayStartMs,
    window: resolved.window,
    breaks: resolved.breaks,
    records,
    sessions,
    idleLogs,
    names,
    nowMs: isToday ? now.valueOf() : null,
    maxSessionMs: sessionMax(),
    stage,
    aliasLookup,
  });
  if (!built.ok) return { ok: false, status: 422, message: built.message };
  return {
    ok: true,
    body: {
      status: 200,
      plan: { id: String(plan._id), name: plan.processName || proc.name || "" },
      mode: plan.scheduleMode === "custom" ? "custom" : "shift",
      date,
      scheduled: resolved.scheduled,
      partial: records.length >= recordLimit(),
      ...built,
    },
  };
};

module.exports = { loadOperatorTimeline };
