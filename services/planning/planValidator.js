// Pure plan validator for the v2 planner. No database access: everything it needs is passed in
// `ctx` (built by planLoader.js, or by hand in tests).
//
//   validatePlan(draft, ctx, { now }) -> { valid, summary, issues, computed }
//
// `draft` comes from draft.normalizeDraft(). `ctx` shape:
//   process      { _id, name, status, quantity, stages:[{stageName,upha,requiredSkill,managedBy,hasJigStepType}], commonStages:[...] }
//   room         { _id, floorName, lines:[{ seats:[...] }] }
//   shift        { _id, startTime, endTime, intervals, weekDays, totalBreakTime }
//   holidayKeys  Set<"YYYY-MM-DD">
//   existingPlan { isDrafted } | null           (the plan being edited)
//   otherPlans   [summarizePlan(...)]           non-draft plans overlapping the date range, any room
//   overrunPlans [summarizePlan(...)]           same room, ended before the start but process still live
//   samePlanForProcess  summarizePlan | null
//   users        Map<id, { _id, name, userType, skills, status }>
//   jigs         Map<id, { _id, name }>
//   operatorRows Map<userId, [{ processId, processName }]>   Occupied rows on OTHER processes
//   jigRows      Map<jigId,  [{ processId, processName }]>
//   truncated    boolean

const {
  dayKeyLocal,
  dayNumber,
  isWorkingDayKey,
  addWorkingDays,
  countWorkingDaysBetween,
  buildWindow,
  windowsOverlap,
  rangesOverlap,
  formatPlanDate,
} = require("../../utils/planDates");
const { computeCapacity, normName } = require("./capacity");
const { enrichStages, operatorFitsStages, normalizeToken } = require("./operatorMatching");
const { seatKeyParts, toList, idOf, stageEntriesOf } = require("./draft");
const { VALIDATOR_VERSION } = require("../../config/planningFlags");

const COMMON_STAGE_ROLES = [/operator/i, /^qc$/i, /quality\s*control/i, /store/i, /production\s*manager/i];

const { computeCustomPlan, publicDays } = require("./customPlan");
const { plansOverlap } = require("./planOverlap");

const mkIssue = (code, severity, message, extra = {}) => ({ code, severity, message, ...extra });

const describePlan = (p) => ({
  planId: p.id,
  processName: p.processName,
  startDate: p.startKey,
  endDate: p.endKey,
});

const seatLabel = (key, room) => {
  const { row, seat } = seatKeyParts(key);
  const line = room?.lines?.[row];
  const rowName = line?.rowName || `Line ${String(row + 1).padStart(2, "0")}`;
  return `${rowName} · Seat ${seat + 1}`;
};

// ---- derived values -------------------------------------------------------------------------

