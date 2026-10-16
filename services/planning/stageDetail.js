// One stage of a plan, read only: summary, device buckets (pass / NG / resolved / WIP) and the attempt history. PURE: the records and
// devices are passed in (see planStageDetail.js for the loader), nothing is read or written here.
//
// RULES are the live engine's (planInsightsService.computePlanInsights), applied to the same process-wide scan:
//   * a device's result AT A STAGE is its latest record at that stage (so a retry replaces the earlier attempt);
//   * pass = pass|completed, NG = ng|fail|qc|trc|rework, "resolved" records send the device back to a stage as WIP;
//   * an NG at the very stage a device was resolved back to is not counted;
//   * records from an older flow version of a device are ignored;
//   * WIP at a stage = resolved back to it + passed the previous stage and not yet tested here + untested devices that sit at it,
//     the untested ones limited to the kits on the line (the engine's capacity rule).
// What the engine ALSO adds, and a device list cannot show, is reported as `unlisted` (units counted from kits that have no device record).

const svc = () => require("../planInsightsService");

const MAX_PAGE = 200;

const num = (n) => Number(n) || 0;
const round1 = (n) => Math.round(n * 10) / 10;
const idOf = (v) => String(v?._id || v || "");

const deviceKeyOf = (r) => String(r?.deviceId?._id || r?.deviceId || r?.serialNo || "").trim();

// ---- preparing records -------------------------------------------------------------------------------------------------

// records: newest first (as the engine scans them). Adds the fields the rules below need.
const prepare = (records, aliasLookup) => {
  const { normalizeKey, resolveCanonicalStageName, toPlanningDateKey } = svc();
  return (records || []).map((r) => {
    const stageRaw = String(r?.stageName || r?.currentStage || "").trim();
    return {
      r,
      dev: deviceKeyOf(r),
      stageRaw,
      stageKey: normalizeKey(stageRaw),
      stage: resolveCanonicalStageName(stageRaw, aliasLookup),
      status: normalizeKey(r?.status),
      at: r?.createdAt ? new Date(r.createdAt).getTime() : 0,
      day: r?.createdAt ? toPlanningDateKey(r.createdAt) : "",
    };
  });
};

const inRange = (p, from, to) => (!from || p.day >= from) && (!to || p.day <= to);

const durationOf = (r) => {
  const d = num(r?.testDurationMs);
  if (d > 0) return d;
  const s = r?.startTime ? new Date(r.startTime).getTime() : 0;
  const e = r?.endTime ? new Date(r.endTime).getTime() : 0;
  return s && e && e > s ? e - s : 0;
};

const flowStale = (p, flowByDevice) => {
  if (!p.dev) return false;
  const current = flowByDevice.get(p.dev);
  return current !== undefined && num(p.r?.flowVersion || 1) !== current;
};

// device key (id or serial) -> current flow version, from the device documents
const flowMap = (devices) => {
  const map = new Map();
  (devices || []).forEach((d) => {
    const v = num(d?.flowVersion || 1);
    if (d?._id) map.set(String(d._id), v);
    if (d?.serialNo) map.set(String(d.serialNo).trim(), v);
  });
  return map;
};

// ---- a stage's final results ------------------------------------------------------------------------------------------

// Latest record per device at each stage, over `scoped` (already date-scoped, newest first). Key matches the engine's.
const latestPerDeviceStage = (scoped) => {
  const out = new Map();
  scoped.forEach((p) => {
    if (!p.dev || !p.stageKey) return;
    const k = `${p.dev}:${p.stageKey}`;
    if (!out.has(k)) out.set(k, p);
  });
  return out;
};

// device key -> the stage its latest resolved record sent it back to
const resolvedReturns = (scoped) => {
  const { getResolvedReturnStage, normalizeKey, isResolvedStatus } = svc();
  const out = new Map();
  const latest = latestPerDeviceStage(scoped);
  latest.forEach((p) => {
    if (!isResolvedStatus(p.r?.status)) return;
    const prev = out.get(p.dev);
    if (!prev || p.at >= prev.at) out.set(p.dev, { returnStage: normalizeKey(getResolvedReturnStage(p.r)), at: p.at });
  });
  return out;
};

const bucketOf = (p, resolvedBy) => {
  const { isPassStatus, isNgStatus, isResolvedStatus } = svc();
  if (isPassStatus(p.status)) return "pass";
  if (isNgStatus(p.status)) {
    const ctx = resolvedBy.get(p.dev);
    if (ctx && ctx.returnStage === p.stageKey) return "returned"; // NG at the stage it was resolved back to: not counted
    return "ng";
  }
  if (isResolvedStatus(p.r?.status)) return "resolved";
  return "other";
};

