const mongoose = require("mongoose");
const processModel = require("../models/process");
const User = require("../models/User");
const { referenceCache } = require("../config/cache");

const PROCESS_PREFIX = "process:";
const OPERATOR_PREFIX = "operator:";

const getCachedProcess = async (processId, select = "stages commonStages") => {
  const id = String(processId || "").trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  const cacheKey = `${PROCESS_PREFIX}${id}:${select}`;
  const cached = referenceCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const doc = select
    ? await processModel.findById(id).select(select).lean()
    : await processModel.findById(id).lean();
  if (doc) {
    referenceCache.set(cacheKey, doc, 120);
  }
  return doc;
};

const getCachedOperator = async (operatorId) => {
  const id = String(operatorId || "").trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  const cacheKey = `${OPERATOR_PREFIX}${id}`;
  const cached = referenceCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const doc = await User.findById(id)
    .select("_id userType role department designation name")
    .lean()
    .catch(() => null);
  if (doc) {
    referenceCache.set(cacheKey, doc, 120);
  }
  return doc;
};

const invalidateProcessCache = (processId) => {
  const id = String(processId || "").trim();
  if (!id) return;
  referenceCache.keys().forEach((key) => {
    if (key.startsWith(`${PROCESS_PREFIX}${id}:`)) {
      referenceCache.del(key);
    }
  });
};

const invalidateOperatorCache = (operatorId) => {
  const id = String(operatorId || "").trim();
  if (!id) return;
  referenceCache.del(`${OPERATOR_PREFIX}${id}`);
};

module.exports = {
  getCachedProcess,
  getCachedOperator,
  invalidateProcessCache,
  invalidateOperatorCache,
};