// `rangeOverride` ({ startKey, endKey }) pins the date range to what a stored plan actually
// occupies. The audit uses it so existing plans are judged on their saved dates, not on dates
// recomputed from today's capacity maths.
const computePlan = (draft, ctx, rangeOverride = null) => {
  // A custom day-wise schedule has its own computation (same result shape); shift plans are untouched.
  if (draft.scheduleMode === "custom") return computeCustomPlan(draft, ctx, rangeOverride);
  const capacity = computeCapacity({
    processStages: ctx.process?.stages,
    assignedStages: draft.assignedStages,
    shift: ctx.shift,
    quantity: ctx.process?.quantity,
  });

  const weekDays = ctx.shift?.weekDays;
  const holidayKeys = ctx.holidayKeys || new Set();
  const start = draft.startDate;

  // What capacity says: start + the working days the bottleneck stage needs.
  let capacityEnd = null;
  if (start && capacity.daysNeeded > 0) {
    capacityEnd = addWorkingDays(start, capacity.daysNeeded, { weekDays, holidayKeys });
  }

  // What the planner chose, if anything. It wins for the stored finish date and for the days the
  // plan occupies seats/people; the capacity estimate is kept alongside for comparison.
  const plannedEnd = start && draft.plannedEndDate ? draft.plannedEndDate : null;
  const plannedEndKey = plannedEnd ? dayKeyLocal(plannedEnd) : "";
  const plannedWorkingDays = plannedEnd ? countWorkingDaysBetween(start, plannedEnd, { weekDays, holidayKeys }) : 0;
  const plannedCapacityUnits = plannedEnd ? capacity.unitsPerDay * plannedWorkingDays : 0;
  const shortfallUnits =
    plannedEnd && capacity.unitsPerDay > 0 && capacity.quantity > 0
      ? Math.max(0, Math.round(capacity.quantity - plannedCapacityUnits))
      : 0;

  // The range the plan occupies is never shorter than its start day.
  const startKeyOwn = dayKeyLocal(start);
  const effectiveEnd = plannedEnd && plannedEndKey >= startKeyOwn ? plannedEnd : plannedEnd ? start : capacityEnd;

  const overrideWindow = draft.shiftOverride ? buildWindow(draft.shiftOverride.startTime, draft.shiftOverride.endTime) : null;
  const window = overrideWindow || buildWindow(ctx.shift?.startTime, ctx.shift?.endTime);
  const startKey = rangeOverride?.startKey || startKeyOwn;
  const endKey = rangeOverride?.endKey || dayKeyLocal(effectiveEnd || start);

  return {
    capacity,
    // `endDate` / `estimatedEndDate` are the EFFECTIVE finish (planned if set, else capacity). They are
    // what gets stored and what conflicts are judged on.
    endDate: effectiveEnd,
    estimatedEndDate: effectiveEnd ? formatPlanDate(effectiveEnd) : "",
    capacityEndDate: capacityEnd,
    capacityEndDateText: capacityEnd ? formatPlanDate(capacityEnd) : "",
    capacityEndKey: capacityEnd ? dayKeyLocal(capacityEnd) : "",
    plannedEnd,
    plannedEndKey,
    plannedWorkingDays,
    plannedCapacityUnits,
    shortfallUnits,
    startKey,
    endKey,
    startDay: dayNumber(startKey),
    endDay: dayNumber(endKey),
    window,
    overrideWindow,
    unitsPerDay: capacity.unitsPerDay,
    totalUPHA: capacity.unitsPerDay > 0 ? capacity.unitsPerDay.toFixed(2) : "0.00",
    totalTimeEstimation: capacity.daysNeeded > 0 ? capacity.daysNeeded.toFixed(2) : "0.00",
  };
};

// Every seat held by another plan that overlaps this draft's days AND shift window.
// kind "conflict": date ranges overlap. kind "overrun": the plan is past its end date but its
// process is still live, so it keeps the seat until completed (matches the legacy availability view).
const collectSeatReservations = (draftRoomId, computed, ctx) => {
  const out = [];
  const consider = (plan, kind) => {
    if (plan.roomId !== String(draftRoomId)) return;
    // an "overrun" plan already ended but keeps its seats, so only the time of day matters for it
    if (!plansOverlap(computed, plan, { ignoreRange: kind === "overrun" })) return;
    plan.seatStage.forEach((stageName, seatKey) => out.push({ seatKey, plan, kind, stageName }));
  };
  (ctx.otherPlans || []).forEach((p) => consider(p, "conflict"));
  (ctx.overrunPlans || []).forEach((p) => consider(p, "overrun"));
  return out;
};

// ---- rule groups ----------------------------------------------------------------------------

