/* eslint-disable no-console */
// READ-ONLY. The key check for the overview's Production tab: for every plan, the figures from
// services/planning/planOperations.js must equal what the live monitoring page's own endpoint returns
// (GET /planingAndScheduling/insights/:id, called through its real handler).
//
// computePlanInsights shares a 12-second cache between callers, so comparing straight after the legacy call would
// compare a result with itself. This script therefore runs every legacy call first, waits for the cache to expire,
// and only then runs the new ones, so each side computes its own numbers.
//
// Usage:
//   node scripts/check-plan-operations.js                         (uses .env.development unless NODE_ENV is set)
//   NODE_ENV=production node scripts/check-plan-operations.js
//   node scripts/check-plan-operations.js --plan <id>
//   node scripts/check-plan-operations.js --from 2026-10-01 --to 2026-10-07     (also compares with a date range)
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const loadEnv = () => {
  const env = process.env.NODE_ENV || "development";
  const envPath = path.resolve(__dirname, "..", `.env.${env}`);
  const fallback = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
  else if (fs.existsSync(fallback)) dotenv.config({ path: fallback });
  console.log(`Environment: ${env}`);
};
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const callLegacy = (controller, id, query) =>
  new Promise((resolve) => {
    const res = {
      status(code) {
        this.code = code;
        return this;
      },
      json(body) {
        resolve({ status: this.code, body });
      },
    };
    controller.getPlanInsights({ params: { id }, query }, res);
  });

const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, Number(row?.[k]) || 0]));
const TOTAL_KEYS = ["tested", "pass", "ng", "wip", "lineIssueKits", "kitsShortage"];
const STAGE_KEYS = ["tested", "pass", "ng", "wip"];

