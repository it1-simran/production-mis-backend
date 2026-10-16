// Edit guards: protect work that has already happened when a plan that is in progress is edited. PURE.
//
//   evaluateEditGuard({ existing, draft, existingSchedule, draftSchedule, footprint, todayKey, labelOf })
//     -> [ { code, severity, message, seatKey?, dayKey? } ]
//
// `existing` / `draft` are planViews.storedView / draftView. `footprint` is planFootprint.buildFootprint
// (what has been recorded: output per seat and stage, kits per seat, open work sessions, status).
//
// One principle runs through every rule: they only fire for a CHANGE to something protected. A draft
// identical to the stored plan never raises any finding, however old or odd the stored plan is. (Test
// records can mention seats the plan has since left; those are not the editor's fault.)
//
// Codes (see PLANNING_EDIT_PAGE_PLAN.md):
//   EDIT-001 completed process, read-only        EDIT-006 past days / end date before the last activity
//   EDIT-002 stage with output removed or moved  EDIT-007 operator with an open session replaced or moved (warning)
//   EDIT-003 seat with kits issued changed       EDIT-008 today's hours changed while people are working (warning)
//   EDIT-004 floor changed after kits/production EDIT-009 operator changed on a seat with kits awaiting confirmation (warning)
//   EDIT-005 start date changed after production

const { normName } = require("./capacity");
const { dayHours, stageNameOf, operatorIdsOnSeat } = require("./planViews");

const issue = (code, severity, message, extra = {}) => ({ code, severity, message, ...extra });

const seatStage = (view, seatKey) => normName(stageNameOf(view.stages?.[seatKey]));

