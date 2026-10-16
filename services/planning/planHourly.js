// Hour by hour output of one day for one plan, read only.
//
//   buildHourly({ date, window, breaks, stages, records, devices, aliasLookup, lastStage, scheduled, todayKey, nowMinutes })  PURE
//   loadHourly({ planId, date })                                                                                         loads, then builds
//
// Buckets run from the day's start time in steps of one hour (08:30-09:30 for an 08:30 start), one extra hour before and after the
// day's window so work just outside it is still seen, and anything further out is reported as `outside`. Breaks inside the window
// reduce a bucket's productive minutes; a bucket that is all break is shown as a break.
//
// COUNTING (the same as the rest of the overview): a device's result at a stage is its latest record there on the day; pass =
// pass|completed, NG = ng|fail|qc|trc|rework; records of an older flow version of a device are ignored.
// TARGET of a bucket = target units per hour x seats on the stage x (productive minutes / 60). Common stages have no seats, so no target,
// and a day that is not one of the plan's scheduled days has none either (there is no plan to judge it against).

const svc = () => require("../planInsightsService");
const { toMinutes, buildWindow } = require("../../utils/planDates");

const PAD_MINUTES = 60;
// read here, outside loadHourly, where a local variable called process (the process document) would hide the global
const scanLimit = () => Number(process.env.PLAN_INSIGHTS_SCAN_LIMIT) || 50000;
const num = (n) => Number(n) || 0;
const pad2 = (n) => String(n).padStart(2, "0");
const label = (minutes) => `${pad2(Math.floor((((minutes % 1440) + 1440) % 1440) / 60))}:${pad2(((minutes % 60) + 60) % 60)}`;

// the break pieces inside [lo, hi), merged, in minutes from the day's midnight (a break that wraps midnight is tried a day later too)
const breakRanges = (breaks, lo, hi) => {
  const pieces = [];
  (breaks || []).forEach((b) => {
    const start = toMinutes(b?.startTime);
    let end = toMinutes(b?.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    if (end <= start) end += 1440;
    [0, 1440].forEach((shift) => {
      const a = Math.max(start + shift, lo);
      const z = Math.min(end + shift, hi);
      if (z > a) pieces.push([a, z]);
    });
  });
  pieces.sort((x, y) => x[0] - y[0]);
  const merged = [];
  pieces.forEach(([a, z]) => {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], z);
    else merged.push([a, z]);
  });
  return merged;
};
const breakOverlap = (breaks, lo, hi) => breakRanges(breaks, lo, hi).reduce((sum, [a, z]) => sum + (z - a), 0);

// The hours a plan works on a day: its own schedule when the day is on it, otherwise the shift's or the stored hours, so output on a day
// off can still be shown. `scheduled` says which. Returns { error } when there are no usable hours.
const resolveDay = ({ plan, process, shift, holidays, date }) => {
  const { planDayGrid } = require("./planOverview");
  const { buildHolidayKeys } = require("../../utils/planDates");
  const grid = planDayGrid({ plan, process, shift, holidayKeys: buildHolidayKeys(holidays) });
  const day = grid.days.find((d) => d.dayKey === date);
  const shiftBreaks = (shift?.intervals || []).filter((i) => i && i.breakTime).map((i) => ({ startTime: i.startTime, endTime: i.endTime }));
  let window = day?.window || null;
  const breaks = day ? (plan.scheduleMode === "custom" ? day.breaks || [] : shiftBreaks) : shiftBreaks;
  if (!window) {
    const stored = plan.ProcessShiftMappings || {};
    window = { startTime: stored.startTime || shift?.startTime || "", endTime: stored.endTime || shift?.endTime || "" };
  }
  if (!buildWindow(window.startTime, window.endTime)) return { error: "This plan has no usable hours for that day." };
  return { window, breaks, scheduled: !!day };
};

// How far a plan day reaches, in minutes from its midnight: to the next midnight, or two hours past the end of a night shift. Work later
// than that belongs to the next day, not to this one (otherwise it would be counted on two days).
const dayExtentMin = (win) => Math.max(1440, win.end + 120);

const buildBuckets = (win, breaks) => {
  const out = [];
  const push = (lo, hi, kind) => {
    const length = hi - lo;
    const brk = Math.min(length, breakOverlap(breaks, lo, hi));
    out.push({ start: lo, end: hi, label: `${label(lo)}-${label(hi)}`, kind, productiveMinutes: Math.max(0, length - brk), isBreak: length > 0 && brk >= length });
  };
  for (let lo = win.start - PAD_MINUTES; lo < win.start; lo += 60) push(lo, Math.min(lo + 60, win.start), "before");
  for (let lo = win.start; lo < win.end; lo += 60) push(lo, Math.min(lo + 60, win.end), "shift");
  for (let lo = win.end; lo < win.end + PAD_MINUTES; lo += 60) push(lo, Math.min(lo + 60, win.end + PAD_MINUTES), "after");
  return out;
};

