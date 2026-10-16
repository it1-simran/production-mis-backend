// Loads what stageDetail.js needs (the process-wide scan the live engine uses, the devices and operator names) and answers the three
// stage questions. Read only.
//
//   loadStageSummary({ planId, stage, from, to })
//   loadStageDevices({ planId, stage, bucket, page, pageSize, q, seat, from, to })
//   loadStageHistory({ planId, stage, from, to, operator, status, serial, seat, cursor, limit })
// Each returns { ok: true, body } or { ok: false, status, message }.

const detail = require("./stageDetail");
const { plannedByStage } = require("./planOperations");

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const scanLimit = () => Number(process.env.PLAN_INSIGHTS_SCAN_LIMIT) || 50000;

const RECORD_FIELDS = "deviceId serialNo operatorId seatNumber stageName currentStage status assignedSeatKey currentSeatKey nextLogicalStage assignedDeviceTo flowVersion attemptNumber reattemptReason startTime endTime testDurationMs ngDescription reason createdAt";

const checkRange = (from, to) => {
  if ((from && !DAY_KEY.test(from)) || (to && !DAY_KEY.test(to))) return "from and to must be dates (YYYY-MM-DD).";
  if (from && to && from > to) return "The end of the range is before its start.";
  return "";
};

const loadContext = async ({ planId, stage }) => {
  const mongoose = require("mongoose");
  const PlaningAndSchedulingModel = require("../../models/planingAndSchedulingModel");
  const ProcessModel = require("../../models/process");
  const DeviceModel = require("../../models/device");
  const RecordModel = require("../../models/deviceTestModel");
  const UserModel = require("../../models/User");
  const svc = require("../planInsightsService");

  if (!mongoose.Types.ObjectId.isValid(String(planId || ""))) return { ok: false, status: 400, message: "Invalid plan id" };
  const wanted = String(stage || "").trim();
  if (!wanted) return { ok: false, status: 400, message: "A stage is required." };

  const plan = await PlaningAndSchedulingModel.findById(planId).lean();
  if (!plan) return { ok: false, status: 404, message: "Plan not found" };
  const process = plan.selectedProcess ? await ProcessModel.findById(plan.selectedProcess).lean() : null;
  if (!process) return { ok: false, status: 404, message: "Process not found" };

  const aliasLookup = svc.buildStageAliasLookup({ processStages: process.stages || [], commonStages: process.commonStages || [] });
  const canonical = svc.resolveCanonicalStageName(wanted, aliasLookup);
  const known = [...(process.stages || []), ...(process.commonStages || [])].some((s) => svc.normalizeKey(s?.stageName || s?.name) === svc.normalizeKey(canonical));
  if (!known) return { ok: false, status: 404, message: "That stage is not part of this process." };

  const processId = process._id;
  const [records, devices] = await Promise.all([
    RecordModel.find({ processId }).select(RECORD_FIELDS).sort({ createdAt: -1 }).limit(scanLimit()).lean(),
    DeviceModel.find({ processID: processId, ...(process.selectedProduct ? { productType: process.selectedProduct } : {}) })
      .select("_id serialNo status currentStage flowVersion updatedAt")
      .lean(),
  ]);

  const operatorIds = Array.from(new Set(records.map((r) => String(r.operatorId || "")).filter((id) => mongoose.Types.ObjectId.isValid(id))));
  const users = operatorIds.length ? await UserModel.find({ _id: { $in: operatorIds } }).select("name employeeCode").lean() : [];
  const names = new Map(users.map((u) => [String(u._id), { name: u.name || "", employeeCode: u.employeeCode || "" }]));

  const planned = plannedByStage(plan, process);
  const seatKeys = (planned.get(svc.normalizeKey(canonical)) || { seatKeys: [] }).seatKeys;
  const stageSeatFallback = new Map();
  planned.forEach((p, key) => {
    if (p.seatKeys.length === 1) stageSeatFallback.set(key, p.seatKeys[0]);
  });

  return {
    ok: true,
    ctx: {
      plan,
      process,
      aliasLookup,
      stage: canonical,
      commonStageNames: (process.commonStages || []).map((s) => String(s?.stageName || s?.name || "").trim()).filter(Boolean),
      records,
      devices,
      names,
      stageSeatFallback,
      info: {
        name: canonical,
        common: (process.commonStages || []).some((s) => svc.normalizeKey(s?.stageName || s?.name) === svc.normalizeKey(canonical)),
        seatKeys,
        targetUpha: Number([...(process.stages || []), ...(process.commonStages || [])].find((s) => svc.normalizeKey(s?.stageName || s?.name) === svc.normalizeKey(canonical))?.upha) || 0,
      },
      partial: records.length >= scanLimit(),
    },
  };
};

const stripPrivate = (analysis) => {
  const { _finals, ...rest } = analysis;
  return rest;
};

const loadStageSummary = async ({ planId, stage, from = "", to = "" }) => {
  const bad = checkRange(from, to);
  if (bad) return { ok: false, status: 400, message: bad };
  const loaded = await loadContext({ planId, stage });
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  const analysis = detail.analyzeStage({ records: ctx.records, devices: ctx.devices, aliasLookup: ctx.aliasLookup, stage: ctx.stage, from, to, names: ctx.names, commonStageNames: ctx.info.common ? ctx.commonStageNames : [] });
  return { ok: true, body: { status: 200, stage: ctx.info, range: { from: from || null, to: to || null }, partial: ctx.partial, ...stripPrivate(analysis) } };
};

