const test = require("node:test");
const assert = require("node:assert/strict");
const { getProductiveMinutes, computeCapacity, countSeatsPerStage } = require("../../services/planning/capacity");
const { DAY_SHIFT, NIGHT_SHIFT, PROCESS, stageEntry } = require("./helpers");

test("productive minutes exclude break intervals", () => {
  assert.equal(getProductiveMinutes(DAY_SHIFT), 480); // 4h + 4h, lunch excluded
  assert.equal(getProductiveMinutes(NIGHT_SHIFT), 480); // overnight 21:00-05:00
});

test("productive minutes fall back to start/end minus total break when there are no intervals", () => {
  assert.equal(getProductiveMinutes({ startTime: "09:00", endTime: "18:00", totalBreakTime: "60" }), 480);
  assert.equal(getProductiveMinutes({ startTime: "09:00", endTime: "18:00" }), 540);
  assert.equal(getProductiveMinutes(null), 0);
  assert.equal(getProductiveMinutes({}), 0);
});

test("seat counts ignore reserved entries and are case-insensitive", () => {
  const counts = countSeatsPerStage({
    "0-0": [stageEntry("Functional", 40)],
    "0-1": [{ ...stageEntry("functional", 40) }],
    "0-2": [{ ...stageEntry("Functional", 40), reserved: true }],
  });
  assert.equal(counts.get("functional"), 2);
});

test("the slowest stage (UPHA x seats) is the bottleneck", () => {
  const assignedStages = {
    "0-0": [stageEntry("Visual Inspection", 50)],
    "0-1": [stageEntry("Visual Inspection", 50)],
    "0-2": [stageEntry("Functional", 40)],
  };
  const cap = computeCapacity({ processStages: PROCESS.stages, assignedStages, shift: DAY_SHIFT, quantity: "1000" });
  assert.equal(cap.bottleneck.stage, "Functional"); // 40*1 < 50*2
  assert.equal(cap.bottleneck.uph, 40);
  assert.equal(cap.unitsPerDay, 40 * 8);
  assert.equal(Number(cap.daysNeeded.toFixed(4)), Number((1000 / 320).toFixed(4)));
  assert.deepEqual(cap.stagesWithoutSeats, []);
});

test("a stage with no seat is reported and does not become the bottleneck", () => {
  const cap = computeCapacity({
    processStages: PROCESS.stages,
    assignedStages: { "0-0": [stageEntry("Visual Inspection", 50)] },
    shift: DAY_SHIFT,
    quantity: 400,
  });
  assert.deepEqual(cap.stagesWithoutSeats, ["Functional"]);
  assert.equal(cap.bottleneck.stage, "Visual Inspection");
  assert.equal(cap.unitsPerDay, 400);
  assert.equal(cap.daysNeeded, 1);
});

test("zero capacity or quantity yields zero days instead of NaN/Infinity", () => {
  const none = computeCapacity({ processStages: PROCESS.stages, assignedStages: {}, shift: DAY_SHIFT, quantity: 100 });
  assert.equal(none.unitsPerDay, 0);
  assert.equal(none.daysNeeded, 0);
  assert.equal(none.bottleneck, null);
  const noQty = computeCapacity({ processStages: PROCESS.stages, assignedStages: { "0-0": [stageEntry("Visual Inspection", 50)] }, shift: DAY_SHIFT, quantity: "abc" });
  assert.equal(noQty.daysNeeded, 0);
  assert.equal(Number.isFinite(noQty.unitsPerDay), true);
});
