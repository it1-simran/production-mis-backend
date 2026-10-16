// Parity tests: these mirror production-mis/src/utils/planOperatorMatching.test.ts and the
// behaviour of its filterCompatiblePlanOperators, so the server port cannot drift from the UI.
const test = require("node:test");
const assert = require("node:assert/strict");
const { operatorFitsStages, skillMatches, roleMatches, enrichStages } = require("../../services/planning/operatorMatching");

const visualInspection = { name: "Visual Inspection", requiredSkill: "Visual Inspection", managedBy: "Operator" };

test("includes an operator whose skill label differs slightly (split words)", () => {
  const op = { _id: "a", userType: "Operator", skills: ["Visual", "Inspection"] };
  assert.equal(operatorFitsStages(op, [visualInspection]), true);
});

test("rejects an operator without the required skill", () => {
  const op = { _id: "a", userType: "Operator", skills: ["Soldering"] };
  assert.equal(operatorFitsStages(op, [visualInspection]), false);
});

test("rejects a seat made only of reserved stages", () => {
  const op = { _id: "a", userType: "Operator", skills: ["Visual Inspection"] };
  assert.equal(operatorFitsStages(op, [{ ...visualInspection, reserved: true }]), false);
  assert.equal(operatorFitsStages(op, []), false);
});

test("must satisfy every stage on a multi-stage seat", () => {
  const op = { _id: "a", userType: "Operator", skills: ["Visual Inspection"] };
  const stages = [visualInspection, { name: "Functional", requiredSkill: "Functional", managedBy: "Operator" }];
  assert.equal(operatorFitsStages(op, stages), false);
  assert.equal(operatorFitsStages({ ...op, skills: ["Visual Inspection", "Functional"] }, stages), true);
});

test("role matching treats QC/quality, store and production alike", () => {
  assert.equal(roleMatches("QC", "Quality Control"), true);
  assert.equal(roleMatches("Store", "Store Manager"), true);
  assert.equal(roleMatches("Production Manager", "Production Executive"), true);
  assert.equal(roleMatches("QC", "Operator"), false);
  assert.equal(roleMatches("", "Operator"), true);
  assert.equal(roleMatches("Operator", ""), false);
});

test("skillMatches is permissive on an empty requirement and strict otherwise", () => {
  assert.equal(skillMatches("", ["anything"]), true);
  assert.equal(skillMatches("Functional", []), false);
  assert.equal(skillMatches("Visual Inspection", ["Soldering"]), false);
  // Parity with the UI matcher: containment counts, so a short label like "VI" matches
  // "Visual Inspection" (see the comment on operatorSkillMatchesStageRequirement in the frontend).
  assert.equal(skillMatches("Visual Inspection", ["VI"]), true);
});

test("enrichStages backfills requiredSkill and managedBy from the process definition", () => {
  const out = enrichStages([{ name: "Functional" }], [{ stageName: "Functional", requiredSkill: "Func Test", managedBy: "QC" }]);
  assert.equal(out[0].requiredSkill, "Func Test");
  assert.equal(out[0].managedBy, "QC");
  const kept = enrichStages([{ name: "Functional", requiredSkill: "Mine" }], [{ stageName: "Functional", requiredSkill: "Other" }]);
  assert.equal(kept[0].requiredSkill, "Mine");
});
