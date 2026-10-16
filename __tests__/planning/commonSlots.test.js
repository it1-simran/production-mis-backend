const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeCommonSlots, isStageCounter } = require("../../services/planning/commonSlots");

const op = (id) => ({ _id: id, name: id });
const counter = (name, n = 4) => ({ name, totalUPHA: n, passedDevice: 0, ngDevice: 0 });

test("a stage counter is recognised, an operator or an operator list is not", () => {
  assert.equal(isStageCounter(counter("PDI")), true);
  assert.equal(isStageCounter({ name: "PDI", operators: [op("u1")], totalUPHA: 1 }), false);
  assert.equal(isStageCounter(op("u1")), false);
  assert.equal(isStageCounter([op("u1")]), false);
  assert.equal(isStageCounter({ name: "x" }), false, "a name alone is not a counter");
  assert.equal(isStageCounter(null), false);
});

test("the operator lists keep their positions and the stored counters are carried over after them", () => {
  const stored = JSON.stringify([counter("PDI", 7)]);
  const out = mergeCommonSlots({ lists: [[op("u1")], [], [], []], commonCount: 4, existingRaw: stored });
  assert.deepEqual(out, [[op("u1")], [], [], [], counter("PDI", 7)]);
});

test("a counter that sat in a stage's slot moves to the end, so the slot can hold that stage's operators", () => {
  const stored = JSON.stringify([counter("PDI", 3), [op("old")]]);
  const out = mergeCommonSlots({ lists: [[op("u1")], [op("u2")]], commonCount: 2, existingRaw: stored });
  assert.deepEqual(out, [[op("u1")], [op("u2")], counter("PDI", 3)]);
});

test("saving again and again does not make the array grow", () => {
  let stored = JSON.stringify([counter("PDI"), counter("FG to Store", 2)]);
  const sizes = [];
  for (let i = 0; i < 4; i += 1) {
    // what the editor sends back after loading: one slot per stored entry, the counters as empty lists
    const loaded = JSON.parse(stored).map((slot) => (Array.isArray(slot) ? slot : []));
    const out = mergeCommonSlots({ lists: loaded, commonCount: 4, existingRaw: stored });
    stored = JSON.stringify(out);
    sizes.push(out.length);
  }
  assert.deepEqual(sizes, [6, 6, 6, 6], "4 stage slots + 2 counters, every time");
  assert.deepEqual(JSON.parse(stored).slice(4).map((c) => c.name), ["PDI", "FG to Store"]);
});

test("a slot past the common stages is kept only when it holds someone, and missing slots are filled in", () => {
  const out = mergeCommonSlots({ lists: [[], [], [op("u1")]], commonCount: 1, existingRaw: "" });
  assert.deepEqual(out, [[], [op("u1")]], "the empty extra slot is dropped, the occupied one is kept");
  assert.deepEqual(mergeCommonSlots({ lists: [], commonCount: 3, existingRaw: undefined }), [[], [], []]);
  assert.deepEqual(mergeCommonSlots({ lists: null, commonCount: 0, existingRaw: "not json" }), []);
});

test("a plan with no counters stores just the lists, and a single operator in a slot becomes a list", () => {
  assert.deepEqual(mergeCommonSlots({ lists: [[op("a")], op("b")], commonCount: 2, existingRaw: "[]" }), [[op("a")], [op("b")]]);
});
