// Production figures for one plan (WIP, pass, NG, kits, stages, planned operators), read only.
//
// SINGLE SOURCE OF NUMBERS: nothing is counted here. Pass, NG and WIP come from planInsightsService.computePlanInsights
// (the engine behind the live monitoring page), called with exactly the inputs the legacy `insights` handler builds,
// so this screen and the monitoring page cannot disagree. shapeOperations() is PURE and only reshapes.
//
//   shapeOperations({ plan, process, insights, kit, plansOnProcess, from, to, scanLimit })  -> response body
//   loadOperations({ planId, from, to })                                                    -> { ok, body } | { ok:false, status, message }

const { safeParse, toList } = require("./draft");
const { normName } = require("./capacity");

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const SCAN_LIMIT = () => Number(process.env.PLAN_INSIGHTS_SCAN_LIMIT) || 50000;

const num = (n) => Number(n) || 0;
const rate = (pass, ng) => (num(pass) + num(ng) > 0 ? Math.round((num(pass) / (num(pass) + num(ng))) * 1000) / 10 : null);

// seatKey -> the stage entry placed on it (the first real entry, not a reservation)
const stageOnSeat = (assignedStages) => {
  const out = new Map();
  Object.entries(assignedStages || {}).forEach(([seatKey, entries]) => {
    const first = toList(entries).find((e) => e && !e.reserved);
    if (first) out.set(seatKey, String(first.name || first.stageName || ""));
  });
  return out;
};

const operatorRef = (op) => ({ id: String(op?._id || op?.userId || op?.id || ""), name: op?.name || "" });

// stage name (normalised) -> { seatKeys, operators:[{id,name,seatKeys}] } from the plan's seat assignments
const plannedByStage = (plan, process) => {
  const seats = stageOnSeat(safeParse(plan?.assignedStages, {}) || {});
  const operatorsBySeat = safeParse(plan?.assignedOperators, {}) || {};
  const out = new Map();
  const slot = (name) => {
    const key = normName(name);
    if (!out.has(key)) out.set(key, { seatKeys: [], operators: new Map(), common: false });
    return out.get(key);
  };
  seats.forEach((stageName, seatKey) => {
    const s = slot(stageName);
    s.seatKeys.push(seatKey);
    toList(operatorsBySeat[seatKey]).forEach((op) => {
      const ref = operatorRef(op);
      if (!ref.id && !ref.name) return;
      const k = ref.id || ref.name;
      const have = s.operators.get(k) || { ...ref, seatKeys: [] };
      have.seatKeys.push(seatKey);
      s.operators.set(k, have);
    });
  });
  // common stages are not on seats; their operators are listed by position
  const commonOps = safeParse(plan?.assignedCustomStagesOp, []) || [];
  (process?.commonStages || []).forEach((cs, i) => {
    const s = slot(cs.stageName || cs.name);
    s.common = true;
    toList(commonOps[i]).forEach((op) => {
      const ref = operatorRef(op);
      if (!ref.id && !ref.name) return;
      s.operators.set(ref.id || ref.name, { ...ref, seatKeys: [] });
    });
  });
  return out;
};

// liveInsights: the same computation WITHOUT a date range. Pass and NG follow the range; WIP is always the live position (as on the
// monitoring page), so when a range is set the WIP figures are taken from here.
// The insights engine only lists a stage once something has happened on it. The funnel should show every stage of the process, in
// process order, so a stage with no activity yet is added as a row of zeros (no figure changes). Stages the engine reports that are not
// in the process definition (aliases, legacy names) follow after.
const withAllStages = (rows, process) => {
  const byName = new Map(rows.map((r) => [normName(r.stageName), r]));
  const used = new Set();
  const out = [];
  [...toList(process?.stages), ...toList(process?.commonStages)].forEach((def) => {
    const name = def?.stageName || def?.name;
    const key = normName(name);
    if (!key || used.has(key)) return;
    used.add(key);
    out.push(byName.get(key) || { stageName: name, upha: num(def?.upha), achievedUph: 0, tested: 0, pass: 0, ng: 0, wip: 0 });
  });
  rows.forEach((r) => {
    if (!used.has(normName(r.stageName))) out.push(r);
  });
  return out;
};

