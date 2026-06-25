const { queryResultCache } = require("../config/cache");

const buildSummaryCacheKey = (suffix, planId, operatorId, extra = "") =>
  `summary:${suffix}:${planId}:${operatorId}${extra ? `:${extra}` : ""}`;

const getCachedQueryResult = (key, fetcher, ttlSeconds = 10) => {
  const cached = queryResultCache.get(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  return fetcher().then((result) => {
    queryResultCache.set(key, result, ttlSeconds);
    return result;
  });
};

const invalidateOperatorTaskSummaryCache = (planId, operatorId) => {
  const plan = String(planId || "").trim();
  const operator = String(operatorId || "").trim();
  if (!plan && !operator) return;

  queryResultCache.keys().forEach((key) => {
    if (!key.startsWith("summary:")) return;
    if (plan && !key.includes(`:${plan}:`)) return;
    if (operator && !key.includes(`:${operator}`)) return;
    queryResultCache.del(key);
  });
};

module.exports = {
  buildSummaryCacheKey,
  getCachedQueryResult,
  invalidateOperatorTaskSummaryCache,
};
