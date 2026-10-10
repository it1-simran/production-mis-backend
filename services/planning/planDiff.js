// What changes between a stored plan and an edited one, in plain words. PURE.
//
//   diffPlans(before, after, { beforeSchedule, afterSchedule, labelOf, names }) -> { changes, summary, counts, impact }
//
// `before` / `after` are planViews (storedView of the saved plan, storedView of the plan as it WOULD be saved).
// The two schedules are the per-day hours of each (planViews.scheduleOf). This feeds the "Review changes" screen
// and the change-log line, so the wording is for planners, not programmers.

const { toList, idOf } = require("./draft");
const { dayHours, stageNameOf } = require("./planViews");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_CHANGES = 200;

const prettyDay = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return String(key || "");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const hoursText = (entry) => {
  if (!entry || !entry.working) return "day off";
  const breaks = (entry.breaks || []).length;
  return `${entry.startTime} to ${entry.endTime}${breaks ? ` (${breaks} break${breaks === 1 ? "" : "s"})` : ""}`;
};

// people / jigs keyed by id, with a display name, from a seat-keyed map
const membersBySeat = (map) => {
  const out = new Map(); // id -> { name, seats:Set }
  Object.entries(map || {}).forEach(([seatKey, slot]) => {
    toList(slot).forEach((item) => {
      const id = idOf(item);
      if (!id) return;
      if (!out.has(id)) out.set(id, { name: item.name || id, seats: new Set() });
      out.get(id).seats.add(seatKey);
    });
  });
  return out;
};

const commonMembers = (common) => {
  const out = new Map();
  toList(common).forEach((slot, index) =>
    toList(slot).forEach((item) => {
      const id = idOf(item);
      if (id) out.set(id, { name: item.name || id, slot: index });
    }),
  );
  return out;
};

