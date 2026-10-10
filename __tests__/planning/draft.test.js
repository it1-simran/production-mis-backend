const test = require("node:test");
const assert = require("node:assert/strict");
const { pickPlanFields, normalizeDraft, collectOperatorIds, collectJigIds, seatKeyParts, safeParse } = require("../../services/planning/draft");

const VALID_ID = "507f1f77bcf86cd799439011";
const VALID_ID_2 = "507f1f77bcf86cd799439012";

test("pickPlanFields drops fields a client must not set", () => {
  const body = {
    processName: "P",
    selectedProcess: VALID_ID,
    selectedRoom: VALID_ID,
    status: "completed",
    downTime: { from: "x" },
    overtimeWindows: [{ from: 1 }],
    overtimeSummary: {},
    createdBy: "someone",
    department: "x",
    _id: "forged",
    totalUPHA: "9999",
    estimatedEndDate: "01/01/30 00:00:00",
    issuedKits: "1",
    consumedKit: 50,
  };
  const created = pickPlanFields(body, "create");
  assert.deepEqual(Object.keys(created).sort(), ["processName", "selectedProcess", "selectedRoom"]);
  // the server computes totalUPHA / estimatedEndDate itself, so a client value is never trusted
  assert.equal(created.totalUPHA, undefined);
  assert.equal(created.estimatedEndDate, undefined);
});

test("pickPlanFields does not allow changing the process on update", () => {
  const updated = pickPlanFields({ selectedProcess: VALID_ID, selectedRoom: VALID_ID }, "update");
  assert.equal(updated.selectedProcess, undefined);
  assert.equal(updated.selectedRoom, VALID_ID);
});

test("pickPlanFields tolerates non-object bodies", () => {
  assert.deepEqual(pickPlanFields(null, "create"), {});
  assert.deepEqual(pickPlanFields("nope", "update"), {});
});

test("normalizeDraft parses JSON-string blobs and the client date format", () => {
  const draft = normalizeDraft({
    selectedProcess: VALID_ID,
    startDate: "05/10/26 00:00:00",
    repeatCount: "2",
    isDrafted: "1",
    assignedStages: JSON.stringify({ "0-0": [{ name: "A" }] }),
    assignedOperators: JSON.stringify({ "0-0": [{ _id: VALID_ID }] }),
    assignedCustomStagesOp: JSON.stringify([[{ _id: VALID_ID_2 }], []]),
  });
  assert.equal(draft.mode, "draft");
  assert.equal(draft.repeatCount, 2);
  assert.equal(draft.startDate.getFullYear(), 2026);
  assert.deepEqual(Object.keys(draft.assignedStages), ["0-0"]);
  assert.equal(draft.assignedCustomStagesOp.length, 2);
  assert.deepEqual(collectOperatorIds(draft).sort(), [VALID_ID, VALID_ID_2].sort());
});

test("normalizeDraft survives malformed blobs and bad numbers", () => {
  const draft = normalizeDraft({ assignedStages: "{not json", assignedOperators: "[1,2]", assignedCustomStagesOp: "oops", repeatCount: "abc", isDrafted: 0 });
  assert.deepEqual(draft.assignedStages, {});
  assert.deepEqual(draft.assignedOperators, {});
  assert.deepEqual(draft.assignedCustomStagesOp, []);
  assert.equal(draft.repeatCount, 1);
  assert.equal(draft.mode, "publish");
});

test("collectJigIds ignores values that are not object ids", () => {
  const draft = normalizeDraft({ assignedJigs: { "0-0": [{ _id: VALID_ID }], "0-1": [{ _id: "not-an-id" }] } });
  assert.deepEqual(collectJigIds(draft), [VALID_ID]);
});

test("seatKeyParts and safeParse edge cases", () => {
  assert.deepEqual(seatKeyParts("3-12"), { row: 3, seat: 12, valid: true });
  assert.equal(seatKeyParts("x-1").valid, false);
  assert.equal(seatKeyParts("").valid, false);
  assert.deepEqual(safeParse("{bad", { fallback: true }), { fallback: true });
  assert.deepEqual(safeParse("", 5), 5);
  assert.deepEqual(safeParse({ a: 1 }, null), { a: 1 });
});

test("plannedEndDate is whitelisted and parsed; absent means calculated", () => {
  const picked = pickPlanFields({ plannedEndDate: "09/10/26 00:00:00", status: "completed" }, "update");
  assert.deepEqual(Object.keys(picked), ["plannedEndDate"]);
  assert.equal(normalizeDraft({ plannedEndDate: "09/10/26 00:00:00" }).plannedEndDate.getDate(), 9);
  assert.equal(normalizeDraft({}).plannedEndDate, null);
  assert.equal(normalizeDraft({ plannedEndDate: "garbage" }).plannedEndDate, null);
});
