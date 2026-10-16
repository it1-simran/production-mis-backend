const test = require("node:test");
const assert = require("node:assert/strict");
const { stripSeats, stripCommon } = require("../../services/planning/operatorTakeover");
const { normalizeDraft } = require("../../services/planning/draft");

test("stripSeats removes the operator from every seat and keeps the seats", () => {
  const raw = JSON.stringify({ "0-0": [{ _id: "u1" }, { _id: "u2" }], "0-1": [{ _id: "u1" }], "0-2": [{ _id: "u3" }] });
  const r = stripSeats(raw, new Set(["u1"]));
  assert.equal(r.changed, true);
  assert.deepEqual(r.value, { "0-0": [{ _id: "u2" }], "0-1": [], "0-2": [{ _id: "u3" }] });
  assert.equal(stripSeats(raw, new Set(["nobody"])).changed, false);
  assert.deepEqual(stripSeats("not json", new Set(["u1"])).value, {});
  assert.deepEqual(stripSeats({ "0-0": { _id: "u1" } }, new Set(["u1"])).value, { "0-0": [] }, "a single operator stored as an object");
});

test("stripCommon removes the operator from common stages by position and leaves anything that is not an operator list", () => {
  const raw = JSON.stringify([[{ _id: "u1" }, { _id: "u2" }], [], { name: "PDI", totalUPHA: 4 }]);
  const r = stripCommon(raw, new Set(["u1"]));
  assert.equal(r.changed, true);
  assert.deepEqual(r.value, [[{ _id: "u2" }], [], { name: "PDI", totalUPHA: 4 }], "positions kept, the stage-stat object untouched");
  assert.equal(stripCommon(raw, new Set(["u9"])).changed, false);
});

test("the draft keeps only valid, distinct ids in takeOverOperatorIds", () => {
  const a = "6a61d4dd83de7e6e00b272a5";
  const b = "6a701e8076c2061d9c6a015c";
  const d = normalizeDraft({ selectedProcess: a, takeOverOperatorIds: [a, a, "nope", "", null, b] }, {});
  assert.deepEqual(d.takeOverOperatorIds, [a, b]);
  assert.deepEqual(normalizeDraft({ selectedProcess: a }, {}).takeOverOperatorIds, []);
  assert.deepEqual(normalizeDraft({ selectedProcess: a, takeOverOperatorIds: "x" }, {}).takeOverOperatorIds, []);
});