const diffPlans = (before, after, { beforeSchedule = [], afterSchedule = [], labelOf = (k) => `seat ${k}`, names = {} } = {}) => {
  const changes = [];
  const add = (kind, text, extra = {}) => changes.length < MAX_CHANGES && changes.push({ kind, text, ...extra });

  // ---- dates, mode, floor, shift
  if (before.mode !== after.mode) {
    add("mode", `Hours: ${before.mode === "custom" ? "custom day-wise schedule" : "a shift"} becomes ${after.mode === "custom" ? "a custom day-wise schedule" : "a shift"}.`, { before: before.mode, after: after.mode });
  }
  if (before.startKey !== after.startKey) add("startDate", `Start date: ${prettyDay(before.startKey)} becomes ${prettyDay(after.startKey)}.`, { before: before.startKey, after: after.startKey });
  if (before.endKey !== after.endKey) add("endDate", `End date: ${prettyDay(before.endKey)} becomes ${prettyDay(after.endKey)}.`, { before: before.endKey, after: after.endKey });
  if (before.roomId !== after.roomId) add("floor", `Floor: ${names.rooms?.[before.roomId] || before.roomId} becomes ${names.rooms?.[after.roomId] || after.roomId}.`, { before: before.roomId, after: after.roomId });
  if (before.mode === "shift" && after.mode === "shift" && before.shiftId !== after.shiftId) {
    add("shift", `Shift: ${names.shifts?.[before.shiftId] || before.shiftId || "none"} becomes ${names.shifts?.[after.shiftId] || after.shiftId || "none"}.`, { before: before.shiftId, after: after.shiftId });
  }

  // ---- hours, day by day
  const was = new Map(beforeSchedule.map((d) => [d.dayKey, d]));
  const now = new Map(afterSchedule.map((d) => [d.dayKey, d]));
  Array.from(new Set([...was.keys(), ...now.keys()]))
    .sort()
    .forEach((key) => {
      if (dayHours(was.get(key)) === dayHours(now.get(key))) return;
      add("hours", `${prettyDay(key)}: ${hoursText(was.get(key))} becomes ${hoursText(now.get(key))}.`, { dayKey: key, before: dayHours(was.get(key)), after: dayHours(now.get(key)) });
    });

  // ---- stages on seats
  const seatKeys = Array.from(new Set([...Object.keys(before.stages), ...Object.keys(after.stages)])).sort();
  const removed = [];
  const added = [];
  seatKeys.forEach((key) => {
    const a = stageNameOf(before.stages[key]);
    const b = stageNameOf(after.stages[key]);
    if (a === b) return;
    if (a && b) add("seat", `${labelOf(key)}: ${a} is replaced by ${b}.`, { seatKey: key, before: a, after: b });
    else if (a) removed.push({ key, stage: a });
    else added.push({ key, stage: b });
  });
  // a stage that disappears from one seat and appears on another is a move
  removed.forEach((r) => {
    const i = added.findIndex((x) => x.stage === r.stage);
    if (i >= 0) {
      const target = added.splice(i, 1)[0];
      add("seat", `${r.stage} moves from ${labelOf(r.key)} to ${labelOf(target.key)}.`, { seatKey: r.key, toSeatKey: target.key, before: r.stage, after: r.stage });
    } else {
      add("seat", `${r.stage} is removed from ${labelOf(r.key)}.`, { seatKey: r.key, before: r.stage });
    }
  });
  added.forEach((x) => add("seat", `${x.stage} is added to ${labelOf(x.key)}.`, { seatKey: x.key, after: x.stage }));

  // ---- operators and jigs
  const people = (kind, label, beforeMap, afterMap) => {
    const a = membersBySeat(beforeMap);
    const b = membersBySeat(afterMap);
    const gone = [];
    const came = [];
    a.forEach((info, id) => {
      const target = b.get(id);
      const lost = Array.from(info.seats).filter((s) => !target || !target.seats.has(s));
      if (lost.length) gone.push({ id, name: info.name, seats: lost, stays: !!target });
    });
    b.forEach((info, id) => {
      const source = a.get(id);
      const gained = Array.from(info.seats).filter((s) => !source || !source.seats.has(s));
      if (gained.length) came.push({ id, name: info.name, seats: gained, existed: !!source });
    });
    gone.forEach((g) => {
      const arrival = came.find((c) => c.id === g.id);
      if (arrival) add(kind, `${g.name} (${label}) moves from ${labelOf(g.seats[0])} to ${labelOf(arrival.seats[0])}.`, { id: g.id, seatKey: g.seats[0], toSeatKey: arrival.seats[0] });
      else add(kind, `${g.name} (${label}) is removed from ${labelOf(g.seats[0])}.`, { id: g.id, seatKey: g.seats[0] });
    });
    came.forEach((c) => {
      if (gone.some((g) => g.id === c.id)) return;
      add(kind, `${c.name} (${label}) is added to ${labelOf(c.seats[0])}.`, { id: c.id, seatKey: c.seats[0] });
    });
    return { before: a, after: b };
  };
  const ops = people("operator", "operator", before.operators, after.operators);
  const jigs = people("jig", "jig", before.jigs, after.jigs);

  const commonBefore = commonMembers(before.common);
  const commonAfter = commonMembers(after.common);
  commonBefore.forEach((info, id) => !commonAfter.has(id) && add("common", `${info.name} is removed from common stage ${info.slot + 1}.`, { id }));
  commonAfter.forEach((info, id) => !commonBefore.has(id) && add("common", `${info.name} is added to common stage ${info.slot + 1}.`, { id }));

  // ---- summary and impact
  const counts = {
    dates: changes.filter((c) => ["mode", "startDate", "endDate", "floor", "shift"].includes(c.kind)).length,
    hours: changes.filter((c) => c.kind === "hours").length,
    seats: changes.filter((c) => c.kind === "seat").length,
    people: changes.filter((c) => c.kind === "operator" || c.kind === "common").length,
    jigs: changes.filter((c) => c.kind === "jig").length,
  };
  const parts = [];
  if (counts.dates) parts.push(`${counts.dates} date or setting${counts.dates === 1 ? "" : "s"}`);
  if (counts.hours) parts.push(`${counts.hours} day${counts.hours === 1 ? "" : "s"}' hours`);
  if (counts.seats) parts.push(`${counts.seats} seat${counts.seats === 1 ? "" : "s"}`);
  if (counts.people) parts.push(`${counts.people} operator change${counts.people === 1 ? "" : "s"}`);
  if (counts.jigs) parts.push(`${counts.jigs} jig change${counts.jigs === 1 ? "" : "s"}`);
  const total = changes.length;
  const summary = total === 0 ? "No changes." : `${total} change${total === 1 ? "" : "s"}: ${parts.join(", ")}.`;

  const freed = (b, a) => Array.from(b.entries()).filter(([id]) => !a.has(id)).map(([id, info]) => ({ id, name: info.name }));
  const impact = {
    operatorsFreed: [...freed(ops.before, ops.after), ...freed(commonBefore, commonAfter)],
    jigsFreed: freed(jigs.before, jigs.after),
    seatsChanged: Array.from(new Set(changes.filter((c) => c.seatKey).flatMap((c) => [c.seatKey, c.toSeatKey].filter(Boolean)))),
  };

  return { changes, summary, counts, impact };
};

module.exports = { diffPlans, prettyDay };
