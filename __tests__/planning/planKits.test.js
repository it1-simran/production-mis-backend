const test = require("node:test");
const assert = require("node:assert/strict");
const svc = require("../../services/planInsightsService");
const { buildKitTimeline, buildNgOverview } = require("../../services/planning/planKits");

const NAMES = new Map([["u1", { name: "Store Operator" }], ["u2", { name: "Manager" }]]);
const day = (d, h = 10) => new Date(Date.UTC(2026, 9, d, h, 0, 0));
const PID = "proc-1";

test("kit movements are listed oldest first, each with its quantity and who did it", () => {
  const t = buildKitTimeline({
    processId: PID,
    names: NAMES,
    allocations: [{ allocatedAt: day(1), quantity: 600, iapNo: "IAP-1", allocatedBy: "u1" }, { allocatedAt: day(3), quantity: 50, iapNo: "IAP-2", allocatedBy: "u1" }],
    lineKits: [{ createdAt: day(2), updatedAt: day(2, 12), issuedKits: 500, status: "CONFIRM", seatDetails: [{}, {}], iapNo: "IAP-1" }],
    returns: [{ createdAt: day(4), returnedKits: 20, status: "RECIVED", userId: "u2" }],
    transfers: [],
  });
  assert.deepEqual(t.events.map((e) => e.kind), ["store_allocation", "line_allocation", "line_confirmed", "store_allocation", "return"]);
  assert.deepEqual(t.events.map((e) => e.quantity), [600, 500, 500, 50, 20]);
  assert.equal(t.events[0].by, "Store Operator");
  assert.equal(t.events[0].detail, "IAP IAP-1");
  assert.equal(t.events[1].detail, "2 seats, IAP IAP-1");
  assert.equal(t.events[4].by, "Manager");
  assert.equal(t.events[4].detail, "received by the store");
  assert.deepEqual(t.totals, { allocatedByStore: 650, returnedToStore: 20, transferredIn: 0, transferredOut: 0, onTheLine: 500 });
});

test("a line allocation still waiting for the floor has no confirmation event, and a rejected one says so", () => {
  const waiting = buildKitTimeline({ processId: PID, lineKits: [{ createdAt: day(2), issuedKits: 100, status: "ASSIGN_TO_OPERATOR", seatDetails: [{}] }] });
  assert.deepEqual(waiting.events.map((e) => e.kind), ["line_allocation"]);
  const rejected = buildKitTimeline({ processId: PID, lineKits: [{ createdAt: day(2), updatedAt: day(2, 15), issuedKits: 100, status: "REJECT", seatDetails: [] }] });
  assert.deepEqual(rejected.events.map((e) => e.kind), ["line_allocation", "line_rejected"]);
});

test("the kits on the line are the latest allocation, not the sum of every one", () => {
  const t = buildKitTimeline({ processId: PID, lineKits: [{ createdAt: day(2), issuedKits: 100, status: "CONFIRM", seatDetails: [] }, { createdAt: day(5), issuedKits: 300, status: "ASSIGN_TO_OPERATOR", seatDetails: [] }] });
  assert.equal(t.totals.onTheLine, 300);
});

test("transfers are in or out depending on which process this is, and only approved ones count", () => {
  const t = buildKitTimeline({
    processId: PID,
    transfers: [
      { createdAt: day(2), updatedAt: day(3), fromProcessId: "other", toProcessId: PID, fromProcessName: "Old process", quantity: 15, status: "APPROVED", targetStage: "Functional", requesterName: "Asha" },
      { createdAt: day(4), updatedAt: day(4), fromProcessId: PID, toProcessId: "other", toProcessName: "New process", quantity: 5, status: "APPROVED" },
      { createdAt: day(5), fromProcessId: PID, toProcessId: "other", toProcessName: "New process", quantity: 99, status: "PENDING" },
      { createdAt: day(6), fromProcessId: "other", toProcessId: PID, quantity: 77, status: "REJECTED" },
    ],
  });
  assert.deepEqual(t.events.map((e) => e.kind), ["transfer_in", "transfer_out", "transfer_out", "transfer_in"]);
  assert.equal(t.events[0].title, "Kits transferred in from Old process");
  assert.equal(t.events[0].detail, "approved, to Functional");
  assert.equal(t.events[0].by, "Asha");
  assert.equal(t.events[2].detail, "waiting for approval");
  assert.deepEqual([t.totals.transferredIn, t.totals.transferredOut], [15, 5]);
});