const shapeOperations = ({ plan, process, insights, liveInsights = null, kit = null, plansOnProcess = 1, from = "", to = "", scanLimit = SCAN_LIMIT(), kitConfirmed = false }) => {
  const totals = insights?.totals || {};
  const quantity = num(process?.quantity);
  const planned = plannedByStage(plan, process);
  const seatStage = stageOnSeat(safeParse(plan?.assignedStages, {}) || {});

  const live = liveInsights || insights;
  const liveStageWip = new Map((live?.byStage || []).map((r) => [normName(r.stageName), num(r.wip)]));
  const liveSeatWip = new Map((live?.bySeatStage || []).map((r) => [`${r.seatKey}|${normName(r.stageName)}`, num(r.wip)]));
  const stages = withAllStages(insights?.byStage || [], process).map((row) => {
    const p = planned.get(normName(row.stageName)) || { seatKeys: [], operators: new Map(), common: false };
    return {
      name: row.stageName,
      common: !!p.common,
      seats: p.seatKeys.length,
      seatKeys: p.seatKeys,
      targetUpha: num(row.upha),
      achievedUph: num(row.achievedUph),
      tested: num(row.tested),
      wip: liveInsights ? liveStageWip.get(normName(row.stageName)) || 0 : num(row.wip),
      pass: num(row.pass),
      ng: num(row.ng),
      passRate: rate(row.pass, row.ng),
      operators: Array.from(p.operators.values()),
    };
  });

  const kitSeats = toList(kit?.seatDetails).map((d) => {
    const seatKey = `${d.rowNumber}-${d.seatNumber}`;
    return { seatKey, rowNumber: String(d.rowNumber ?? ""), seatNumber: String(d.seatNumber ?? ""), kits: num(d.issuedKits), stageName: seatStage.get(seatKey) || "" };
  });
  const storeIssued = num(process?.issuedKits);
  const consumed = num(process?.consumedKits);

  return {
    status: 200,
    generatedAt: insights?.generatedAt || new Date().toISOString(),
    plan: { id: String(plan?._id || ""), name: plan?.processName || process?.name || "", isDrafted: Number(plan?.isDrafted) === 1 },
    process: { id: String(process?._id || ""), name: process?.name || "", status: process?.status || "", quantity, kitConfirmed: !!kitConfirmed },
    scope: {
      // the figures are for the whole process, exactly as on the monitoring page
      by: "process",
      wipIsLive: !!liveInsights,
      plansOnProcess,
      from: from || null,
      to: to || null,
      partial: (insights?.latestRecords?.length || 0) >= scanLimit,
      scanLimit,
    },
    totals: {
      tested: num(totals.tested),
      pass: num(totals.pass),
      ng: num(totals.ng),
      wip: liveInsights ? num(live?.totals?.wip) : num(totals.wip),
      passRate: rate(totals.pass, totals.ng),
      overQuantity: quantity > 0 && num(totals.pass) + num(totals.ng) > quantity,
      lineIssueKits: num(totals.lineIssueKits),
      kitsShortage: num(totals.kitsShortage),
      targetUpha: num(totals.targetUpha),
      productiveHours: num(totals.productiveHours),
      efficiency: { process: num(totals.efficiency?.process), today: num(totals.efficiency?.today) },
    },
    stages,
    bySeatStage: (insights?.bySeatStage || []).map((r) => ({ seatKey: r.seatKey, stageName: r.stageName, tested: num(r.tested), pass: num(r.pass), ng: num(r.ng), wip: liveInsights ? liveSeatWip.get(`${r.seatKey}|${normName(r.stageName)}`) || 0 : num(r.wip) })),
    kits: {
      required: quantity,
      storeIssued,
      consumed,
      pending: Math.max(quantity - consumed, 0),
      short: Math.max(0, quantity - storeIssued),
      surplus: Math.max(0, storeIssued - quantity),
      lineAllocated: num(kit?.issuedKits),
      lineStatus: kit?.status || null,
      issuedStatus: kit?.issuedKitsStatus || null,
      iapNo: kit?.iapNo || process?.iapNo || "",
      seats: kitSeats,
    },
  };
};

// Loads what the legacy `insights` handler loads and runs the SAME computation.
const loadOperations = async ({ planId, from = "", to = "" }) => {
  const mongoose = require("mongoose");
  const PlaningAndSchedulingModel = require("../../models/planingAndSchedulingModel");
  const ProcessModel = require("../../models/process");
  const ShiftModel = require("../../models/shiftManagement");
  const assignKitsToLineModel = require("../../models/assignKitsToLine");
  const insightsService = require("../planInsightsService");

  if (!mongoose.Types.ObjectId.isValid(String(planId || ""))) return { ok: false, status: 400, message: "Invalid plan id" };
  if ((from && !DAY_KEY.test(from)) || (to && !DAY_KEY.test(to))) return { ok: false, status: 400, message: "from and to must be dates (YYYY-MM-DD)." };
  if (from && to && from > to) return { ok: false, status: 400, message: "The end of the range is before its start." };

  const plan = await PlaningAndSchedulingModel.findById(planId).lean();
  if (!plan) return { ok: false, status: 404, message: "Plan not found" };
  const process = plan.selectedProcess ? await ProcessModel.findById(plan.selectedProcess).lean() : null;
  if (!process) return { ok: false, status: 404, message: "Process not found" };

  const [shift, kit, plansOnProcess] = await Promise.all([
    plan.selectedShift && mongoose.Types.ObjectId.isValid(String(plan.selectedShift)) ? ShiftModel.findById(plan.selectedShift).lean() : null,
    assignKitsToLineModel.findOne({ planId, processId: process._id }).lean().catch(() => null),
    PlaningAndSchedulingModel.countDocuments({ selectedProcess: process._id, isDrafted: 0 }),
  ]);

  const assignedStages = insightsService.normalizeAssignedStagesPayload(insightsService.safeJsonParse(plan.assignedStages, {}), process.stages || [], process.commonStages || []);
  const inputs = {
    planId,
    processId: process._id || "",
    assignedStages,
    processStages: process.stages || [],
    commonStages: process.commonStages || [],
    selectedProduct: process.selectedProduct || "",
    quantity: process.quantity || 0,
    shift,
    issuedKits: kit?.issuedKits || 0,
    processStatus: process.status || "",
    processIssuedKits: Number(process.issuedKits || 0),
    processConsumedKits: Number(process.consumedKits || 0),
  };
  const insights = await insightsService.computePlanInsights({ ...inputs, dateFrom: from, dateTo: to });
  const liveInsights = from || to ? await insightsService.computePlanInsights({ ...inputs, dateFrom: "", dateTo: "" }) : null;

  return {
    ok: true,
    body: shapeOperations({
      plan,
      process,
      insights,
      liveInsights,
      kit,
      plansOnProcess,
      from,
      to,
      kitConfirmed: insightsService.isKitConfirmedProcessStatus(process.status),
    }),
  };
};

module.exports = { shapeOperations, loadOperations, plannedByStage, stageOnSeat };