const seatOf = (p) => svc().getRecordSeatKey(p.r);

// ---- common stages: counted by where each device sits, as the engine does (reconcileCommonStageMetrics) ---------------------------

// A device at common stage i is WIP there and has passed every earlier common stage; a device past the last one (dispatch, delivery ...)
// has passed them all. Devices that failed terminally are left out. Returns the device documents for the stage.
const commonPosition = ({ devices, commonStageNames, stage }) => {
  const { normalizeKey, isDeviceTerminalNg, resolveCommonStageIndex } = svc();
  const at = normalizeKey(stage);
  const idx = commonStageNames.findIndex((n) => normalizeKey(n) === at);
  const out = { passed: [], waiting: [] };
  if (idx < 0) return out;
  (devices || []).forEach((d) => {
    if (isDeviceTerminalNg(d)) return;
    const current = String(d?.currentStage || "").trim();
    if (!current) return;
    const i = resolveCommonStageIndex(current, commonStageNames);
    if (i < 0) return;
    if (i === idx) out.waiting.push(d);
    else if (i > idx) out.passed.push(d);
  });
  return out;
};

const deviceAsRow = (d, status) => ({ r: { serialNo: d.serialNo, deviceId: d._id, status, createdAt: d.updatedAt || null }, dev: String(d._id), stageKey: "", stage: "", status: status.toLowerCase(), at: d.updatedAt ? new Date(d.updatedAt).getTime() : 0, day: "" });

// ---- the analysis -----------------------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {Array}  o.records     process records, newest first
 * @param {Array}  o.devices     device documents of the process {_id, serialNo, status, currentStage, flowVersion}
 * @param {Map}    o.aliasLookup stage alias lookup
 * @param {string} o.stage       canonical stage name
 * @param {string} o.from/to     YYYY-MM-DD, plant time zone; empty = overall
 * @param {object} o.names       Map operatorId -> {name, employeeCode}
 */
