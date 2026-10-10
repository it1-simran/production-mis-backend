/* eslint-disable no-console */
// End-to-end check of "a kit is consumed when a device first reaches PDI". It runs the REAL cartonController.shiftToPDI and the
// kitConsumption helper (which Keep in Store and the FG to Store test also use) against a real MongoDB, inside a throwaway database
// ("kit-consumption-e2e-<timestamp>") that it drops at the end, so no existing data is read or changed.
//
// Usage:   node scripts/kit-consumption-smoke.js          (uses .env.development)
// Refuses to run with NODE_ENV=production.
const path = require("path");
const fs = require("fs");
const dns = require("dns");
const assert = require("node:assert/strict");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const env = process.env.NODE_ENV || "development";
if (env === "production") {
  console.error("Refusing to run with NODE_ENV=production.");
  process.exit(2);
}
const envPath = path.resolve(__dirname, "..", `.env.${env}`);
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const scratchName = `kit-consumption-e2e-${Date.now()}`;
const results = [];
let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL ${name}\n         ${String(error.message).split("\n").join("\n         ")}`);
  }
};
const oid = () => new mongoose.Types.ObjectId();
const call = async (handler, { body = {}, params = {}, user } = {}) => {
  const out = { status: 200, body: null };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(payload) {
      out.body = payload;
      return this;
    },
  };
  await handler({ body, params, query: {}, user, headers: {} }, res);
  return out;
};

const main = async () => {
  try {
    const existing = dns.getServers();
    dns.setServers(["8.8.8.8", "1.1.1.1", ...existing.filter((s) => s !== "8.8.8.8" && s !== "1.1.1.1")]);
  } catch {
    // keep system resolvers
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: scratchName, autoIndex: false, serverSelectionTimeoutMS: 15000 });
  assert.equal(mongoose.connection.name, scratchName);
  console.log(`Scratch database: ${mongoose.connection.name}\n`);

  const Device = require("../models/device");
  const ProcessModel = require("../models/process");
  const PlanModel = require("../models/planingAndSchedulingModel");
  const Carton = require("../models/cartonManagement");
  const carton = require("../controller/cartonController");
  const { claimKitConsumption, planForProcess } = require("../services/kitConsumption");

  const user = { id: String(oid()) };
  const processId = oid();
  const planId = oid();
  await ProcessModel.collection.insertOne({ _id: processId, name: "P", processID: "PID-1", consumedKits: 0, issuedKits: 20, quantity: "20", status: "active" });
  await PlanModel.collection.insertOne({ _id: planId, processName: "P", selectedProcess: processId, isDrafted: 0, consumedKit: 0, createdAt: new Date() });
  const devices = Array.from({ length: 10 }, (_, i) => ({ _id: oid(), processID: processId, serialNo: `S${i}`, currentStage: "Packaging", kitConsumedAt: null }));
  await Device.collection.insertMany(devices);
  const ids = (from, to) => devices.slice(from, to).map((d) => d._id);
  const consumed = async () => ({ process: (await ProcessModel.findById(processId).lean()).consumedKits, plan: (await PlanModel.findById(planId).lean()).consumedKit });
  const makeCarton = (serial, deviceIds) => new Carton({ cartonSerial: serial, processId, devices: deviceIds, isStickerVerified: true, cartonStatus: "Packaging" }).save();

  await step("shifting a carton to PDI consumes one kit per device, on the process and on its plan", async () => {
    await makeCarton("C1", ids(0, 3));
    const r = await call(carton.shiftToPDI, { body: { cartons: ["C1"] }, user });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await consumed(), { process: 3, plan: 3 });
    assert.equal(await Device.countDocuments({ _id: { $in: ids(0, 3) }, currentStage: "PDI", kitConsumedAt: { $ne: null } }), 3);
  });

  await step("a carton sent back after a PDI NG and shifted again counts nothing more", async () => {
    await Carton.updateOne({ cartonSerial: "C1" }, { $set: { cartonStatus: "Packaging", isReturnedFromPdi: true } });
    await Device.updateMany({ _id: { $in: ids(0, 3) } }, { $set: { currentStage: "Packaging" } });
    assert.equal((await call(carton.shiftToPDI, { body: { cartons: ["C1"] }, user })).status, 200);
    assert.deepEqual(await consumed(), { process: 3, plan: 3 }, "still 3");
    // and shifting the very same carton twice in a row
    await call(carton.shiftToPDI, { body: { cartons: ["C1"] }, user });
    assert.deepEqual(await consumed(), { process: 3, plan: 3 });
  });

  await step("several cartons in one shift add up, and a carton with an already counted device only adds the new ones", async () => {
    await makeCarton("C2", ids(3, 5));
    await makeCarton("C3", [...ids(5, 7), ...ids(0, 1)]); // one device from C1 again
    const r = await call(carton.shiftToPDI, { body: { cartons: ["C2", "C3"] }, user });
    assert.equal(r.status, 200);
    assert.deepEqual(await consumed(), { process: 7, plan: 7 }, "3 + 2 + 2, the repeated device not counted again");
  });

  await step("Keep in Store and the FG to Store test only count a device that was not counted yet", async () => {
    const already = await claimKitConsumption({ deviceIds: ids(0, 7), processId, planId });
    assert.equal(already.counted, 0);
    assert.deepEqual(await consumed(), { process: 7, plan: 7 });
    // a device that never went through PDI (an older flow) is counted there, once
    const late = await claimKitConsumption({ deviceIds: ids(7, 8), processId, planId });
    assert.equal(late.counted, 1);
    assert.equal((await claimKitConsumption({ deviceIds: ids(7, 8), processId, planId })).counted, 0);
    assert.deepEqual(await consumed(), { process: 8, plan: 8 });
  });

  await step("simultaneous requests for the same devices count each device exactly once", async () => {
    const results2 = await Promise.all(Array.from({ length: 8 }, () => claimKitConsumption({ deviceIds: ids(8, 10), processId, planId })));
    assert.equal(results2.reduce((s, r) => s + r.counted, 0), 2);
    assert.deepEqual(await consumed(), { process: 10, plan: 10 });
  });

  await step("a failure while raising the totals undoes the claim, so the devices are counted on the next try", async () => {
    await Device.collection.updateMany({ _id: { $in: ids(8, 10) } }, { $set: { kitConsumedAt: null } });
    await ProcessModel.collection.updateOne({ _id: processId }, { $set: { consumedKits: 8 } });
    await PlanModel.collection.updateOne({ _id: planId }, { $set: { consumedKit: 8 } });
    const original = ProcessModel.updateOne;
    ProcessModel.updateOne = () => Promise.reject(new Error("database went away"));
    await assert.rejects(() => claimKitConsumption({ deviceIds: ids(8, 10), processId, planId }), /database went away/);
    ProcessModel.updateOne = original;
    assert.equal(await Device.countDocuments({ _id: { $in: ids(8, 10) }, kitConsumedAt: null }), 2, "the claim was undone");
    assert.deepEqual(await consumed(), { process: 8, plan: 8 });
    assert.equal((await claimKitConsumption({ deviceIds: ids(8, 10), processId, planId })).counted, 2);
    assert.deepEqual(await consumed(), { process: 10, plan: 10 });
  });

  await step("if only the plan total fails, the process total that did go up is put back too", async () => {
    await Device.collection.updateMany({ _id: { $in: ids(8, 10) } }, { $set: { kitConsumedAt: null } });
    await ProcessModel.collection.updateOne({ _id: processId }, { $set: { consumedKits: 8 } });
    await PlanModel.collection.updateOne({ _id: planId }, { $set: { consumedKit: 8 } });
    const original = PlanModel.updateOne;
    PlanModel.updateOne = () => Promise.reject(new Error("plan write failed"));
    await assert.rejects(() => claimKitConsumption({ deviceIds: ids(8, 10), processId, planId }), /plan write failed/);
    PlanModel.updateOne = original;
    assert.deepEqual(await consumed(), { process: 8, plan: 8 }, "nothing is left half counted");
    assert.equal(await Device.countDocuments({ _id: { $in: ids(8, 10) }, kitConsumedAt: null }), 2);
    assert.equal((await claimKitConsumption({ deviceIds: ids(8, 10), processId, planId })).counted, 2);
    assert.deepEqual(await consumed(), { process: 10, plan: 10 });
  });

  await step("the plan is the process's latest published plan; a process with none still counts on the process", async () => {
    assert.equal(String(await planForProcess(processId)), String(planId));
    await PlanModel.collection.insertOne({ _id: oid(), processName: "draft", selectedProcess: processId, isDrafted: 1, createdAt: new Date(Date.now() + 1000) });
    assert.equal(String(await planForProcess(processId)), String(planId), "a draft is never chosen");
    const lonely = oid();
    await ProcessModel.collection.insertOne({ _id: lonely, name: "L", processID: "PID-2", consumedKits: 0 });
    assert.equal(await planForProcess(lonely), null);
    const d = { _id: oid(), processID: lonely, kitConsumedAt: null };
    await Device.collection.insertOne(d);
    await claimKitConsumption({ deviceIds: [d._id], processId: lonely, latestPlan: true });
    assert.equal((await ProcessModel.findById(lonely).lean()).consumedKits, 1);
  });

  await step("bad input counts nothing and does not throw", async () => {
    assert.deepEqual(await claimKitConsumption({ deviceIds: [], processId }), { counted: 0, devices: 0 });
    assert.deepEqual(await claimKitConsumption({ deviceIds: ["nope", null], processId }), { counted: 0, devices: 0 });
    assert.equal((await claimKitConsumption({ deviceIds: [oid()], processId })).counted, 0, "a device that does not exist");
  });

  console.log(results.join("\n"));
  console.log(`\n${results.filter((r) => r.startsWith("  ok")).length}/${results.length} passed, ${failures} failed`);
  await mongoose.connection.dropDatabase();
  console.log(`Dropped scratch database ${scratchName}`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
};

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch {
    // nothing to clean
  }
  process.exit(1);
});