const structureRules = (draft, ctx, computed) => {
  const issues = [];
  const isPublish = draft.mode === "publish";

  if (!ctx.process) issues.push(mkIssue("STRUCT-002", "error", "The selected process was not found.", { field: "selectedProcess" }));
  if (!ctx.room) issues.push(mkIssue("STRUCT-002", "error", "The selected floor/room was not found.", { field: "selectedRoom" }));
  // a custom schedule only has an OPTIONAL template shift, so a missing shift is not an error there
  if (!ctx.shift && draft.scheduleMode !== "custom") issues.push(mkIssue("STRUCT-002", "error", "The selected shift was not found.", { field: "selectedShift" }));
  if (!draft.startDate) issues.push(mkIssue("CAL-004", "error", "Start date is missing or not a valid date.", { field: "startDate" }));

  if (ctx.process) {
    const status = ctx.process.status;
    const editingPublished = ctx.existingPlan && Number(ctx.existingPlan.isDrafted) !== 1;
    if (status === "completed") {
      issues.push(mkIssue("STRUCT-002", "error", "This process is completed and can no longer be planned.", { field: "selectedProcess" }));
    } else if (!editingPublished && status !== "waiting_schedule") {
      issues.push(
        mkIssue("STRUCT-002", "error", `This process is not waiting for a schedule (status: ${status || "unknown"}).`, {
          field: "selectedProcess",
        }),
      );
    }
  }

  const seatEntries = Object.entries(draft.assignedStages || {}).filter(([, v]) => toList(v).some((e) => e && !e.reserved));
  if (seatEntries.length === 0) {
    issues.push(
      mkIssue("STRUCT-001", isPublish ? "error" : "info", "No stages have been placed on any seat yet.", { field: "assignedStages" }),
    );
  }

  const processStages = ctx.process?.stages || [];
  const stageByName = new Map(processStages.map((s) => [normName(s.stageName), s]));

  seatEntries.forEach(([seatKey, raw]) => {
    const parts = seatKeyParts(seatKey);
    if (ctx.room) {
      const exists = parts.valid && ctx.room.lines?.[parts.row]?.seats?.[parts.seat] !== undefined;
      if (!exists) {
        issues.push(
          mkIssue("STRUCT-003", "error", `Seat ${seatKey} does not exist in the selected room.`, {
            seatKey,
            resource: { type: "seat", id: seatKey },
          }),
        );
        return;
      }
    }

    const entries = stageEntriesOf(draft.assignedStages, seatKey);
    if (entries.length > 1) {
      issues.push(
        mkIssue("STRUCT-007", "info", `${seatLabel(seatKey, ctx.room)} holds ${entries.length} stages.`, {
          seatKey,
          resource: { type: "seat", id: seatKey },
        }),
      );
    }

    entries.forEach((entry) => {
      const name = String(entry.stageName || entry.name || entry.stage || "");
      const def = stageByName.get(normName(name));
      if (!def) {
        if (ctx.process) {
          issues.push(
            mkIssue("STRUCT-004", "error", `Stage "${name}" on ${seatLabel(seatKey, ctx.room)} is not part of this process.`, {
              seatKey,
              resource: { type: "stage", name },
            }),
          );
        }
        return;
      }
      const claimedUpha = Number(entry.upha);
      if (Number.isFinite(claimedUpha) && entry.upha !== "" && claimedUpha !== Number(def.upha)) {
        issues.push(
          mkIssue("STRUCT-004", "warning", `Stage "${name}" UPHA (${entry.upha}) differs from the process definition (${def.upha}).`, {
            seatKey,
            resource: { type: "stage", name },
          }),
        );
      }
    });
  });

  if (ctx.process && seatEntries.length > 0) {
    computed.capacity.stagesWithoutSeats.forEach((name) => {
      issues.push(
        mkIssue("STRUCT-005", isPublish ? "error" : "warning", `Stage "${name}" has no seat.`, { resource: { type: "stage", name } }),
      );
    });
  }
  return issues;
};

const processRules = (draft, ctx) => {
  const issues = [];
  if (ctx.samePlanForProcess) {
    issues.push(
      mkIssue("PROC-001", "warning", "Another published plan already exists for this process.", {
        resource: { type: "process", id: draft.selectedProcess },
        conflictsWith: describePlan(ctx.samePlanForProcess),
      }),
    );
  }
  return issues;
};

