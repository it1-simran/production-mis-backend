const test = require("node:test");
const assert = require("node:assert/strict");
const { shapeOperations, plannedByStage, stageOnSeat } = require("../../services/planning/planOperations");

const PROCESS = {
  _id: "proc-1",
  name: "AIS140",
  status: "active",
  quantity: "1000",
  issuedKits: 1000,
  consumedKits: 120,
  iapNo: "IAP-9",
  stages: [{ stageName: "Visual Inspection" }, { stageName: "Functional" }],
  commonStages: [{ stageName: "QC" }],
};

const plan = (over = {}) => ({
  _id: "plan-1",
  processName: "AIS140",
  isDrafted: 0,
  assignedStages: JSON.stringify({
    "0-0": [{ name: "Visual Inspection", upha: 50 }],
    "0-1": [{ name: "Visual Inspection", upha: 50 }],
    "1-0": [{ name: "Functional", upha: 40 }],
    "1-1": [{ name: "Reserved", reserved: true }],
  }),
  assignedOperators: JSON.stringify({
    "0-0": [{ _id: "u1", name: "Asha Rao" }],
    "0-1": [{ _id: "u1", name: "Asha Rao" }, { _id: "u2", name: "Bala K" }],
  }),
  assignedCustomStagesOp: JSON.stringify([[{ _id: "u3", name: "Chitra" }]]),
  ...over,
});

const INSIGHTS = {
  generatedAt: "2026-10-08T05:00:00.000Z",
  totals: { tested: 300, pass: 250, ng: 50, wip: 80, lineIssueKits: 1000, kitsShortage: 620, targetUpha: 40, productiveHours: 8, efficiency: { process: 12.5, today: 3 } },
  byStage: [
    { stageName: "Visual Inspection", upha: 50, achievedUph: 31.25, tested: 180, pass: 150, ng: 30, wip: 60 },
    { stageName: "Functional", upha: 40, achievedUph: 12.5, tested: 100, pass: 80, ng: 20, wip: 20 },
    { stageName: "QC", upha: 0, achievedUph: 0, tested: 20, pass: 20, ng: 0, wip: 0 },
  ],
  bySeatStage: [{ seatKey: "0-0", stageName: "Visual Inspection", tested: 90, pass: 75, ng: 15, wip: 30, extra: "x" }],
  latestRecords: [],
};
const KIT = { issuedKits: 900, status: "CONFIRM", issuedKitsStatus: "ISSUED", iapNo: "IAP-9", seatDetails: [{ rowNumber: "0", seatNumber: "1", issuedKits: 400 }, { rowNumber: "1", seatNumber: "0", issuedKits: 500 }] };

test("stageOnSeat keeps the first real entry of each seat and skips reservations", () => {
  const seats = stageOnSeat(JSON.parse(plan().assignedStages));
  assert.deepEqual(Array.from(seats.entries()), [["0-0", "Visual Inspection"], ["0-1", "Visual Inspection"], ["1-0", "Functional"]]);
});

test("planned operators are grouped by stage, once each, with the seats they are on; common stages use their own list", () => {
  const planned = plannedByStage(plan(), PROCESS);
  const vi = planned.get("visual inspection");
  assert.deepEqual(vi.seatKeys, ["0-0", "0-1"]);
  assert.deepEqual(Array.from(vi.operators.values()), [{ id: "u1", name: "Asha Rao", seatKeys: ["0-0", "0-1"] }, { id: "u2", name: "Bala K", seatKeys: ["0-1"] }]);
  assert.equal(planned.get("functional").operators.size, 0);
  const qc = planned.get("qc");
  assert.equal(qc.common, true);
  assert.deepEqual(Array.from(qc.operators.values()), [{ id: "u3", name: "Chitra", seatKeys: [] }]);
});

