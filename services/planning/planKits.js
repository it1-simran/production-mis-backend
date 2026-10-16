// Kits and NG for one plan, read only.
//
//   buildKitTimeline({ allocations, lineKits, returns, transfers, processId, names })   PURE: the movements of kits, oldest first
//   buildNgOverview({ records, devices, aliasLookup, stages, ngDevices })                PURE: NG by stage, reason and department
//   loadKitsAndNg({ planId })                                                            loads both
//
// Kit movements come from four places: the store's allocation transactions, the line allocation the production manager makes (and the
// floor confirms), kits returned to the store, and kits transferred between processes. They are shown as the events they are; the
// totals are sums of those events and are NOT reconciled with the process's own issued/consumed figures (those are shown beside them).

const detail = require("./stageDetail");

const svc = () => require("../planInsightsService");
const num = (n) => Number(n) || 0;
const idOf = (v) => String(v?._id || v || "");
const iso = (d) => (d ? new Date(d).toISOString() : null);

const LINE_STATUS = {
  ASSIGN_TO_OPERATOR: { title: "Manager allocated kits to the line", detail: "waiting for the floor to confirm" },
  CONFIRM: { title: "Floor confirmed the kits on the line", detail: "" },
  REJECT: { title: "Floor rejected the line allocation", detail: "" },
};
const RETURN_STATUS = { SEND_TO_STORE: "sent to the store", PARTIALLY_RECIVED: "partly received by the store", RECIVED: "received by the store" };
const TRANSFER_STATUS = { PENDING: "waiting for approval", APPROVED: "approved", REJECTED: "rejected", CANCELLED: "cancelled" };

const buildKitTimeline = ({ allocations = [], lineKits = [], returns = [], transfers = [], processId = "", names = new Map() }) => {
  const nameOf = (id) => (names.get(idOf(id)) || {}).name || "";
  const events = [];

  allocations.forEach((a) =>
    events.push({ kind: "store_allocation", at: iso(a.allocatedAt || a.createdAt), title: "Store allocated kits to the process", quantity: num(a.quantity), detail: a.iapNo ? `IAP ${a.iapNo}` : "", by: nameOf(a.allocatedBy), counts: "allocated" })
  );

  lineKits.forEach((k) => {
    const status = LINE_STATUS[k.status] || { title: "Line allocation", detail: String(k.status || "") };
    const seats = Array.isArray(k.seatDetails) ? k.seatDetails.length : 0;
    // the allocation itself, then (for a confirmed or rejected one) the floor's answer at the time it changed
    events.push({ kind: "line_allocation", at: iso(k.createdAt), title: "Manager allocated kits to the line", quantity: num(k.issuedKits), detail: [seats ? `${seats} seat${seats === 1 ? "" : "s"}` : "", k.iapNo ? `IAP ${k.iapNo}` : ""].filter(Boolean).join(", "), by: "", counts: "line" });
    if (k.status === "CONFIRM" || k.status === "REJECT") {
      const answerAt = iso(k.updatedAt || k.createdAt);
      events.push({ kind: k.status === "CONFIRM" ? "line_confirmed" : "line_rejected", at: answerAt, title: status.title, quantity: num(k.issuedKits), detail: status.detail, by: "", counts: null });
    }
  });

  returns.forEach((r) =>
    events.push({ kind: "return", at: iso(r.createdAt), title: "Kits returned to the store", quantity: num(r.returnedKits), detail: RETURN_STATUS[r.status] || String(r.status || ""), by: nameOf(r.userId), counts: "returned" })
  );

  const mine = String(processId);
  transfers.forEach((t) => {
    const outgoing = idOf(t.fromProcessId) === mine;
    const approved = t.status === "APPROVED";
    events.push({
      kind: outgoing ? "transfer_out" : "transfer_in",
      at: iso(approved ? t.updatedAt || t.createdAt : t.createdAt),
      title: outgoing ? `Kits transferred out to ${t.toProcessName || "another process"}` : `Kits transferred in from ${t.fromProcessName || "another process"}`,
      quantity: num(t.quantity),
      detail: [TRANSFER_STATUS[t.status] || String(t.status || ""), t.targetStage ? `to ${t.targetStage}` : "", t.remarks].filter(Boolean).join(", "),
      by: t.requesterName || "",
      counts: approved ? (outgoing ? "out" : "in") : null,
    });
  });

  events.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  const total = (key) => events.filter((e) => e.counts === key).reduce((s, e) => s + e.quantity, 0);
  // only the latest line allocation is "the" allocation on the line; earlier ones were replaced
  const lines = events.filter((e) => e.counts === "line");
  return {
    events,
    totals: { allocatedByStore: total("allocated"), returnedToStore: total("returned"), transferredIn: total("in"), transferredOut: total("out"), onTheLine: lines.length ? lines[lines.length - 1].quantity : 0 },
  };
};