const calendarRules = (draft, ctx, computed, now) => {
  const issues = [];
  if (computed.custom) {
    // weekly days off, holidays and the end date are judged by the SCH-* checks instead
    if (draft.startDate && !ctx.existingPlan && dayKeyLocal(draft.startDate) < dayKeyLocal(now)) {
      issues.push(mkIssue("CAL-003", "info", `Start date ${dayKeyLocal(draft.startDate)} is in the past.`, { field: "startDate" }));
    }
    return issues;
  }
  if (draft.startDate && ctx.shift) {
    const key = dayKeyLocal(draft.startDate);
    if (!isWorkingDayKey(key, ctx.shift.weekDays, ctx.holidayKeys)) {
      issues.push(mkIssue("CAL-001", "warning", `Start date ${key} is a holiday or a day off for this shift.`, { field: "startDate" }));
    }
    if (!ctx.existingPlan && key < dayKeyLocal(now)) {
      issues.push(mkIssue("CAL-003", "info", `Start date ${key} is in the past.`, { field: "startDate" }));
    }
  }
  if (draft.startDate && computed.capacity.daysNeeded > 0 && !computed.capacityEndDate) {
    issues.push(mkIssue("CAL-004", "error", "No working day could be found to finish the plan within ten years.", { field: "startDate" }));
  }
  return issues;
};

// Rules for a finish date the planner chose themselves (compared against the capacity estimate).
const plannedEndRules = (draft, ctx, computed) => {
  const issues = [];
  if (computed.custom) return issues; // the day-by-day shortfall (DAY-002) replaces these
  if (!draft.plannedEndDate || !draft.startDate) return issues;
  const days = computed.plannedWorkingDays;
  const needed = computed.capacity.daysNeeded;

  if (computed.plannedEndKey < dayKeyLocal(draft.startDate)) {
    issues.push(mkIssue("CAL-005", "error", "The planned end date is before the start date.", { field: "plannedEndDate" }));
    return issues;
  }
  if (ctx.shift && !isWorkingDayKey(computed.plannedEndKey, ctx.shift.weekDays, ctx.holidayKeys)) {
    issues.push(mkIssue("CAL-007", "warning", `The planned end date ${computed.plannedEndKey} is a holiday or a day off for this shift.`, { field: "plannedEndDate" }));
  }
  if (computed.shortfallUnits > 0) {
    issues.push(
      mkIssue(
        "CAP-004",
        "warning",
        `The planned end date allows ${days} working day${days === 1 ? "" : "s"} but the current seats need ${needed.toFixed(2)}. About ${computed.shortfallUnits.toLocaleString("en-US")} unit${computed.shortfallUnits === 1 ? "" : "s"} would be left unbuilt. Add seats to the slowest stage or move the end date.`,
        { field: "plannedEndDate", resource: { type: "capacity" } },
      ),
    );
  } else if (needed > 0 && days - Math.ceil(needed) >= 1) {
    const buffer = days - Math.ceil(needed);
    issues.push(mkIssue("CAL-006", "info", `The planned end date leaves ${buffer} spare working day${buffer === 1 ? "" : "s"} beyond the capacity estimate.`, { field: "plannedEndDate" }));
  }
  return issues;
};

const shiftRules = (draft, ctx, computed) => {
  const issues = [];
  if (computed.custom) return issues; // there is no single shift to judge
  if (draft.shiftOverride && !computed.overrideWindow) {
    issues.push(mkIssue("SHIFT-001", "error", "The shift override times are not valid HH:mm values.", { field: "ProcessShiftMappings" }));
  }
  if (ctx.shift && computed.capacity.productiveMinutesPerDay <= 0) {
    issues.push(mkIssue("SHIFT-002", "error", "The selected shift has no productive time (all intervals are breaks or empty).", { field: "selectedShift" }));
  }
  return issues;
};