const analyzeStage = ({ records, devices, aliasLookup, stage, from = "", to = "", names = new Map(), commonStageNames = [] }) => {
  const { normalizeKey } = svc();
  const stageKey = normalizeKey(stage);
  const flow = flowMap(devices);
  const all = prepare(records, aliasLookup).filter((p) => !flowStale(p, flow));
  const scoped = all.filter((p) => inRange(p, from, to));
  const resolvedBy = resolvedReturns(scoped);

  const finals = Array.from(latestPerDeviceStage(scoped).values()).filter((p) => p.stage && normalizeKey(p.stage) === stageKey);
  const buckets = { pass: [], ng: [], resolved: [], returned: [], other: [] };
  finals.forEach((p) => buckets[bucketOf(p, resolvedBy)].push(p));
  // a common stage also counts every device that is further along (the engine takes the larger of the two counts)
  if (commonStageNames.length) {
    const have = new Set(buckets.pass.map((p) => p.dev));
    commonPosition({ devices, commonStageNames, stage }).passed.forEach((d) => {
      if (!have.has(String(d._id)) && !have.has(String(d.serialNo || "").trim())) buckets.pass.push(deviceAsRow(d, "Pass"));
    });
  }

  // every attempt at this stage in range, per device, oldest first
  const attemptsByDevice = new Map();
  scoped
    .filter((p) => p.stage && normalizeKey(p.stage) === stageKey && p.dev)
    .slice()
    .reverse()
    .forEach((p) => {
      const list = attemptsByDevice.get(p.dev) || [];
      list.push(p);
      attemptsByDevice.set(p.dev, list);
    });
  const { isPassStatus, isNgStatus } = svc();
  const countable = (p) => isPassStatus(p.status) || isNgStatus(p.status);

  let attempts = 0;
  let retryDevices = 0;
  let retryAttempts = 0;
  let retryPassed = 0;
  let firstPassDevices = 0;
  let countedDevices = 0;
  let totalMs = 0;
  let timed = 0;
  let retryMs = 0;
  let retryTimed = 0;
  const byOperator = new Map();
  const bySeat = new Map();
  let firstAt = 0;
  let lastAt = 0;

  attemptsByDevice.forEach((list) => {
    const tries = list.filter(countable);
    if (tries.length === 0) return;
    countedDevices += 1;
    attempts += tries.length;
    if (isPassStatus(tries[0].status)) firstPassDevices += 1;
    const maxStored = Math.max(...tries.map((p) => num(p.r?.attemptNumber)), 0);
    const retried = tries.length > 1 || maxStored > 1;
    if (retried) {
      retryDevices += 1;
      retryAttempts += Math.max(tries.length - 1, maxStored - 1);
      if (isPassStatus(tries[tries.length - 1].status)) retryPassed += 1;
    }
    const devOps = new Set();
    tries.forEach((p, i) => {
      const ms = durationOf(p.r);
      if (ms > 0) {
        totalMs += ms;
        timed += 1;
        if (i > 0) {
          retryMs += ms;
          retryTimed += 1;
        }
      }
      if (p.at) {
        if (!firstAt || p.at < firstAt) firstAt = p.at;
        if (p.at > lastAt) lastAt = p.at;
      }
      const opId = idOf(p.r?.operatorId) || "unknown";
      const row = byOperator.get(opId) || { id: opId, devices: new Set(), attempts: 0, pass: 0, ng: 0, ms: 0, timed: 0, firstAt: 0, lastAt: 0 };
      row.devices.add(p.dev);
      row.attempts += 1;
      if (isPassStatus(p.status)) row.pass += 1;
      else row.ng += 1;
      if (ms > 0) {
        row.ms += ms;
        row.timed += 1;
      }
      if (p.at && (!row.firstAt || p.at < row.firstAt)) row.firstAt = p.at;
      if (p.at > row.lastAt) row.lastAt = p.at;
      byOperator.set(opId, row);
      devOps.add(opId);
    });
  });

  finals.forEach((p) => {
    const bucket = bucketOf(p, resolvedBy);
    if (bucket !== "pass" && bucket !== "ng") return;
    const seat = seatOf(p) || "unknown";
    const row = bySeat.get(seat) || { seatKey: seat, pass: 0, ng: 0 };
    row[bucket] += 1;
    bySeat.set(seat, row);
  });

  const nameOf = (id) => names.get(id) || { name: id === "unknown" ? "Not recorded" : "", employeeCode: "" };
  return {
    counts: {
      devices: countedDevices,
      pass: buckets.pass.length,
      ng: buckets.ng.length,
      resolved: buckets.resolved.length,
      attempts,
    },
    firstPassYield: countedDevices ? round1((firstPassDevices / countedDevices) * 100) : null,
    retry: {
      devices: retryDevices,
      attempts: retryAttempts,
      percent: countedDevices ? round1((retryDevices / countedDevices) * 100) : null,
      passedAfterRetry: retryDevices ? round1((retryPassed / retryDevices) * 100) : null,
      avgRetryMs: retryTimed ? Math.round(retryMs / retryTimed) : null,
    },
    durations: { avgMs: timed ? Math.round(totalMs / timed) : null, totalMs },
    firstAt: firstAt ? new Date(firstAt).toISOString() : null,
    lastAt: lastAt ? new Date(lastAt).toISOString() : null,
    bySeat: Array.from(bySeat.values()).sort((a, b) => (a.seatKey < b.seatKey ? -1 : 1)),
    byOperator: Array.from(byOperator.values())
      .map((o) => ({
        id: o.id === "unknown" ? "" : o.id,
        name: nameOf(o.id).name,
        employeeCode: nameOf(o.id).employeeCode,
        devices: o.devices.size,
        attempts: o.attempts,
        pass: o.pass,
        ng: o.ng,
        avgMs: o.timed ? Math.round(o.ms / o.timed) : null,
        firstAt: o.firstAt ? new Date(o.firstAt).toISOString() : null,
        lastAt: o.lastAt ? new Date(o.lastAt).toISOString() : null,
      }))
      .sort((a, b) => b.attempts - a.attempts),
    // for the device lists
    _finals: { buckets, all, scoped, resolvedBy, stageKey },
  };
};

// ---- WIP list ---------------------------------------------------------------------------------------------------------------

/**
 * The devices counted as WIP at `stage`, by the engine's three real sources, plus what the engine adds that has no device behind it.
 * Pass `all` = every prepared, non-stale record (NOT date scoped: WIP is the live position).
 */
