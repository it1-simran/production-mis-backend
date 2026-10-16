// Server port of the frontend matcher in production-mis/src/utils/planOperatorMatching.ts.
// Behaviour must stay identical; __tests__/planning/operatorMatching.test.js pins the same cases.

const normalizeToken = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");

const normalizeCompact = (value) => normalizeToken(value).replace(/\s+/g, "");

// Stage skill labels (e.g. "Visual Inspection") vs operator skills (e.g. "VI", "visual").
const skillMatches = (requiredSkill, operatorSkills) => {
  const required = normalizeToken(requiredSkill);
  const requiredCompact = normalizeCompact(requiredSkill);
  if (!required) return true;

  return operatorSkills.some((skill) => {
    const normalized = normalizeToken(skill);
    const compact = normalizeCompact(skill);
    if (!normalized) return false;
    if (normalized === required || compact === requiredCompact) return true;
    if (normalized.includes(required) || required.includes(normalized)) return true;
    if (compact.includes(requiredCompact) || requiredCompact.includes(compact)) return true;
    return false;
  });
};

const roleMatches = (managedBy, userType) => {
  const role = normalizeToken(managedBy);
  const type = normalizeToken(userType);
  if (!role) return true;
  if (!type) return false;
  if (role === type) return true;
  if (role.includes(type) || type.includes(role)) return true;
  if ((role === "qc" || role.includes("quality")) && (type === "qc" || type.includes("quality"))) return true;
  if (role.includes("store") && type.includes("store")) return true;
  if (role.includes("production") && type.includes("production")) return true;
  return false;
};

// Backfill a stage's requiredSkill / managedBy from the process definition when missing.
const enrichStages = (stages = [], processStages = []) =>
  (Array.isArray(stages) ? stages : []).map((stage) => {
    if (!stage || stage.reserved) return stage;
    const stageName = String(stage?.name || stage?.stageName || stage?.stage || "");
    const template = (Array.isArray(processStages) ? processStages : []).find(
      (row) =>
        normalizeCompact(row?.stageName) === normalizeCompact(stageName) ||
        normalizeToken(row?.stageName).includes(normalizeToken(stageName)) ||
        normalizeToken(stageName).includes(normalizeToken(row?.stageName)),
    );
    return {
      ...stage,
      requiredSkill: stage?.requiredSkill || template?.requiredSkill || "",
      managedBy: stage?.managedBy || template?.managedBy || "",
    };
  });

// Does `operator` satisfy EVERY non-reserved stage's skill and role requirement?
const operatorFitsStages = (operator, stages = []) => {
  const active = (Array.isArray(stages) ? stages : []).filter((s) => s && !s.reserved);
  if (!active.length) return false;
  const skills = (Array.isArray(operator?.skills) ? operator.skills : [])
    .map((s) => normalizeToken(s))
    .filter(Boolean);
  const userType = normalizeToken(operator?.userType);
  const requiredSkills = active.map((s) => normalizeToken(s?.requiredSkill)).filter(Boolean);
  const requiredRoles = active.map((s) => normalizeToken(s?.managedBy)).filter(Boolean);
  const hasSkills = requiredSkills.length === 0 || requiredSkills.every((skill) => skillMatches(skill, skills));
  const hasRole = requiredRoles.length === 0 || requiredRoles.every((role) => roleMatches(role, userType));
  return hasSkills && hasRole;
};

module.exports = { normalizeToken, normalizeCompact, skillMatches, roleMatches, enrichStages, operatorFitsStages };