const capacityRules = (draft, ctx, computed) => {
  const issues = [];
  if (!ctx.process) return issues;
  const qty = computed.capacity.quantity;
  if (!(qty > 0)) {
    issues.push(mkIssue("CAP-001", "error", "The process quantity is missing or not a positive number.", { field: "selectedProcess" }));
  }
  const hasUpha = (ctx.process.stages || []).some((s) => Number(s.upha) > 0);
  if (!hasUpha) {
    issues.push(mkIssue("CAP-002", "error", "None of the process stages has a positive UPHA.", { field: "selectedProcess" }));
  }
  if (computed.capacity.daysNeeded > 365) {
    issues.push(
      mkIssue("CAP-003", "warning", `At this capacity the plan needs ${Math.ceil(computed.capacity.daysNeeded)} working days.`, {
        resource: { type: "capacity" },
      }),
    );
  }
  return issues;
};

const seatRules = (draft, ctx, computed) => {
  const issues = [];
  const draftSeats = new Set(
    Object.entries(draft.assignedStages || {})
      .filter(([, v]) => toList(v).some((e) => e && !e.reserved))
      .map(([k]) => k),
  );
  const seen = new Set();
  collectSeatReservations(draft.selectedRoom, computed, ctx).forEach(({ seatKey, plan, kind, stageName }) => {
    if (!draftSeats.has(seatKey)) return;
    const dedupe = `${kind}|${seatKey}|${plan.id}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    if (kind === "conflict") {
      issues.push(
        mkIssue(
          "SEAT-001",
          "error",
          `${seatLabel(seatKey, ctx.room)} is already planned for ${plan.processName || "another process"} (${plan.startKey} to ${plan.endKey}) on an overlapping shift.`,
          { seatKey, resource: { type: "seat", id: seatKey, name: seatLabel(seatKey, ctx.room) }, conflictsWith: { ...describePlan(plan), stageName } },
        ),
      );
    } else {
      issues.push(
        mkIssue(
          "SEAT-002",
          "warning",
          `${seatLabel(seatKey, ctx.room)} is still held by ${plan.processName || "another process"}, which is past its end date (${plan.endKey}) but not completed.`,
          { seatKey, resource: { type: "seat", id: seatKey, name: seatLabel(seatKey, ctx.room) }, conflictsWith: { ...describePlan(plan), stageName } },
        ),
      );
    }
  });
  return issues;
};

const overlappingPlansFor = (computed, ctx) =>
  (ctx.otherPlans || []).filter((p) => plansOverlap(computed, p));

const operatorRules = (draft, ctx, computed) => {
  const issues = [];
  const users = ctx.users || new Map();
  const overlapping = overlappingPlansFor(computed, ctx);
  const seatsOfOperator = new Map(); // id -> [seatKey]

  Object.entries(draft.assignedOperators || {}).forEach(([seatKey, slot]) => {
    toList(slot).forEach((op) => {
      const id = idOf(op);
      if (!id) return;
      if (!seatsOfOperator.has(id)) seatsOfOperator.set(id, []);
      seatsOfOperator.get(id).push(seatKey);
    });
  });

  const reportedConflict = new Set();
  const takeOver = new Set(draft.takeOverOperatorIds || []); // chosen from another process on purpose: saving moves them here
  const allIds = new Set(seatsOfOperator.keys());
  (draft.assignedCustomStagesOp || []).forEach((slot) => toList(slot).forEach((op) => idOf(op) && allIds.add(idOf(op))));

  allIds.forEach((id) => {
    const user = users.get(id);
    const label = user?.name || id;
    if (!user) {
      issues.push(mkIssue("OPER-003", "error", `Operator ${label} was not found.`, { resource: { type: "operator", id } }));
      return;
    }
    if (user.status && user.status !== "Active") {
      issues.push(mkIssue("OPER-003", "error", `${label} is ${String(user.status).toLowerCase()} and cannot be scheduled.`, { resource: { type: "operator", id, name: label } }));
    }
    overlapping.forEach((plan) => {
      if (plan.operatorIds.has(id)) {
        reportedConflict.add(id);
        issues.push(
          mkIssue("OPER-001", takeOver.has(id) ? "warning" : "error", takeOver.has(id) ? `${label} is planned on ${plan.processName || "another process"} (${plan.startKey} to ${plan.endKey}); saving moves them here and removes them from there.` : `${label} is already planned on ${plan.processName || "another process"} (${plan.startKey} to ${plan.endKey}) on an overlapping shift.`, {
            resource: { type: "operator", id, name: label },
            conflictsWith: describePlan(plan),
          }),
        );
      }
    });
    if (!reportedConflict.has(id)) {
      const rows = (ctx.operatorRows && ctx.operatorRows.get(id)) || [];
      if (rows.length) {
        issues.push(
          mkIssue("OPER-002", "warning", `${label} still has an active assignment on ${rows[0].processName || "another process"} that no plan accounts for.`, {
            resource: { type: "operator", id, name: label },
            conflictsWith: { processName: rows[0].processName, processId: rows[0].processId },
          }),
        );
      }
    }
  });

  seatsOfOperator.forEach((seatKeys, id) => {
    if (seatKeys.length > 1) {
      const label = users.get(id)?.name || id;
      issues.push(
        mkIssue("OPER-005", "error", `${label} is placed on ${seatKeys.length} seats in this plan.`, {
          resource: { type: "operator", id, name: label },
          seatKey: seatKeys[0],
        }),
      );
    }
  });

  Object.entries(draft.assignedOperators || {}).forEach(([seatKey, slot]) => {
    const stages = enrichStages(stageEntriesOf(draft.assignedStages, seatKey), ctx.process?.stages || []);
    toList(slot).forEach((op) => {
      const user = users.get(idOf(op));
      if (!user || stages.length === 0) return;
      if (!operatorFitsStages(user, stages)) {
        issues.push(
          mkIssue("OPER-004", "warning", `${user.name} does not match the skill or role required for ${stages.map((s) => s.name || s.stageName).join(", ")}.`, {
            seatKey,
            resource: { type: "operator", id: idOf(op), name: user.name },
          }),
        );
      }
    });
  });

  (draft.assignedCustomStagesOp || []).forEach((slot) => {
    toList(slot).forEach((op) => {
      const user = users.get(idOf(op));
      if (user && !COMMON_STAGE_ROLES.some((re) => re.test(String(user.userType || "")))) {
        issues.push(
          mkIssue("OPER-006", "warning", `${user.name} (${user.userType || "no role"}) is not an eligible role for a common-service stage.`, {
            resource: { type: "operator", id: idOf(op), name: user.name },
          }),
        );
      }
    });
  });
  return issues;
};

const jigRules = (draft, ctx, computed) => {
  const issues = [];
  const jigs = ctx.jigs || new Map();
  const overlapping = overlappingPlansFor(computed, ctx);
  const processStages = ctx.process?.stages || [];
  const jigStageNames = new Set(processStages.filter((s) => s.hasJigStepType).map((s) => normName(s.stageName)));

  const reported = new Set();
  Object.entries(draft.assignedJigs || {}).forEach(([seatKey, slot]) => {
    toList(slot).forEach((jig) => {
      const id = idOf(jig);
      if (!id) return;
      const known = jigs.get(id);
      if (!known) {
        issues.push(mkIssue("JIG-002", "error", `Jig ${id} was not found.`, { seatKey, resource: { type: "jig", id } }));
        return;
      }
      overlapping.forEach((plan) => {
        if (plan.jigIds.has(id)) {
          reported.add(id);
          issues.push(
            mkIssue("JIG-001", "error", `Jig ${known.name} is already planned on ${plan.processName || "another process"} (${plan.startKey} to ${plan.endKey}) on an overlapping shift.`, {
              seatKey,
              resource: { type: "jig", id, name: known.name },
              conflictsWith: describePlan(plan),
            }),
          );
        }
      });
      if (!reported.has(id)) {
        const rows = (ctx.jigRows && ctx.jigRows.get(id)) || [];
        if (rows.length) {
          issues.push(
            mkIssue("JIG-005", "warning", `Jig ${known.name} still has an active assignment on ${rows[0].processName || "another process"} that no plan accounts for.`, {
              seatKey,
              resource: { type: "jig", id, name: known.name },
              conflictsWith: { processName: rows[0].processName, processId: rows[0].processId },
            }),
          );
        }
      }
    });
  });

  Object.entries(draft.assignedStages || {}).forEach(([seatKey]) => {
    const needsJig = stageEntriesOf(draft.assignedStages, seatKey).some((e) => jigStageNames.has(normName(e.stageName || e.name)));
    if (needsJig && toList(draft.assignedJigs?.[seatKey]).length === 0) {
      issues.push(
        mkIssue("JIG-003", "warning", `${seatLabel(seatKey, ctx.room)} runs a jig stage but has no jig assigned.`, {
          seatKey,
          resource: { type: "seat", id: seatKey },
        }),
      );
    }
  });
  return issues;
};

// Findings about the custom schedule itself (SCH-*), and the per-day capacity findings (DAY-*).
const scheduleRules = (draft, ctx, computed) => (computed.custom ? computed.scheduleProblems.map((p) => ({ ...p })) : []);

// ---- entry point ----------------------------------------------------------------------------

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

const validatePlan = (draft, ctx, { now = new Date(), rangeOverride = null } = {}) => {
  const computed = computePlan(draft, ctx, rangeOverride);
  const issues = [
    ...structureRules(draft, ctx, computed),
    ...processRules(draft, ctx),
    ...calendarRules(draft, ctx, computed, now),
    ...plannedEndRules(draft, ctx, computed),
    ...shiftRules(draft, ctx, computed),
    ...scheduleRules(draft, ctx, computed),
    ...capacityRules(draft, ctx, computed),
    ...seatRules(draft, ctx, computed),
    ...operatorRules(draft, ctx, computed),
    ...jigRules(draft, ctx, computed),
  ];
  if (ctx.truncated) {
    issues.push(mkIssue("LOADER-001", "info", "The conflict search hit its row limit, so some conflicts may not be shown."));
  }
  if (computed.custom) {
    // the structure rules and the schedule checks can both report the same thing (for example a missing start date)
    const seen = new Set();
    for (let i = issues.length - 1; i >= 0; i -= 1) {
      const key = [issues[i].code, issues[i].message, issues[i].seatKey || "", issues[i].dayKey || ""].join("|");
      if (seen.has(key)) issues.splice(i, 1);
      else seen.add(key);
    }
  }
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const summary = {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };

  return {
    valid: summary.errors === 0,
    validatorVersion: VALIDATOR_VERSION,
    summary,
    issues,
    computed: {
      productiveMinutesPerDay: computed.capacity.productiveMinutesPerDay,
      bottleneck: computed.capacity.bottleneck,
      perStage: computed.capacity.perStage,
      unitsPerDay: Number(computed.unitsPerDay.toFixed(2)),
      daysNeeded: Number(computed.capacity.daysNeeded.toFixed(2)),
      totalUPHA: computed.totalUPHA,
      totalTimeEstimation: computed.totalTimeEstimation,
      // Effective finish (what is stored / what conflicts use): planned if the user set one.
      estimatedEndDate: computed.estimatedEndDate,
      startKey: computed.startKey,
      endKey: computed.endKey,
      // The comparison: what capacity alone says, and what the planner chose.
      capacityEndDate: computed.capacityEndDateText,
      capacityEndKey: computed.capacityEndKey,
      plannedEndKey: computed.plannedEndKey || null,
      plannedWorkingDays: computed.plannedEnd ? computed.plannedWorkingDays : null,
      plannedCapacityUnits: computed.plannedEnd ? Math.round(computed.plannedCapacityUnits) : null,
      shortfallUnits: computed.plannedEnd ? computed.shortfallUnits : null,
      // custom day-wise schedule: what each scheduled day makes (absent for shift plans)
      ...(computed.custom ? { scheduleMode: "custom", days: publicDays(computed), forecastEndKey: computed.capacityEndKey || null, shortfallUnits: computed.shortfallUnits } : {}),
    },
    // Internal: lets the controller reuse the computation without recomputing.
    _computed: computed,
  };
};

module.exports = {
  validatePlan,
  computePlan,
  collectSeatReservations,
  normalizeToken,
};
