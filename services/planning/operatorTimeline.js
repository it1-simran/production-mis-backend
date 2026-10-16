// What each operator did across one day, read only: testing, breaks, logged idle (with the operator's reason) and unlogged idle, plus
// milestones (login, first device, last device, logout). PURE: everything is passed in (see loadOperatorTimeline in planOperatorTimeline.js).
//
// HOW THE DAY IS DRAWN. Times are milliseconds; every segment also carries its offset in minutes from the start of the plant day so a
// screen can draw it without a time zone. Four kinds of time, in priority order (an earlier kind wins where two overlap):
//   test         the operator's attempts (pass or NG). Overlapping attempts are merged, so time is never counted twice.
//   break        the plan's planned breaks and the breaks the operator took in their work session
//   logged idle  idle the operator explained (lunch, tea, material waiting, breakdown ...), as the idle log holds it
//   idle         time the operator was PRESENT with no test, no break and no logged reason; 30 minutes or more is "long idle"
// PRESENT means inside a work session, or testing. A day with no session at all is judged from the first test to the last (so the gaps
// between tests count, as they did on the monitoring page), and a gap under a minute is ignored.
//
// A session never counts for longer than `maxSessionMs` (the system closes a session after that long), so one that was left open, or
// closed days later, cannot stretch a day. An open session on a past day ends at the later of the last test and the end of the plan's
// hours; on today it ends now. Only the part of a session inside the day counts, and the day reaches to the next midnight (a night
// shift, a little into the morning): later work belongs to the next day.

const { buildWindow } = require("../../utils/planDates");
const { breakRanges, dayExtentMin } = require("./planHourly");

const svc = () => require("../planInsightsService");
const num = (n) => Number(n) || 0;
const idOf = (v) => String(v?._id || v || "");
const MIN = 60000;

// ---- intervals: [start, end] pairs in ms -------------------------------------------------------------------------------------

const union = (list) => {
  const sorted = list.filter(([a, b]) => b > a).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  sorted.forEach(([a, b]) => {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  });
  return out;
};
const length = (list) => list.reduce((s, [a, b]) => s + (b - a), 0);
const intersect = (a, b) => {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i += 1;
    else j += 1;
  }
  return out;
};
// a minus b (both already unions)
const subtract = (a, b) => {
  const out = [];
  a.forEach(([s, e]) => {
    let cur = s;
    b.forEach(([bs, be]) => {
      if (be <= cur || bs >= e) return;
      if (bs > cur) out.push([cur, bs]);
      cur = Math.max(cur, be);
    });
    if (cur < e) out.push([cur, e]);
  });
  return out.filter(([x, y]) => y > x);
};

// ---- one attempt as a time span ----------------------------------------------------------------------------------------------

const ms = (v) => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
};

// end = the recorded end (or when the record was written); start = the recorded start, unless it contradicts the timer by a factor of
// two or more (clocks and retries make that happen), then end minus the timer
const attemptSpan = (r) => {
  const end = Number.isFinite(ms(r.endTime)) ? ms(r.endTime) : ms(r.createdAt);
  if (!Number.isFinite(end)) return null;
  const duration = num(r.testDurationMs);
  let start = ms(r.startTime);
  if (duration > 0) {
    const span = end - start;
    if (!Number.isFinite(start) || span <= 0 || span < duration * 0.5 || span > duration * 2) start = end - duration;
  } else if (!Number.isFinite(start) || start > end) start = end;
  return [start, end];
};

// ---- the day ----------------------------------------------------------------------------------------------------------------------

/**
 * @param {number} o.dayStartMs   midnight of the day in plant time
 * @param {{startTime:string,endTime:string}} o.window  the plan's hours that day
 * @param {Array} o.breaks        planned breaks [{startTime,endTime}]
 * @param {Array} o.records       attempts: operatorId, serialNo, deviceId, stageName, status, startTime, endTime, testDurationMs, createdAt
 * @param {Array} o.sessions      work sessions: operatorId, startedAt, endedAt, status, breaks[{startedAt,endedAt,reason}]
 * @param {Array} o.idleLogs      idle logs: operatorId, idleStartTime, idleEndTime, reasonLabel, reasonCode, category, remarks, stageName
 * @param {Map}   o.names         operatorId -> { name, employeeCode }
 * @param {number|null} o.nowMs   set when the day is today
 */