/**
 * @param {string} o.date          YYYY-MM-DD (plant time zone)
 * @param {{startTime:string,endTime:string}} o.window
 * @param {Array}  o.breaks        [{startTime,endTime}]
 * @param {Array}  o.stages        [{ name, common, seats, upha }] in process order
 * @param {Array}  o.records       the day's records, newest first
 * @param {Array}  o.devices       device documents {_id, serialNo, flowVersion} for the devices in `records`
 * @param {number|null} o.nowMinutes  current plant-time minutes of the day when `date` is today
 */
const buildHourly = ({ date, window, breaks = [], stages, records, devices = [], aliasLookup, lastStage = "", scheduled = true, nowMinutes = null }) => {
  const { normalizeKey, resolveCanonicalStageName, isPassStatus, isNgStatus, PLANNING_TIMEZONE } = svc();
  const moment = require("moment-timezone");
  const win = buildWindow(window?.startTime, window?.endTime);
  if (!win) return { ok: false, message: "The day has no usable hours." };
  const buckets = buildBuckets(win, breaks);

  const flow = new Map();
  (devices || []).forEach((d) => {
    const v = num(d?.flowVersion || 1);
    if (d?._id) flow.set(String(d._id), v);
    if (d?.serialNo) flow.set(String(d.serialNo).trim(), v);
  });

  // latest record per device and stage on the day (records are newest first)
  const latest = new Map();
  (records || []).forEach((r) => {
    const dev = String(r?.deviceId?._id || r?.deviceId || r?.serialNo || "").trim();
    const stageRaw = String(r?.stageName || r?.currentStage || "").trim();
    if (!dev || !stageRaw) return;
    const cur = flow.get(dev);
    if (cur !== undefined && num(r?.flowVersion || 1) !== cur) return;
    const k = `${dev}:${normalizeKey(stageRaw)}`;
    if (!latest.has(k)) latest.set(k, r);
  });

  const rows = new Map(stages.map((s) => [normalizeKey(s.name), { ...s, key: normalizeKey(s.name), cells: buckets.map(() => ({ pass: 0, ng: 0 })), outside: { pass: 0, ng: 0 } }]));
  const dayStart = moment.tz(date, "YYYY-MM-DD", PLANNING_TIMEZONE);
  latest.forEach((r) => {
    const status = normalizeKey(r?.status);
    const pass = isPassStatus(status);
    const ng = isNgStatus(status);
    if (!pass && !ng) return;
    const stage = resolveCanonicalStageName(String(r?.stageName || r?.currentStage || "").trim(), aliasLookup);
    const row = rows.get(normalizeKey(stage));
    if (!row) return;
    const at = moment(r.createdAt).tz(PLANNING_TIMEZONE);
    const dayOffset = at.clone().startOf("day").diff(dayStart, "days");
    const minute = at.hours() * 60 + at.minutes() + dayOffset * 1440; // minutes from the start of `date`; the next morning counts for a night shift
    if (minute >= dayExtentMin(win)) return; // the next day's work
    const i = buckets.findIndex((b) => minute >= b.start && minute < b.end);
    const cell = i >= 0 ? row.cells[i] : row.outside;
    if (pass) cell.pass += 1;
    else cell.ng += 1;
  });

  const outRows = Array.from(rows.values()).map((row) => {
    const perHour = row.common ? 0 : num(row.upha) * num(row.seats);
    const cells = row.cells.map((c, i) => ({
      pass: c.pass,
      ng: c.ng,
      // only the planned hours have a target; the padding hours around them just show what was done
      target: perHour > 0 && scheduled && buckets[i].kind === "shift" && !buckets[i].isBreak ? Math.round(perHour * (buckets[i].productiveMinutes / 60) * 10) / 10 : null,
    }));
    return {
      name: row.name,
      common: !!row.common,
      seats: num(row.seats),
      targetPerHour: perHour || null,
      cells,
      outside: row.outside,
      totals: {
        pass: cells.reduce((s, c) => s + c.pass, 0) + row.outside.pass,
        ng: cells.reduce((s, c) => s + c.ng, 0) + row.outside.ng,
        target: perHour > 0 && scheduled ? Math.round(cells.reduce((s, c) => s + (c.target || 0), 0) * 10) / 10 : null,
      },
    };
  });

  const currentBucket = nowMinutes === null ? -1 : buckets.findIndex((b) => nowMinutes >= b.start && nowMinutes < b.end);
  const last = outRows.find((r) => normalizeKey(r.name) === normalizeKey(lastStage));
  return {
    ok: true,
    date,
    scheduled,
    window: { startTime: window.startTime, endTime: window.endTime },
    breaks: (breaks || []).map((b) => ({ startTime: b.startTime, endTime: b.endTime })),
    buckets: buckets.map((b) => ({ label: b.label, kind: b.kind, productiveMinutes: b.productiveMinutes, isBreak: b.isBreak })),
    currentBucket,
    stages: outRows,
    lastStage: last ? last.name : "",
    totals: {
      pass: outRows.reduce((s, r) => s + r.totals.pass, 0),
      ng: outRows.reduce((s, r) => s + r.totals.ng, 0),
    },
  };
};

