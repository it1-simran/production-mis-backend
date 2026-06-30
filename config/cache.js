const NodeCache = require("node-cache");

const referenceCache = new NodeCache({
  stdTTL: 120,
  checkperiod: 600,
  useClones: false,
});

const queryResultCache = new NodeCache({
  stdTTL: 10,
  checkperiod: 120,
  useClones: false,
});

module.exports = {
  referenceCache,
  queryResultCache,
};
