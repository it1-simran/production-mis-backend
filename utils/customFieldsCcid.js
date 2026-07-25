// customFields (on the devices collection) is a schemaless, per-stage object,
// e.g. { Functional: { CCID, IMEI }, FQC: {...} }. Key naming for the CCID
// varies by stage/jig (CCID/ccid/ICCID/iccid/...), so instead of hunting for
// specific keys, walk every leaf and match by value.
const normalizeForCompare = (value) => (typeof value === "string" ? value.trim().toUpperCase() : value);

// Recursively deletes any leaf string value in `obj` that matches a value in
// `targets` (a Set of normalized/uppercased strings). Mutates `obj` in place.
// Returns the list of {path, value} removed.
const stripCcidValuesFromObject = (obj, targets, pathPrefix = "") => {
  const removed = [];
  if (!targets || targets.size === 0 || !obj || typeof obj !== "object") return removed;

  if (Array.isArray(obj)) {
    obj.forEach((entry, i) => {
      removed.push(...stripCcidValuesFromObject(entry, targets, `${pathPrefix}[${i}]`));
    });
    return removed;
  }

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const currentPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (value && typeof value === "object") {
      removed.push(...stripCcidValuesFromObject(value, targets, currentPath));
    } else if (typeof value === "string" && targets.has(normalizeForCompare(value))) {
      removed.push({ path: currentPath, value });
      delete obj[key];
    }
  }
  return removed;
};

module.exports = { normalizeForCompare, stripCcidValuesFromObject };