test("the figures are the insights figures, passed through untouched", () => {
  const out = shapeOperations({ plan: plan(), process: PROCESS, insights: INSIGHTS, kit: KIT, plansOnProcess: 1, kitConfirmed: true });
  assert.deepEqual([out.totals.tested, out.totals.pass, out.totals.ng, out.totals.wip], [300, 250, 50, 80]);
  assert.equal(out.totals.passRate, 83.3);
  assert.equal(out.totals.overQuantity, false);
  assert.equal(out.totals.lineIssueKits, 1000);
  assert.equal(out.totals.kitsShortage, 620);
  assert.deepEqual(out.stages.map((s) => [s.name, s.pass, s.ng, s.wip, s.passRate]), [["Visual Inspection", 150, 30, 60, 83.3], ["Functional", 80, 20, 20, 80], ["QC", 20, 0, 0, 100]]);
  assert.equal(out.stages[0].targetUpha, 50);
  assert.equal(out.stages[0].achievedUph, 31.25);
  assert.equal(out.process.kitConfirmed, true);
  assert.equal(out.process.quantity, 1000, "the quantity is a number even though the process stores a string");
  assert.deepEqual(out.bySeatStage, [{ seatKey: "0-0", stageName: "Visual Inspection", tested: 90, pass: 75, ng: 15, wip: 30 }], "only the known fields are passed on");
  assert.equal(out.generatedAt, "2026-10-08T05:00:00.000Z");
});

test("each stage row carries its seats and planned operators", () => {
  const out = shapeOperations({ plan: plan(), process: PROCESS, insights: INSIGHTS, kit: KIT });
  const [vi, fn, qc] = out.stages;
  assert.equal(vi.seats, 2);
  assert.deepEqual(vi.operators.map((o) => o.name), ["Asha Rao", "Bala K"]);
  assert.equal(fn.seats, 1);
  assert.deepEqual(fn.operators, []);
  assert.equal(qc.common, true);
  assert.equal(qc.seats, 0);
  assert.deepEqual(qc.operators.map((o) => o.name), ["Chitra"]);
});

test("kits: store, line and per-seat figures", () => {
  const out = shapeOperations({ plan: plan(), process: PROCESS, insights: INSIGHTS, kit: KIT });
  assert.deepEqual(
    { ...out.kits, seats: undefined },
    { required: 1000, storeIssued: 1000, consumed: 120, pending: 880, short: 0, surplus: 0, lineAllocated: 900, lineStatus: "CONFIRM", issuedStatus: "ISSUED", iapNo: "IAP-9", seats: undefined }
  );
  assert.deepEqual(out.kits.seats, [
    { seatKey: "0-1", rowNumber: "0", seatNumber: "1", kits: 400, stageName: "Visual Inspection" },
    { seatKey: "1-0", rowNumber: "1", seatNumber: "0", kits: 500, stageName: "Functional" },
  ]);
  const short = shapeOperations({ plan: plan(), process: { ...PROCESS, issuedKits: 700 }, insights: INSIGHTS, kit: null });
  assert.deepEqual([short.kits.short, short.kits.surplus, short.kits.lineAllocated, short.kits.lineStatus], [300, 0, 0, null]);
  const over = shapeOperations({ plan: plan(), process: { ...PROCESS, issuedKits: 1100 }, insights: INSIGHTS, kit: null });
  assert.deepEqual([over.kits.short, over.kits.surplus], [0, 100]);
});

test("a plan that has not started gives zeros, not errors", () => {
  const empty = { totals: {}, byStage: [], bySeatStage: [], latestRecords: [] };
  const out = shapeOperations({ plan: plan({ isDrafted: 1, assignedStages: "{}", assignedOperators: "{}", assignedCustomStagesOp: "[]" }), process: { ...PROCESS, status: "Waiting_Kits_allocation", issuedKits: 0, consumedKits: 0 }, insights: empty, kit: null });
  assert.deepEqual([out.totals.pass, out.totals.ng, out.totals.wip, out.totals.passRate], [0, 0, 0, null]);
  assert.deepEqual(out.stages.map((s) => [s.name, s.pass, s.ng, s.wip]), [["Visual Inspection", 0, 0, 0], ["Functional", 0, 0, 0], ["QC", 0, 0, 0]], "every stage is listed, all zero");
  assert.equal(out.plan.isDrafted, true);
  assert.equal(out.process.kitConfirmed, false);
  assert.equal(out.kits.pending, 1000);
  assert.equal(out.kits.short, 1000);
});