test("an empty history gives an empty timeline and zero totals", () => {
  const t = buildKitTimeline({ processId: PID });
  assert.deepEqual(t.events, []);
  assert.deepEqual(t.totals, { allocatedByStore: 0, returnedToStore: 0, transferredIn: 0, transferredOut: 0, onTheLine: 0 });
});

// ---- NG ---------------------------------------------------------------------------------------------------------------------------

const LOOKUP = svc.buildStageAliasLookup({ processStages: [{ stageName: "Visual Inspection" }, { stageName: "Functional" }], commonStages: [] });
let n = 0;
const rec = (deviceId, stageName, status, minute, extra = {}) => ({ _id: `r${++n}`, deviceId, serialNo: `S-${deviceId}`, stageName, status, flowVersion: 1, createdAt: new Date(Date.UTC(2026, 9, 7, 6, minute)), ...extra });
const newestFirst = (list) => list.slice().sort((a, b) => b.createdAt - a.createdAt);
const ng = (records, extra = {}) => buildNgOverview({ records: newestFirst(records), devices: [], aliasLookup: LOOKUP, stages: ["Visual Inspection", "Functional"], ...extra });

test("open NG counts devices whose latest result at a stage is NG, with the reasons grouped", () => {
  const o = ng([
    rec("A", "Visual Inspection", "NG", 0, { ngDescription: "Scratch" }),
    rec("B", "Visual Inspection", "NG", 1, { ngDescription: "scratch" }),
    rec("C", "Functional", "NG", 2, { reason: "Power fail" }),
    rec("D", "Visual Inspection", "NG", 3),
    rec("D", "Visual Inspection", "Pass", 9), // retried and passed: no longer NG
  ]);
  assert.equal(o.open, 3);
  assert.deepEqual(o.reasons.map((r) => [r.reason, r.count]), [["Scratch", 2], ["Power fail", 1]]);
  assert.deepEqual(o.byStage.map((s) => [s.stage, s.ng]), [["Visual Inspection", 2], ["Functional", 1]]);
});

test("a device resolved back to the stage it failed at is resolved, not open NG", () => {
  const o = ng([rec("E", "Visual Inspection", "NG", 0), rec("E", "QC", "Resolved", 5, { assignedDeviceTo: "Visual Inspection" }), rec("F", "Functional", "NG", 6, { ngDescription: "Bad flash" })]);
  assert.equal(o.open, 1);
  assert.equal(o.resolved, 2, "the resolved record and the NG it cleared");
  assert.deepEqual(o.reasons.map((r) => r.reason), ["Bad flash"]);
});

test("NG with no reason is grouped as such, and departments are counted with their stages", () => {
  const o = ng([rec("A", "Visual Inspection", "NG", 0)], {
    ngDevices: [{ department: "TRC", ngStage: "Functional" }, { department: "TRC", ngStage: "Functional" }, { department: "QC", ngStage: "Visual Inspection" }, { department: "", ngStage: "" }],
  });
  assert.equal(o.reasons[0].reason, "No reason recorded");
  assert.deepEqual(o.byDepartment.map((d) => [d.department, d.count]), [["TRC", 2], ["QC", 1], ["Unassigned", 1]]);
  assert.deepEqual(o.byDepartment[0].stages, [{ stage: "Functional", count: 2 }]);
});

test("nothing recorded gives zeros", () => {
  const o = ng([]);
  assert.deepEqual([o.open, o.resolved, o.reasons.length, o.byStage.length, o.byDepartment.length], [0, 0, 0, 0, 0]);
});