// With a date range, pass and NG follow the range but WIP is the live position (as the monitoring page shows it), so WIP is
// compared against the unfiltered figures.
const compare = (legacy, fresh, liveLegacy = null) => {
  const diffs = [];
  const eq = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${label}: monitoring page ${JSON.stringify(a)} / overview ${JSON.stringify(b)}`);
  };
  const liveWip = liveLegacy ? liveLegacy.totals?.wip : legacy.totals?.wip;
  eq("totals", { ...pick(legacy.totals, TOTAL_KEYS), wip: Number(liveWip) || 0 }, pick(fresh.totals, TOTAL_KEYS));
  // the overview also lists stages the engine leaves out because nothing has happened on them: those rows must be all zeros
  const known = new Set((legacy.byStage || []).map((s) => s.stageName));
  const added = fresh.stages.filter((s) => !known.has(s.name));
  // (with a date range their WIP can still be live WIP, so it is compared with the live figure)
  const liveWipOf = (name) => Number((liveLegacy ? (liveLegacy.byStage || []) : []).find((r) => r.stageName === name)?.wip) || 0;
  eq("stages added with no activity", added.map((s) => [s.tested, s.pass, s.ng, s.wip]), added.map((s) => [0, 0, 0, liveWipOf(s.name)]));
  eq("stages the monitoring page reports, in its order", (legacy.byStage || []).map((s) => s.stageName), fresh.stages.filter((s) => known.has(s.name)).map((s) => s.name));
  (legacy.byStage || []).forEach((row, i) => {
    const mine = fresh.stages.find((s) => s.name === row.stageName);
    if (!mine) return;
    const liveRow = liveLegacy ? (liveLegacy.byStage || []).find((r) => r.stageName === row.stageName) : row;
    eq(`stage ${row.stageName}`, { ...pick(row, STAGE_KEYS), wip: Number(liveRow?.wip) || 0, upha: Number(row.upha) || 0, achievedUph: Number(row.achievedUph) || 0 }, { ...pick(mine, STAGE_KEYS), upha: mine.targetUpha, achievedUph: mine.achievedUph });
  });
  const liveSeat = (r) => (liveLegacy ? Number((liveLegacy.bySeatStage || []).find((x) => x.seatKey === r.seatKey && x.stageName === r.stageName)?.wip) || 0 : Number(r.wip) || 0);
  eq("seat rows", (legacy.bySeatStage || []).map((r) => [r.seatKey, r.stageName, Number(r.tested) || 0, Number(r.pass) || 0, Number(r.ng) || 0, liveSeat(r)]), fresh.bySeatStage.map((r) => [r.seatKey, r.stageName, r.tested, r.pass, r.ng, r.wip]));
  eq("kits on the line", Number(legacy.allocatedKits) || 0, fresh.kits.lineAllocated);
  return diffs;
};

const main = async () => {
  loadEnv();
  await require("../config/db")();
  console.log(`Database: ${mongoose.connection.name}\n`);

  const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
  const planning = require("../controller/planningAndSchedulingController");
  const { loadOperations } = require("../services/planning/planOperations");

  const onlyPlan = argValue("--plan");
  const from = argValue("--from") || "";
  const to = argValue("--to") || "";
  const plans = await PlaningAndSchedulingModel.find(onlyPlan ? { _id: onlyPlan } : {}).select("processName selectedProcess isDrafted").lean();
  const ranges = [{ label: "overall", from: "", to: "" }, ...(from || to ? [{ label: `${from}..${to}`, from, to }] : [])];
  console.log(`${plans.length} plan(s), ${ranges.length} range(s)\n`);

  // 1. the monitoring page's own handler, for everything
  const legacy = new Map();
  for (const range of ranges) {
    for (const plan of plans) {
      const r = await callLegacy(planning, String(plan._id), range.from || range.to ? { from: range.from, to: range.to } : {});
      legacy.set(`${plan._id}|${range.label}`, r);
    }
  }
  // 2. let the shared 12-second cache expire, so the next calls compute for themselves
  console.log("waiting 13s for the insights cache to expire...");
  await sleep(13000);

  // 3. the new module
  const stats = { same: 0, differ: 0, skipped: 0, shared: 0 };
  for (const range of ranges) {
    for (const plan of plans) {
      const id = String(plan._id);
      const old = legacy.get(`${id}|${range.label}`);
      const fresh = await loadOperations({ planId: id, from: range.from, to: range.to });
      const name = `${String(plan.processName).slice(0, 34).padEnd(34)} ${range.label.padEnd(10)}`;
      if (old.status !== 200 || !fresh.ok) {
        stats.skipped += 1;
        console.log(`--  ${name} not compared (monitoring page ${old.status}, overview ${fresh.ok ? 200 : fresh.status})`);
        continue;
      }
      const liveOld = range.from || range.to ? legacy.get(`${id}|overall`) : null;
      const diffs = compare(old.body.data, fresh.body, liveOld?.body?.data || null);
      if (fresh.body.scope.plansOnProcess > 1) stats.shared += 1;
      const t = fresh.body.totals;
      if (diffs.length) {
        stats.differ += 1;
        console.log(`!!  ${name} DIFFERS\n      ${diffs.join("\n      ")}`);
      } else {
        stats.same += 1;
        console.log(`ok  ${name} pass ${String(t.pass).padStart(5)}  ng ${String(t.ng).padStart(4)}  wip ${String(t.wip).padStart(5)}  kits(line) ${String(fresh.body.kits.lineAllocated).padStart(5)}${fresh.body.scope.plansOnProcess > 1 ? `  [${fresh.body.scope.plansOnProcess} plans on this process]` : ""}${fresh.body.scope.partial ? "  [PARTIAL: scan limit reached]" : ""}${t.overQuantity ? "  [more output than the planned quantity]" : ""}`);
      }
    }
  }
  console.log(`\nidentical ${stats.same}, different ${stats.differ}, not compared ${stats.skipped}, on a process with several plans ${stats.shared}`);
  await mongoose.disconnect();
  process.exit(stats.differ ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