const evaluateEditGuard = ({ existing, draft, existingSchedule = [], draftSchedule = [], footprint, todayKey = "", labelOf = (key) => `seat ${key}` }) => {
  const out = [];
  if (!existing || !draft || !footprint) return out;

  // EDIT-001: nothing can change on a completed process
  if (footprint.processStatus === "completed") {
    out.push(issue("EDIT-001", "error", "This process is completed, so its plan can no longer be changed."));
    return out;
  }

  // EDIT-002: stages that already have output stay where they are
  const stagesWithSeatLevelError = new Set();
  footprint.outputBySeatStage.forEach((count, key) => {
    if (!(count > 0)) return;
    const [seatKey, stage] = key.split("|");
    if (seatStage(existing, seatKey) !== stage) return; // the plan no longer has it there: nothing to protect
    if (seatStage(draft, seatKey) !== stage) {
      stagesWithSeatLevelError.add(stage);
      out.push(
        issue("EDIT-002", "error", `${labelOf(seatKey)} already ran ${stageNameOf(existing.stages[seatKey])} (${count} device${count === 1 ? "" : "s"} recorded). That stage cannot be removed, replaced or moved off the seat.`, {
          seatKey,
        }),
      );
    }
  });
  footprint.stagesWithOutput.forEach((stage) => {
    if (stagesWithSeatLevelError.has(stage)) return;
    const had = Object.keys(existing.stages).some((k) => seatStage(existing, k) === stage);
    const has = Object.keys(draft.stages).some((k) => seatStage(draft, k) === stage);
    if (had && !has) out.push(issue("EDIT-002", "error", `The stage "${stage}" has recorded output and cannot be removed from the plan.`));
  });

  // EDIT-003: seats with kits issued
  footprint.kitSeats.forEach((info, seatKey) => {
    const before = seatStage(existing, seatKey);
    if (before && seatStage(draft, seatKey) !== before) {
      out.push(issue("EDIT-003", "error", `${labelOf(seatKey)} has ${info.issued} kit${info.issued === 1 ? "" : "s"} issued for ${stageNameOf(existing.stages[seatKey])}. Its stage cannot be changed or moved.`, { seatKey }));
    }
  });

  // EDIT-004 / EDIT-005: floor and start date
  if (existing.roomId && draft.roomId && existing.roomId !== draft.roomId && (footprint.kitsAssigned || footprint.started)) {
    out.push(issue("EDIT-004", "error", "The floor cannot be changed once kits are issued or production has started."));
  }
  if (footprint.started && existing.startKey && draft.startKey && existing.startKey !== draft.startKey) {
    out.push(issue("EDIT-005", "error", `The start date cannot be changed once production has started (it started on ${existing.startKey}).`));
  }

  // EDIT-006: days that have passed, and the end date
  // (needs a stored schedule to compare with: a plan without a readable range has no hours to protect)
  if (footprint.started && todayKey && existingSchedule.length > 0) {
    const was = new Map(existingSchedule.map((d) => [d.dayKey, d]));
    const now = new Map(draftSchedule.map((d) => [d.dayKey, d]));
    Array.from(was.keys())
      .filter((k) => k < todayKey)
      .sort()
      .forEach((k) => {
        if (dayHours(was.get(k)) !== dayHours(now.get(k))) {
          out.push(issue("EDIT-006", "error", `${k} has already passed. Its hours cannot be changed or removed (${dayHours(was.get(k)) || "day off"} became ${dayHours(now.get(k)) || "day off"}).`, { dayKey: k }));
        }
      });
    // a day that did not exist before and lies in the past would rewrite history as well
    Array.from(now.keys())
      .filter((k) => k < todayKey && !was.has(k) && dayHours(now.get(k)))
      .forEach((k) => out.push(issue("EDIT-006", "error", `${k} has already passed and cannot be added to the schedule.`, { dayKey: k })));
  }
  // only a plan whose end date is being moved EARLIER is a problem; a plan that already ran past its end date is left as it is
  if (footprint.lastActivityKey && draft.endKey && draft.endKey < footprint.lastActivityKey && (!existing.endKey || draft.endKey < existing.endKey)) {
    out.push(issue("EDIT-006", "error", `The plan cannot end on ${draft.endKey}: work was recorded as late as ${footprint.lastActivityKey}.`));
  }

  // EDIT-007: people who are working right now. Changing the operator of a seat is allowed (a warning): the replaced operator's open
  // session is not ended by the edit, it simply runs out when they stop.
  footprint.openSessionOperatorIds.forEach((id) => {
    const seatsBefore = Object.keys(existing.stages).filter((k) => operatorIdsOnSeat(existing, k).includes(id));
    if (seatsBefore.length === 0) return;
    const stillThere = seatsBefore.some((k) => operatorIdsOnSeat(draft, k).includes(id));
    if (!stillThere) {
      out.push(issue("EDIT-007", "warning", `An operator on ${labelOf(seatsBefore[0])} has a work session open and is being replaced or moved. Their session keeps running until they stop it.`, { seatKey: seatsBefore[0] }));
    }
  });

  // EDIT-008: today's hours while people are working (a warning: it is allowed)
  if (todayKey && footprint.openSessionOperatorIds.size > 0) {
    const before = dayHours(existingSchedule.find((d) => d.dayKey === todayKey));
    const after = dayHours(draftSchedule.find((d) => d.dayKey === todayKey));
    if (before !== after) {
      out.push(issue("EDIT-008", "warning", `Today's hours change from ${before || "day off"} to ${after || "day off"} while ${footprint.openSessionOperatorIds.size} operator${footprint.openSessionOperatorIds.size === 1 ? " is" : "s are"} working.`, { dayKey: todayKey }));
    }
  }

  // EDIT-009: kits waiting for the operator to confirm them (a warning)
  footprint.kitSeats.forEach((info, seatKey) => {
    if (!info.awaitingConfirmation) return;
    const before = operatorIdsOnSeat(existing, seatKey).sort().join(",");
    const after = operatorIdsOnSeat(draft, seatKey).sort().join(",");
    if (before !== after) {
      out.push(issue("EDIT-009", "warning", `Kits issued to ${labelOf(seatKey)} are waiting for the operator to confirm them, and the operator on that seat changes.`, { seatKey }));
    }
  });

  return out;
};

module.exports = { evaluateEditGuard };