test("more output than the planned quantity is flagged, and a full scan is reported as partial", () => {
  const big = { ...INSIGHTS, totals: { ...INSIGHTS.totals, pass: 990, ng: 50 } };
  assert.equal(shapeOperations({ plan: plan(), process: PROCESS, insights: big }).totals.overQuantity, true);
  const scanned = { ...INSIGHTS, latestRecords: new Array(5).fill({}) };
  const partial = shapeOperations({ plan: plan(), process: PROCESS, insights: scanned, scanLimit: 5 });
  assert.equal(partial.scope.partial, true);
  assert.equal(shapeOperations({ plan: plan(), process: PROCESS, insights: scanned, scanLimit: 6 }).scope.partial, false);
});

test("the scope says the figures are per process, and reports the date range and other plans on the process", () => {
  const out = shapeOperations({ plan: plan(), process: PROCESS, insights: INSIGHTS, plansOnProcess: 3, from: "2026-10-01", to: "2026-10-07" });
  assert.deepEqual(
    { by: out.scope.by, plansOnProcess: out.scope.plansOnProcess, from: out.scope.from, to: out.scope.to },
    { by: "process", plansOnProcess: 3, from: "2026-10-01", to: "2026-10-07" }
  );
});

test("with a date range pass and NG follow the range but WIP is the live position", () => {
  const ranged = { ...INSIGHTS, totals: { ...INSIGHTS.totals, pass: 20, ng: 5, wip: 0 }, byStage: INSIGHTS.byStage.map((s) => ({ ...s, pass: 5, ng: 1, wip: 0 })), bySeatStage: [{ seatKey: "0-0", stageName: "Visual Inspection", tested: 9, pass: 5, ng: 1, wip: 0 }] };
  const out = shapeOperations({ plan: plan(), process: PROCESS, insights: ranged, liveInsights: INSIGHTS, from: "2026-10-01", to: "2026-10-07" });
  assert.deepEqual([out.totals.pass, out.totals.ng, out.totals.wip], [20, 5, 80]);
  assert.deepEqual(out.stages.map((s) => [s.pass, s.wip]), [[5, 60], [5, 20], [5, 0]]);
  assert.equal(out.bySeatStage[0].wip, 30);
  assert.equal(out.scope.wipIsLive, true);
  assert.equal(shapeOperations({ plan: plan(), process: PROCESS, insights: INSIGHTS }).scope.wipIsLive, false);
});

test("every stage of the process is listed in process order, with zeros for a stage nothing has happened on", () => {
  const sparse = { ...INSIGHTS, byStage: [INSIGHTS.byStage[1]] }; // the engine only reports Functional
  const out = shapeOperations({ plan: plan(), process: PROCESS, insights: sparse, kit: KIT });
  assert.deepEqual(out.stages.map((s) => [s.name, s.pass, s.wip, s.common]), [["Visual Inspection", 0, 0, false], ["Functional", 80, 20, false], ["QC", 0, 0, true]]);
  assert.equal(out.stages[0].seats, 2, "the empty row still carries its seats and operators");
  assert.equal(out.stages[0].passRate, null);
  assert.equal(out.stages[1].targetUpha, 40);
  const extra = shapeOperations({ plan: plan(), process: PROCESS, insights: { ...INSIGHTS, byStage: [...INSIGHTS.byStage, { stageName: "Legacy stage", pass: 1, ng: 0, wip: 0, tested: 1 }] }, kit: KIT });
  assert.equal(extra.stages[extra.stages.length - 1].name, "Legacy stage", "a stage the engine reports that is not in the process follows the rest");
});