// ---- loading ----------------------------------------------------------------------------------------------------------------

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const loadHourly = async ({ planId, date }) => {
  const mongoose = require("mongoose");
  const moment = require("moment-timezone");
  const PlaningAndSchedulingModel = require("../../models/planingAndSchedulingModel");
  const ProcessModel = require("../../models/process");
  const ShiftModel = require("../../models/shiftManagement");
  const HolidayModel = require("../../models/holidayModel");
  const DeviceModel = require("../../models/device");
  const RecordModel = require("../../models/deviceTestModel");
  const { lastStageName } = require("./planOverview");
  const { plannedByStage } = require("./planOperations");
  const s = svc();

  if (!mongoose.Types.ObjectId.isValid(String(planId || ""))) return { ok: false, status: 400, message: "Invalid plan id" };
  if (!DAY_KEY.test(String(date || ""))) return { ok: false, status: 400, message: "date must be a day (YYYY-MM-DD)." };

  const plan = await PlaningAndSchedulingModel.findById(planId).lean();
  if (!plan) return { ok: false, status: 404, message: "Plan not found" };
  const process = plan.selectedProcess ? await ProcessModel.findById(plan.selectedProcess).lean() : null;
  if (!process) return { ok: false, status: 404, message: "Process not found" };
  const [shift, holidays] = await Promise.all([
    plan.selectedShift && mongoose.Types.ObjectId.isValid(String(plan.selectedShift)) ? ShiftModel.findById(plan.selectedShift).lean() : null,
    HolidayModel.find({}, { holidayDate: 1 }).limit(2000).lean(),
  ]);

  const resolved = resolveDay({ plan, process, shift, holidays, date });
  if (resolved.error) return { ok: false, status: 422, message: resolved.error };
  const { window, breaks } = resolved;

  const aliasLookup = s.buildStageAliasLookup({ processStages: process.stages || [], commonStages: process.commonStages || [] });
  const planned = plannedByStage(plan, process);
  const stages = [...(process.stages || []).map((st) => ({ st, common: false })), ...(process.commonStages || []).map((st) => ({ st, common: true }))].map(({ st, common }) => {
    const name = String(st?.stageName || st?.name || "");
    const p = planned.get(s.normalizeKey(name));
    return { name, common, seats: common ? 0 : p ? p.seatKeys.length : 0, upha: Number(st?.upha) || 0 };
  });

  // the day, in plant time (to the next midnight; a night shift reaches a little into the morning)
  const from = moment.tz(date, "YYYY-MM-DD", s.PLANNING_TIMEZONE).startOf("day").toDate();
  const to = new Date(from.getTime() + dayExtentMin(buildWindow(window.startTime, window.endTime)) * 60000);
  const records = await RecordModel.find({ processId: process._id, createdAt: { $gte: from, $lte: to } })
    .select("deviceId serialNo stageName currentStage status flowVersion createdAt")
    .sort({ createdAt: -1 })
    .limit(scanLimit())
    .lean();
  const ids = Array.from(new Set(records.map((r) => String(r.deviceId || "")).filter((id) => mongoose.Types.ObjectId.isValid(id))));
  const devices = ids.length ? await DeviceModel.find({ _id: { $in: ids } }).select("_id serialNo flowVersion").lean() : [];

  const now = moment.tz(s.PLANNING_TIMEZONE);
  const isToday = now.format("YYYY-MM-DD") === date;
  const built = buildHourly({
    date,
    window,
    breaks,
    stages,
    records,
    devices,
    aliasLookup,
    lastStage: lastStageName(process),
    scheduled: resolved.scheduled,
    nowMinutes: isToday ? now.hours() * 60 + now.minutes() : null,
  });
  if (!built.ok) return { ok: false, status: 422, message: built.message };
  return { ok: true, body: { status: 200, plan: { id: String(plan._id), name: plan.processName || process.name || "" }, mode: plan.scheduleMode === "custom" ? "custom" : "shift", ...built } };
};

module.exports = { buildHourly, loadHourly, buildBuckets, breakRanges, resolveDay, dayExtentMin };
