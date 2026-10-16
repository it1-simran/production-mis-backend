// Actual production per day, from the device test records (read-only).
//
//   summarizeActuals(rows, lastStageByPlan)  PURE: aggregated rows -> per-plan, per-day figures
//   loadActuals({ planIds, fromKey, toKey }) reads the rows (one grouped query) and summarises them
//
// "Finished" means a device that PASSED THE LAST STAGE of its process, which is the nearest thing to a unit made.
// "Passed any stage" is the total effort (it moves before anything finishes while a line fills), and "failed"
// counts NG results. Other statuses (resolved, reset ...) are not output and are ignored.

const { TZ } = require("../../utils/planDates");
const { normName } = require("./capacity");

const PASS = "pass";
const FAIL = "ng";

const emptyPlan = () => ({ byDay: new Map(), byStage: new Map(), firstKey: "", lastKey: "", totals: { finished: 0, passedAny: 0, failed: 0 } });

// rows: [{ _id: { plan, day, stage, status }, n }]. lastStageByPlan: Map planId -> last stage name.
const summarizeActuals = (rows, lastStageByPlan = new Map()) => {
  const out = new Map();
  (rows || []).forEach((row) => {
    const planId = String(row?._id?.plan || "");
    const day = String(row?._id?.day || "");
    const stage = String(row?._id?.stage || "");
    const status = String(row?._id?.status || "").trim().toLowerCase();
    const n = Number(row?.n) || 0;
    if (!planId || !day || n <= 0 || (status !== PASS && status !== FAIL)) return;

    if (!out.has(planId)) out.set(planId, emptyPlan());
    const plan = out.get(planId);
    const bucket = plan.byDay.get(day) || { finished: 0, passedAny: 0, failed: 0 };
    const stat = plan.byStage.get(normName(stage)) || { name: stage, passed: 0, failed: 0 };
    if (status === PASS) {
      bucket.passedAny += n;
      stat.passed += n;
      plan.totals.passedAny += n;
      if (normName(stage) === normName(lastStageByPlan.get(planId))) {
        bucket.finished += n;
        plan.totals.finished += n;
      }
    } else {
      bucket.failed += n;
      stat.failed += n;
      plan.totals.failed += n;
    }
    plan.byDay.set(day, bucket);
    plan.byStage.set(normName(stage), stat);
    if (!plan.firstKey || day < plan.firstKey) plan.firstKey = day;
    if (!plan.lastKey || day > plan.lastKey) plan.lastKey = day;
  });
  return out;
};

const localDate = (key, endOfDay = false) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0) : null;
};

const loadActuals = async ({ planIds, lastStageByPlan, fromKey = "", toKey = "" }) => {
  const mongoose = require("mongoose");
  const DeviceTest = require("../../models/deviceTestModel");
  const ids = (planIds || []).filter((id) => mongoose.Types.ObjectId.isValid(String(id))).map((id) => new mongoose.Types.ObjectId(String(id)));
  if (ids.length === 0) return new Map();
  const match = { planId: { $in: ids }, status: { $in: ["Pass", "NG"] } };
  // a day either side of the window, so the plant's day boundary can never cut a record off; the days are filtered below
  const from = localDate(fromKey);
  const to = localDate(toKey, true);
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from.getTime() - 86400000);
    if (to) match.createdAt.$lte = new Date(to.getTime() + 86400000);
  }
  const rows = await DeviceTest.aggregate([
    { $match: match },
    { $group: { _id: { plan: "$planId", day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ } }, stage: "$stageName", status: "$status" }, n: { $sum: 1 } } },
    { $limit: 200000 },
  ]);
  const filtered = rows.filter((r) => (!fromKey || r._id.day >= fromKey) && (!toKey || r._id.day <= toKey));
  return summarizeActuals(filtered, lastStageByPlan);
};

// Whole-history figures for several plans: one query per plan, a few at a time. One query over many plan ids with no date range
// can make the database pick a poor index (7 plans took 42 s that way and 0.5 s as separate queries).
const loadActualsPerPlan = async ({ planIds, lastStageByPlan, concurrency = 6, load = loadActuals }) => {
  const queue = (planIds || []).slice();
  const out = new Map();
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const one = await load({ planIds: [id], lastStageByPlan });
      one.forEach((value, key) => out.set(key, value));
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, worker));
  return out;
};

module.exports = { summarizeActuals, loadActuals, loadActualsPerPlan, emptyPlan };