const wipDevicesAt = ({ all, devices, aliasLookup, stage, firstStage, processStatus, lineAllocated, consumed, engineWip = null, stageSeatFallback = new Map(), commonStageNames = [] }) => {
  const { normalizeKey, isPassStatus, isResolvedStatus, getResolvedReturnStage, isDeviceTerminalNg, isKitConfirmedProcessStatus, resolveCanonicalStageName } = svc();
  const stageKey = normalizeKey(stage);
  const latest = latestPerDeviceStage(all);
  const out = [];
  const seen = new Set();
  const seatFor = (p, stageName) => {
    const s = String(p?.r?.assignedSeatKey || "").trim();
    return s || stageSeatFallback.get(normalizeKey(stageName)) || "";
  };

  // 1. resolved and sent back to this stage
  const resolvedBy = resolvedReturns(all);
  latest.forEach((p) => {
    if (!isResolvedStatus(p.r?.status)) return;
    const back = normalizeKey(resolveCanonicalStageName(getResolvedReturnStage(p.r), aliasLookup) || p.stage);
    if (back !== stageKey) return;
    out.push({ source: "resolved", deviceKey: p.dev, serialNo: p.r?.serialNo || p.dev, seatKey: seatOf(p) || seatFor(p, stage), since: p.r?.createdAt || null, fromStage: p.stage, operatorId: idOf(p.r?.operatorId) });
    seen.add(p.dev);
  });

  // 2. passed the previous stage and not yet tested here
  latest.forEach((p) => {
    if (!isPassStatus(p.status)) return;
    const next = String(p.r?.nextLogicalStage || "").trim();
    if (!next) return;
    const nextCanon = resolveCanonicalStageName(next, aliasLookup);
    if (normalizeKey(nextCanon) !== stageKey) return;
    if (latest.has(`${p.dev}:${normalizeKey(next)}`)) return; // already started it
    if (seen.has(p.dev)) return;
    out.push({ source: "passed_previous", deviceKey: p.dev, serialNo: p.r?.serialNo || p.dev, seatKey: seatFor(p, stage), since: p.r?.createdAt || null, fromStage: p.stage, operatorId: idOf(p.r?.operatorId) });
    seen.add(p.dev);
  });

  // 3. devices with no record yet that sit at this stage, in the order the engine takes them, up to the kits on the line
  const processed = new Set(all.map((p) => p.dev).filter(Boolean));
  const terminalIds = new Set();
  const latestByDevice = new Map();
  all.forEach((p) => {
    if (p.dev && !latestByDevice.has(p.dev)) latestByDevice.set(p.dev, p);
  });
  latestByDevice.forEach((p, dev) => {
    const st = p.status;
    const assigned = normalizeKey(p.r?.assignedDeviceTo);
    if (["ng", "fail", "qc", "trc", "rework", "rejected"].includes(st) || assigned === "qc" || assigned === "trc") terminalIds.add(dev);
  });
  let capacity = isKitConfirmedProcessStatus(processStatus) ? Math.max(num(lineAllocated) - num(consumed), 0) : 0;
  let untestedHere = 0;
  (devices || []).forEach((d) => {
    const id = String(d?._id || "");
    if (terminalIds.has(id) || processed.has(id) || processed.has(String(d?.serialNo || "").trim())) return;
    const name = String(d?.currentStage || firstStage || "").trim();
    if (!name) return;
    if (isDeviceTerminalNg(d)) return;
    const st = normalizeKey(d?.status);
    if (st === "completed" || st === "dispatched") return;
    if (capacity <= 0) return;
    capacity -= 1;
    if (normalizeKey(resolveCanonicalStageName(name, aliasLookup)) === stageKey) {
      untestedHere += 1;
      out.push({ source: "untested", deviceKey: id, serialNo: d.serialNo || id, seatKey: stageSeatFallback.get(stageKey) || "", since: null, fromStage: "", operatorId: "" });
    }
  });

  // common stages: devices sitting at the stage
  if (commonStageNames.length) {
    commonPosition({ devices, commonStageNames, stage }).waiting.forEach((d) => {
      const id = String(d._id);
      if (seen.has(id) || out.some((o) => o.deviceKey === id)) return;
      out.push({ source: "at_stage", deviceKey: id, serialNo: d.serialNo || id, seatKey: "", since: d.updatedAt || null, fromStage: "", operatorId: "" });
    });
  }

  const listed = out.length;
  const unlisted = engineWip === null ? null : Math.max(0, num(engineWip) - listed);
  void untestedHere;
  return { rows: out, listed, unlisted, capacityLeft: capacity };
};

// ---- paging -----------------------------------------------------------------------------------------------------------------

const clampPage = (page, pageSize, maxSize = MAX_PAGE) => {
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), maxSize);
  const p = Math.max(parseInt(page, 10) || 1, 1);
  return { page: p, pageSize: size, skip: (p - 1) * size };
};

const finalRow = (p, names) => {
  const opId = idOf(p.r?.operatorId);
  const op = names.get(opId) || { name: "", employeeCode: "" };
  return {
    deviceKey: p.dev,
    serialNo: p.r?.serialNo || p.dev,
    seatKey: seatOf(p),
    status: p.r?.status || "",
    at: p.r?.createdAt || null,
    durationMs: durationOf(p.r) || null,
    attemptNumber: num(p.r?.attemptNumber) || 1,
    operator: { id: opId, name: op.name, employeeCode: op.employeeCode },
    reason: p.r?.ngDescription || p.r?.reason || "",
    nextStage: p.r?.nextLogicalStage || "",
    assignedTo: p.r?.assignedDeviceTo || "",
  };
};