// an export asks for everything at once (up to this many rows)
const EXPORT_LIMIT = 50000;

const loadStageDevices = async ({ planId, stage, bucket = "pass", page = 1, pageSize = 50, q = "", seat = "", from = "", to = "", all = false }) => {
  const bad = checkRange(from, to);
  if (bad) return { ok: false, status: 400, message: bad };
  if (!["pass", "ng", "resolved", "wip"].includes(bucket)) return { ok: false, status: 400, message: "bucket must be pass, ng, resolved or wip." };
  const loaded = await loadContext({ planId, stage });
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  const paging = all ? detail.clampPage(1, EXPORT_LIMIT, EXPORT_LIMIT) : detail.clampPage(page, pageSize);
  const needle = String(q || "").trim().toLowerCase();
  const matches = (row) => (!needle || String(row.serialNo).toLowerCase().includes(needle)) && (!seat || row.seatKey === seat);

  if (bucket === "wip") {
    const { loadOperations } = require("./planOperations");
    const ops = await loadOperations({ planId });
    if (!ops.ok) return ops;
    const svc = require("../planInsightsService");
    const row = ops.body.stages.find((s) => svc.normalizeKey(s.name) === svc.normalizeKey(ctx.stage));
    const all = detail.prepare(ctx.records, ctx.aliasLookup);
    const flow = new Map();
    ctx.devices.forEach((d) => {
      flow.set(String(d._id), Number(d.flowVersion || 1));
      if (d.serialNo) flow.set(String(d.serialNo).trim(), Number(d.flowVersion || 1));
    });
    const live = all.filter((p) => !p.dev || !flow.has(p.dev) || Number(p.r?.flowVersion || 1) === flow.get(p.dev));
    const wip = detail.wipDevicesAt({
      all: live,
      devices: ctx.devices,
      aliasLookup: ctx.aliasLookup,
      stage: ctx.stage,
      firstStage: ctx.process.stages?.[0]?.stageName || "",
      processStatus: ctx.process.status,
      lineAllocated: ops.body.kits.lineAllocated,
      consumed: ops.body.kits.consumed,
      engineWip: row ? row.wip : null,
      stageSeatFallback: ctx.stageSeatFallback,
      commonStageNames: ctx.info.common ? ctx.commonStageNames : [],
    });
    const rows = wip.rows
      .map((r) => {
        const op = ctx.names.get(r.operatorId) || { name: "", employeeCode: "" };
        return { deviceKey: r.deviceKey, serialNo: r.serialNo, seatKey: r.seatKey, source: r.source, since: r.since, fromStage: r.fromStage, operator: { id: r.operatorId, name: op.name, employeeCode: op.employeeCode } };
      })
      .filter(matches)
      .sort((a, b) => String(a.serialNo).localeCompare(String(b.serialNo)));
    return {
      ok: true,
      body: { status: 200, bucket, plan: { id: String(ctx.plan._id), name: ctx.plan.processName || ctx.process.name || "" }, stage: ctx.info, total: rows.length, listed: wip.listed, unlisted: wip.unlisted, engineWip: row ? row.wip : null, page: paging.page, pageSize: paging.pageSize, rows: rows.slice(paging.skip, paging.skip + paging.pageSize), partial: ctx.partial },
    };
  }

  const analysis = detail.analyzeStage({ records: ctx.records, devices: ctx.devices, aliasLookup: ctx.aliasLookup, stage: ctx.stage, from, to, names: ctx.names, commonStageNames: ctx.info.common ? ctx.commonStageNames : [] });
  const rows = (analysis._finals.buckets[bucket] || [])
    .map((p) => detail.finalRow(p, ctx.names))
    .filter(matches)
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  return { ok: true, body: { status: 200, bucket, plan: { id: String(ctx.plan._id), name: ctx.plan.processName || ctx.process.name || "" }, stage: ctx.info, total: rows.length, page: paging.page, pageSize: paging.pageSize, rows: rows.slice(paging.skip, paging.skip + paging.pageSize), partial: ctx.partial } };
};

const loadStageHistory = async ({ planId, stage, from = "", to = "", operator = "", status = "", serial = "", seat = "", cursor = "", limit = 50, all = false }) => {
  const bad = checkRange(from, to);
  if (bad) return { ok: false, status: 400, message: bad };
  if (status && !["pass", "ng", "resolved"].includes(status)) return { ok: false, status: 400, message: "status must be pass, ng or resolved." };
  const loaded = await loadContext({ planId, stage });
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  const body = detail.stageHistory({ records: ctx.records, devices: ctx.devices, aliasLookup: ctx.aliasLookup, stage: ctx.stage, from, to, operator, status, serial, seat, cursor: all ? "" : cursor, limit: all ? EXPORT_LIMIT : limit, maxLimit: all ? EXPORT_LIMIT : undefined, names: ctx.names });
  return { ok: true, body: { status: 200, plan: { id: String(ctx.plan._id), name: ctx.plan.processName || ctx.process.name || "" }, stage: ctx.info, partial: ctx.partial, ...body } };
};

module.exports = { loadStageSummary, loadStageDevices, loadStageHistory, EXPORT_LIMIT };
