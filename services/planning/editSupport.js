// Glue between the pure edit-guard pieces and real data: used by the v2 controller (review, update, getPlan)
// and by the read-only check script. Reads only; never writes.

const mongoose = require("mongoose");
const ShiftModel = require("../../models/shiftManagement");
const { dayKeyLocal } = require("../../utils/planDates");
const { getEditGuardMode } = require("../../config/planningFlags");
const { seatKeyParts } = require("./draft");
const { storedView, draftView, scheduleOf } = require("./planViews");
const { evaluateEditGuard } = require("./editGuard");
const { loadFootprint } = require("./planFootprint");

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

// "Line 01 · Seat 2" for a seat key, using the floor's own line names
const seatLabelFor = (room) => (key) => {
  const { row, seat, valid } = seatKeyParts(key);
  if (!valid) return `seat ${key}`;
  const line = room?.lines?.[row];
  const rowName = line?.rowName || `Line ${String(row + 1).padStart(2, "0")}`;
  return `${rowName} · Seat ${seat + 1}`;
};

// The shift the STORED plan runs on (the edited draft may have picked another).
const resolveExistingShift = async (existing, ctx) => {
  if (!existing || !isObjectId(existing.selectedShift)) return null;
  if (String(existing.selectedShift) === String(ctx.shift?._id || "")) return ctx.shift;
  return ShiftModel.findById(existing.selectedShift).lean();
};

// The edit-guard findings for turning `existing` (the stored plan) into `draft`. A draft or a plan that is not
// published has no activity to protect, so it returns nothing.
const runEditGuard = async ({ existing, draft, ctx, result, now = new Date() }) => {
  const mode = getEditGuardMode();
  if (mode === "off" || !existing || Number(existing.isDrafted) === 1) return { mode, issues: [], footprint: null };

  const footprint = await loadFootprint(existing);
  const before = storedView(existing);
  const after = draftView(draft, result._computed);
  const holidayKeys = ctx.holidayKeys || new Set();
  const existingShift = await resolveExistingShift(existing, ctx);

  const issues = evaluateEditGuard({
    existing: before,
    draft: after,
    existingSchedule: scheduleOf(before, { shift: existingShift, holidayKeys }),
    draftSchedule: scheduleOf(after, { shift: ctx.shift, holidayKeys }),
    footprint,
    todayKey: dayKeyLocal(now),
    labelOf: seatLabelFor(ctx.room),
  });
  return { mode, issues, footprint, existingShift };
};

// Adds guard findings to a validation result, keeping its ordering and counts consistent.
const mergeGuardIntoResult = (result, guardIssues) => {
  if (!guardIssues.length) return result;
  result.issues.push(...guardIssues);
  result.issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  result.summary = {
    errors: result.issues.filter((i) => i.severity === "error").length,
    warnings: result.issues.filter((i) => i.severity === "warning").length,
    info: result.issues.filter((i) => i.severity === "info").length,
  };
  result.valid = result.summary.errors === 0;
  return result;
};

// What actually stops the save: in enforce mode every guard error; in warn mode nothing (it is only shown).
const guardBlocking = (mode, issues) => (mode === "enforce" ? issues.filter((i) => i.severity === "error") : []);

module.exports = { runEditGuard, mergeGuardIntoResult, guardBlocking, seatLabelFor, resolveExistingShift };