// ---- history ----------------------------------------------------------------------------------------------------------------

const encodeCursor = (p) => Buffer.from(`${p.at}_${idOf(p.r?._id)}`).toString("base64url");
const decodeCursor = (c) => {
  try {
    const [at, id] = Buffer.from(String(c), "base64url").toString("utf8").split("_");
    return { at: Number(at), id: id || "" };
  } catch {
    return null;
  }
};

/** Attempt history of a stage, newest first, cursor-paged. Includes every record (pass, NG, resolved, reset ...). */
const stageHistory = ({ records, devices, aliasLookup, stage, from = "", to = "", operator = "", status = "", serial = "", seat = "", cursor = "", limit = 50, maxLimit = MAX_PAGE, names = new Map() }) => {
  const { normalizeKey, isPassStatus, isNgStatus, isResolvedStatus } = svc();
  const stageKey = normalizeKey(stage);
  const flow = flowMap(devices);
  const rows = prepare(records, aliasLookup)
    .filter((p) => !flowStale(p, flow) && p.stage && normalizeKey(p.stage) === stageKey && inRange(p, from, to))
    .filter((p) => (!operator || idOf(p.r?.operatorId) === operator) && (!seat || seatOf(p) === seat) && (!serial || String(p.r?.serialNo || "").toLowerCase().includes(String(serial).toLowerCase())))
    .filter((p) => {
      if (!status) return true;
      if (status === "pass") return isPassStatus(p.status);
      if (status === "ng") return isNgStatus(p.status);
      if (status === "resolved") return isResolvedStatus(p.r?.status);
      return true;
    })
    .sort((a, b) => b.at - a.at || (idOf(b.r?._id) < idOf(a.r?._id) ? -1 : 1));

  // attempt ordinal per device: position among that device's attempts at this stage (oldest = 1), never below the stored number
  const ordinal = new Map();
  const perDevice = new Map();
  prepare(records, aliasLookup)
    .filter((p) => !flowStale(p, flow) && p.stage && normalizeKey(p.stage) === stageKey && p.dev)
    .sort((a, b) => a.at - b.at)
    .forEach((p) => {
      const n = (perDevice.get(p.dev) || 0) + 1;
      perDevice.set(p.dev, n);
      ordinal.set(idOf(p.r?._id), n);
    });
  const attemptsTotal = (dev) => perDevice.get(dev) || 1;

  let start = 0;
  const c = cursor ? decodeCursor(cursor) : null;
  if (c) {
    const i = rows.findIndex((p) => p.at < c.at || (p.at === c.at && idOf(p.r?._id) < c.id));
    start = i < 0 ? rows.length : i;
  }
  const size = Math.min(Math.max(parseInt(limit, 10) || 50, 1), maxLimit);
  const page = rows.slice(start, start + size);
  return {
    total: rows.length,
    rows: page.map((p) => {
      const opId = idOf(p.r?.operatorId);
      const op = names.get(opId) || { name: "", employeeCode: "" };
      const id = idOf(p.r?._id);
      return {
        id,
        at: p.r?.createdAt || null,
        startTime: p.r?.startTime || null,
        endTime: p.r?.endTime || null,
        durationMs: durationOf(p.r) || null,
        serialNo: p.r?.serialNo || p.dev,
        seatKey: seatOf(p),
        status: p.r?.status || "",
        outcome: isPassStatus(p.status) ? "pass" : isNgStatus(p.status) ? "ng" : isResolvedStatus(p.r?.status) ? "resolved" : "other",
        attempt: Math.max(num(p.r?.attemptNumber), ordinal.get(id) || 1),
        attemptsOnDevice: Math.max(attemptsTotal(p.dev), num(p.r?.attemptNumber)),
        reattemptReason: p.r?.reattemptReason || "",
        reason: p.r?.ngDescription || p.r?.reason || "",
        operator: { id: opId, name: op.name, employeeCode: op.employeeCode },
        nextStage: p.r?.nextLogicalStage || "",
        assignedTo: p.r?.assignedDeviceTo || "",
      };
    }),
    nextCursor: start + size < rows.length ? encodeCursor(page[page.length - 1]) : null,
  };
};

module.exports = { analyzeStage, wipDevicesAt, stageHistory, finalRow, clampPage, prepare, latestPerDeviceStage, bucketOf, durationOf, MAX_PAGE };