// ---- NG -----------------------------------------------------------------------------------------------------------------------

const buildNgOverview = ({ records, devices, aliasLookup, stages, ngDevices = [] }) => {
  const { normalizeKey } = svc();
  const flow = new Map();
  (devices || []).forEach((d) => {
    const v = num(d?.flowVersion || 1);
    if (d?._id) flow.set(String(d._id), v);
    if (d?.serialNo) flow.set(String(d.serialNo).trim(), v);
  });
  const all = detail.prepare(records, aliasLookup).filter((p) => !(p.dev && flow.has(p.dev) && num(p.r?.flowVersion || 1) !== flow.get(p.dev)));
  const finals = Array.from(detail.latestPerDeviceStage(all).values());
  const resolvedBy = new Map();
  const { getResolvedReturnStage, isResolvedStatus } = svc();
  finals.forEach((p) => {
    if (!isResolvedStatus(p.r?.status)) return;
    const prev = resolvedBy.get(p.dev);
    if (!prev || p.at >= prev.at) resolvedBy.set(p.dev, { returnStage: normalizeKey(getResolvedReturnStage(p.r)), at: p.at });
  });

  const byStage = new Map(stages.map((s) => [normalizeKey(s), { stage: s, ng: 0, resolved: 0 }]));
  const reasons = new Map();
  let open = 0;
  let resolved = 0;
  finals.forEach((p) => {
    const bucket = detail.bucketOf(p, resolvedBy);
    const row = byStage.get(normalizeKey(p.stage));
    if (bucket === "ng") {
      open += 1;
      if (row) row.ng += 1;
      const reason = String(p.r?.ngDescription || p.r?.reason || "").trim() || "No reason recorded";
      const key = reason.toLowerCase();
      // the same reason typed in different cases is one reason; it is shown with a capital first letter
      const cur = reasons.get(key) || { reason: reason.charAt(0).toUpperCase() + reason.slice(1), count: 0 };
      cur.count += 1;
      reasons.set(key, cur);
    } else if (bucket === "resolved" || bucket === "returned") {
      resolved += 1;
      if (row) row.resolved += 1;
    }
  });

  const byDepartment = new Map();
  ngDevices.forEach((n) => {
    const dept = String(n.department || "Unassigned").trim() || "Unassigned";
    const cur = byDepartment.get(dept) || { department: dept, count: 0, stages: new Map() };
    cur.count += 1;
    const st = String(n.ngStage || "").trim();
    if (st) cur.stages.set(st, (cur.stages.get(st) || 0) + 1);
    byDepartment.set(dept, cur);
  });

  return {
    open,
    resolved,
    byStage: Array.from(byStage.values()).filter((r) => r.ng + r.resolved > 0),
    reasons: Array.from(reasons.values()).sort((a, b) => b.count - a.count).slice(0, 10),
    byDepartment: Array.from(byDepartment.values())
      .map((d) => ({ department: d.department, count: d.count, stages: Array.from(d.stages.entries()).map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count) }))
      .sort((a, b) => b.count - a.count),
  };
};