const buildOperatorTimeline = ({ dayStartMs, window, breaks = [], records = [], sessions = [], idleLogs = [], names = new Map(), nowMs = null, maxSessionMs = 10 * 3600000, longIdleMs = 30 * MIN, minGapMs = MIN, stage = "", aliasLookup = null }) => {
  const { isPassStatus, isNgStatus, normalizeKey, resolveCanonicalStageName } = svc();
  const win = buildWindow(window?.startTime, window?.endTime);
  if (!win) return { ok: false, message: "The day has no usable hours." };
  const toMin = (t) => Math.round((t - dayStartMs) / MIN);
  const dayEnd = dayStartMs + dayExtentMin(win) * MIN;
  const windowMs = [dayStartMs + win.start * MIN, dayStartMs + win.end * MIN];
  const plannedBreaks = breakRanges(breaks, win.start - 60, win.end + 60).map(([a, b]) => [dayStartMs + a * MIN, dayStartMs + b * MIN]);

  const ops = new Map();
  const slot = (id) => {
    const key = id || "unknown";
    if (!ops.has(key)) ops.set(key, { id: key, attempts: [], sessions: [], idle: [], stages: new Set() });
    return ops.get(key);
  };

  records.forEach((r) => {
    const status = normalizeKey(r?.status);
    const pass = isPassStatus(status);
    const ng = isNgStatus(status);
    if (!pass && !ng) return;
    const span = attemptSpan(r);
    if (!span || span[1] < dayStartMs || span[1] >= dayEnd) return;
    const o = slot(idOf(r.operatorId));
    o.attempts.push({ span, pass, serial: r.serialNo || idOf(r.deviceId), device: idOf(r.deviceId) || r.serialNo });
    const raw = String(r?.stageName || r?.currentStage || "").trim();
    o.stages.add(aliasLookup ? resolveCanonicalStageName(raw, aliasLookup) : raw);
  });
  sessions.forEach((s) => {
    const start = ms(s.startedAt);
    if (!Number.isFinite(start) || start >= dayEnd) return;
    slot(idOf(s.operatorId)).sessions.push(s);
  });
  idleLogs.forEach((l) => {
    const start = ms(l.idleStartTime);
    const end = ms(l.idleEndTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end < dayStartMs || start >= dayEnd) return;
    slot(idOf(l.operatorId)).idle.push(l);
  });

  const stageKey = stage ? normalizeKey(aliasLookup ? resolveCanonicalStageName(stage, aliasLookup) : stage) : "";
  const operators = [];

  ops.forEach((o) => {
    if (stageKey && !Array.from(o.stages).some((s) => normalizeKey(s) === stageKey)) return;

    // testing
    const tests = union(o.attempts.map((a) => a.span));
    const firstTest = tests.length ? tests[0][0] : null;
    const lastTest = tests.length ? tests[tests.length - 1][1] : null;

    // sessions (an open one ends now, or, on a past day, after the last test / the plan's hours, but never beyond maxSessionMs)
    const sessionSpans = o.sessions.map((s) => {
      const start = ms(s.startedAt);
      const recordedEnd = ms(s.endedAt);
      let end = recordedEnd;
      if (!Number.isFinite(end)) {
        end = nowMs !== null ? nowMs : Math.max(lastTest || 0, windowMs[1]);
        end = Math.max(end, start);
      }
      // never longer than the system lets a session run; note when the recorded end was beyond that
      const capped = Math.min(end, start + maxSessionMs);
      const ranLong = Number.isFinite(recordedEnd) ? recordedEnd > start + maxSessionMs : nowMs === null; // closed too late, or left open on a past day
      return { s, span: [start, Math.max(capped, start)], ranLong };
    });
    const dayRange = [[dayStartMs, dayEnd]];
    const sessionUnion = intersect(union(sessionSpans.map((x) => x.span)), dayRange);

    // present = in a session, or testing; with no session at all, from the first test to the last
    const present = intersect(sessionUnion.length ? union([...sessionUnion, ...tests]) : tests.length ? [[firstTest, lastTest]] : [], dayRange);

    // breaks: the plan's planned breaks and the operator's own, inside the time they were present
    const ownBreaks = [];
    sessionSpans.forEach(({ s, span }) =>
      (s.breaks || []).forEach((b) => {
        const bs = ms(b.startedAt);
        if (!Number.isFinite(bs)) return;
        const be = Number.isFinite(ms(b.endedAt)) ? ms(b.endedAt) : span[1];
        if (be > bs) ownBreaks.push({ span: [bs, be], reason: b.reason || "" });
      })
    );
    const breakUnion = intersect(union([...plannedBreaks, ...ownBreaks.map((b) => b.span)]), present);
    const breakSegments = subtract(breakUnion, tests);

    // logged idle: tests win, then breaks
    const loggedAll = o.idle.flatMap((l) => intersect([[ms(l.idleStartTime), ms(l.idleEndTime)]], dayRange).map((span) => ({ l, span })));
    const loggedSegments = [];
    loggedAll.forEach(({ l, span }) => {
      subtract(subtract([span], tests), breakSegments).forEach((seg) => loggedSegments.push({ span: seg, l }));
    });
    const loggedUnion = union(loggedSegments.map((x) => x.span));

    // unlogged idle: present, not testing, not on a break, not explained
    const idleUnion = subtract(subtract(subtract(present, tests), breakSegments), loggedUnion).filter(([a, b]) => b - a >= minGapMs);
    const longIdle = idleUnion.filter(([a, b]) => b - a >= longIdleMs);
    const shortIdle = idleUnion.filter(([a, b]) => b - a < longIdleMs);

    const breakLogged = union(loggedSegments.filter((x) => (x.l.category || "DOWNTIME") === "BREAK").map((x) => x.span));
    const downtimeLogged = union(loggedSegments.filter((x) => (x.l.category || "DOWNTIME") !== "BREAK").map((x) => x.span));

    const segments = [];
    const push = (type, span, extra = {}) => segments.push({ type, start: new Date(span[0]).toISOString(), end: new Date(span[1]).toISOString(), startMin: toMin(span[0]), endMin: toMin(span[1]), durationMs: span[1] - span[0], ...extra });
    tests.forEach((span) => {
      const inside = o.attempts.filter((a) => a.span[1] > span[0] && a.span[0] < span[1]);
      push("test", span, { devices: new Set(inside.map((a) => a.device)).size, attempts: inside.length });
    });
    breakSegments.forEach((span) => push("break", span));
    loggedSegments.forEach(({ span, l }) => push("logged_idle", span, { reason: l.reasonLabel || l.reasonCode || "", category: l.category || "DOWNTIME", remarks: l.remarks || "" }));
    shortIdle.forEach((span) => push("idle", span));
    longIdle.forEach((span) => push("long_idle", span));
    segments.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

    const presentMs = length(present);
    const breakMs = length(breakSegments);
    const loggedBreakMs = length(breakLogged);
    const workingMs = Math.max(0, presentMs - breakMs - loggedBreakMs);
    const testMs = length(tests);

    // reasons, grouped
    const reasons = new Map();
    loggedSegments.forEach(({ span, l }) => {
      const label = l.reasonLabel || l.reasonCode || "Other";
      const cur = reasons.get(label) || { reason: label, category: l.category || "DOWNTIME", ms: 0, count: 0 };
      cur.ms += span[1] - span[0];
      cur.count += 1;
      reasons.set(label, cur);
    });

    const logins = sessionSpans.map((x) => x.span[0]);
    // a genuine logout is a recorded end within the session limit; anything else was closed by the system (or never)
    const logouts = sessionSpans.filter((x) => Number.isFinite(ms(x.s.endedAt)) && !x.ranLong).map((x) => ms(x.s.endedAt));
    const endedBySystem = sessionSpans.some((x) => x.ranLong);
    const stillOn = nowMs !== null && sessionSpans.some((x) => !Number.isFinite(ms(x.s.endedAt)));
    const nm = names.get(o.id) || { name: o.id === "unknown" ? "Not recorded" : "", employeeCode: "" };
    const devices = new Set(o.attempts.map((a) => a.device));
    const iso = (t) => (Number.isFinite(t) && t !== null ? new Date(t).toISOString() : null);

    operators.push({
      id: o.id === "unknown" ? "" : o.id,
      name: nm.name,
      employeeCode: nm.employeeCode,
      stages: Array.from(o.stages).filter(Boolean),
      segments,
      milestones: { login: logins.length ? iso(Math.min(...logins)) : null, firstDevice: iso(firstTest), lastDevice: iso(lastTest), logout: logouts.length && !stillOn ? iso(Math.max(...logouts)) : null, stillLoggedIn: stillOn, sessionEndedBySystem: endedBySystem },
      totals: {
        devices: devices.size,
        attempts: o.attempts.length,
        pass: o.attempts.filter((a) => a.pass).length,
        ng: o.attempts.filter((a) => !a.pass).length,
        testMs,
        presentMs,
        breakMs: breakMs + loggedBreakMs,
        loggedDowntimeMs: length(downtimeLogged),
        idleMs: length(shortIdle),
        longIdleMs: length(longIdle),
        utilisationPct: workingMs > 0 ? Math.round((testMs / workingMs) * 1000) / 10 : null,
      },
      reasons: Array.from(reasons.values()).sort((a, b) => b.ms - a.ms),
      sortKey: firstTest !== null ? firstTest : logins.length ? Math.min(...logins) : Infinity,
    });
  });

  operators.sort((a, b) => a.sortKey - b.sortKey);
  operators.forEach((o) => delete o.sortKey);

  // the drawing range: the plan's hours with an hour either side, widened to hold anything outside them
  const all = operators.flatMap((o) => o.segments);
  const axisStart = Math.min(win.start - 60, ...all.map((s) => s.startMin));
  const axisEnd = Math.max(win.end + 60, ...all.map((s) => s.endMin));
  return {
    ok: true,
    window: { startMin: win.start, endMin: win.end, startTime: window.startTime, endTime: window.endTime },
    plannedBreaks: plannedBreaks.map(([a, b]) => ({ startMin: toMin(a), endMin: toMin(b) })),
    axis: { startMin: Math.floor(axisStart / 60) * 60, endMin: Math.ceil(axisEnd / 60) * 60 },
    nowMin: nowMs === null ? null : toMin(nowMs),
    operators,
  };
};

module.exports = { buildOperatorTimeline, attemptSpan, union, subtract, intersect, length };
