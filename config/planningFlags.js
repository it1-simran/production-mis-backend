// Feature flags for the v2 Planning & Scheduling flow (/planing-v2/*).
// Read at call time (not import time) so tests and PM2 restarts both see current env.
// None of these affect the legacy planning endpoints.

const VALIDATOR_VERSION = "1.0.0";

const readEnum = (name, allowed, fallback) => {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  return allowed.includes(raw) ? raw : fallback;
};

// off     : validator is not run on create/update (the /validate preview still works)
// warn    : validator runs, issues are returned and recorded, nothing is blocked
// enforce : issues whose code is in PLAN_ENFORCED_CODES block the save (HTTP 422)
const getValidationMode = () => readEnum("PLAN_VALIDATION_MODE", ["off", "warn", "enforce"], "warn");

const getEnforcedCodes = () =>
  new Set(
    String(process.env.PLAN_ENFORCED_CODES || "")
      .split(",")
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean),
  );

// off     : deleting a plan is never blocked
// warn    : a delete that would be blocked is logged and still allowed
// enforce : deleting a plan whose process is past kit allocation returns 409
const getDeleteGuardMode = () => readEnum("PLAN_DELETE_GUARD", ["off", "warn", "enforce"], "warn");

// Longest single working day a custom schedule may contain before it is flagged (SCH-002 warning).
// A day of 24 hours or more is always an error.
const getMaxDayHours = () => {
  const n = Number(process.env.PLAN_MAX_DAY_HOURS);
  return Number.isFinite(n) && n > 0 && n < 24 ? n : 16;
};

// Custom day-wise schedules (scheduleMode "custom"). Off by default: while off, the v2 endpoints refuse to
// create or validate a custom schedule and the builder does not offer it. Existing custom plans (if any)
// are still read normally.
const getCustomScheduleEnabled = () => readEnum("PLAN_CUSTOM_SCHEDULE", ["off", "on"], "off") === "on";

// Protection of work already done when a PUBLISHED plan is edited (EDIT-* findings; see editGuard.js).
// off     : not evaluated
// warn    : findings are shown and logged but never block a save
// enforce : guard errors block the save (an administrator can override with a written reason)
// Default: enforce on development, warn on production (so the first weeks on live only report).
const getEditGuardMode = () => readEnum("PLAN_EDIT_GUARD", ["off", "warn", "enforce"], process.env.NODE_ENV === "production" ? "warn" : "enforce");

module.exports = {
  VALIDATOR_VERSION,
  getValidationMode,
  getEnforcedCodes,
  getDeleteGuardMode,
  getMaxDayHours,
  getCustomScheduleEnabled,
  getEditGuardMode,
};