// ---- loading ------------------------------------------------------------------------------------------------------------------------

const loadKitsAndNg = async ({ planId }) => {
  const mongoose = require("mongoose");
  const PlaningAndSchedulingModel = require("../../models/planingAndSchedulingModel");
  const ProcessModel = require("../../models/process");
  const DeviceModel = require("../../models/device");
  const RecordModel = require("../../models/deviceTestModel");
  const UserModel = require("../../models/User");
  const AllocationModel = require("../../models/kitAllocationTransaction");
  const LineKitsModel = require("../../models/assignKitsToLine");
  const ReturnModel = require("../../models/returnKitToStore");
  const TransferModel = require("../../models/kitTransferRequest");
  const NgDeviceModel = require("../../models/NGDevice");
  const s = svc();
  const limit = Number(process.env.PLAN_INSIGHTS_SCAN_LIMIT) || 50000;

  if (!mongoose.Types.ObjectId.isValid(String(planId || ""))) return { ok: false, status: 400, message: "Invalid plan id" };
  const plan = await PlaningAndSchedulingModel.findById(planId).lean();
  if (!plan) return { ok: false, status: 404, message: "Plan not found" };
  const proc = plan.selectedProcess ? await ProcessModel.findById(plan.selectedProcess).lean() : null;
  if (!proc) return { ok: false, status: 404, message: "Process not found" };
  const processId = proc._id;

  const [allocations, lineKits, returns, transfers, ngDevices, records, devices] = await Promise.all([
    AllocationModel.find({ processId }).sort({ allocatedAt: 1 }).limit(500).lean(),
    LineKitsModel.find({ planId }).sort({ createdAt: 1 }).limit(200).lean(),
    ReturnModel.find({ processId }).sort({ createdAt: 1 }).limit(500).lean(),
    TransferModel.find({ $or: [{ fromProcessId: processId }, { toProcessId: processId }] }).sort({ createdAt: 1 }).limit(500).lean(),
    NgDeviceModel.find({ processId }).select("department ngStage").limit(20000).lean(),
    RecordModel.find({ processId }).select("deviceId serialNo stageName currentStage status assignedDeviceTo flowVersion ngDescription reason createdAt").sort({ createdAt: -1 }).limit(limit).lean(),
    DeviceModel.find({ processID: processId, ...(proc.selectedProduct ? { productType: proc.selectedProduct } : {}) }).select("_id serialNo flowVersion").lean(),
  ]);

  const userIds = Array.from(new Set([...allocations.map((a) => a.allocatedBy), ...returns.map((r) => r.userId)].map(idOf).filter((id) => mongoose.Types.ObjectId.isValid(id))));
  const users = userIds.length ? await UserModel.find({ _id: { $in: userIds } }).select("name").lean() : [];
  const names = new Map(users.map((u) => [String(u._id), { name: u.name || "" }]));

  const aliasLookup = s.buildStageAliasLookup({ processStages: proc.stages || [], commonStages: proc.commonStages || [] });
  const stageNames = [...(proc.stages || []), ...(proc.commonStages || [])].map((st) => String(st?.stageName || st?.name || "")).filter(Boolean);
  const timeline = buildKitTimeline({ allocations, lineKits, returns, transfers, processId, names });
  const ng = buildNgOverview({ records, devices, aliasLookup, stages: stageNames, ngDevices });

  return {
    ok: true,
    body: {
      status: 200,
      plan: { id: String(plan._id), name: plan.processName || proc.name || "" },
      process: { id: String(proc._id), status: proc.status || "", quantity: num(proc.quantity), issuedKits: num(proc.issuedKits), consumedKits: num(proc.consumedKits) },
      kits: timeline,
      ng,
      partial: records.length >= limit,
    },
  };
};

module.exports = { buildKitTimeline, buildNgOverview, loadKitsAndNg };
