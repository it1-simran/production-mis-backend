const normalizeValue = (value) => String(value || "").trim();
const normalizeKey = (value) => normalizeValue(value).toLowerCase().replace(/\s+/g, " ");

const normalizeTokenList = (rawTokens = []) => {
  const seen = new Set();
  return (Array.isArray(rawTokens) ? rawTokens : [])
    .map((token) => normalizeKey(String(token || "").replace(/[\r\n]+/g, " ")))
    .filter((token) => {
      if (!token || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
};

const parseStickerScanTokens = (value = "") => {
  const rawTokens = String(value || "").split(",");
  return normalizeTokenList(rawTokens);
};

const collectRawScanValues = (value, collectedValues) => {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    value.forEach((item) => collectRawScanValues(item, collectedValues));
    return;
  }

  if (typeof value === "object") {
    Object.values(value).forEach((item) => collectRawScanValues(item, collectedValues));
    return;
  }

  collectedValues.push(value);
};

const parseStickerScanTokensFromJigFields = (jigFields = {}) => {
  const values = [];
  collectRawScanValues(jigFields, values);
  const rawTokens = values.flatMap((value) => String(value || "").split(","));
  return normalizeTokenList(rawTokens);
};

const normalizeCustomFieldsObject = (raw) => {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
};

const appendIndexedValue = (index, field, value) => {
  const normalized = normalizeKey(String(value || "").replace(/[\r\n]+/g, " "));
  if (!normalized) return;

  if (!index.has(normalized)) {
    index.set(normalized, new Set());
  }

  const fieldLabel = normalizeValue(field || "value") || "value";
  index.get(normalized).add(fieldLabel);
};

const indexNestedCustomFieldValues = (value, index, fieldName = "") => {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    value.forEach((item) => indexNestedCustomFieldValues(item, index, fieldName));
    return;
  }

  if (typeof value === "object") {
    Object.entries(value).forEach(([key, nestedValue]) => {
      indexNestedCustomFieldValues(nestedValue, index, key || fieldName || "customField");
    });
    return;
  }

  appendIndexedValue(index, fieldName || "value", value);
};

const buildDeviceSearchIndex = (device = {}) => {
  const index = new Map();
  const addDirectField = (field, value) => appendIndexedValue(index, field, value);

  [
    ["serialNo", device?.serialNo],
    ["serial_no", device?.serial_no],
    ["serial", device?.serial],
    ["imeiNo", device?.imeiNo],
    ["imei", device?.imei],
    ["imei_no", device?.imei_no],
    ["ccid", device?.ccid],
    ["CCID", device?.CCID],
    ["ccidNo", device?.ccidNo],
    ["iccid", device?.iccid],
    ["ICCID", device?.ICCID],
  ].forEach(([field, value]) => addDirectField(field, value));

  indexNestedCustomFieldValues(normalizeCustomFieldsObject(device?.customFields), index);

  return index;
};

const rankDevicesByScanTokens = (devices = [], scanTokens = []) => {
  const normalizedTokens = normalizeTokenList(scanTokens);
  if (!normalizedTokens.length) return [];

  return (Array.isArray(devices) ? devices : [])
    .map((device) => {
      const searchIndex = buildDeviceSearchIndex(device);
      const matchedFields = {};
      const matchedTokens = [];

      for (const token of normalizedTokens) {
        const matchingFieldSet = searchIndex.get(token);
        if (matchingFieldSet && matchingFieldSet.size > 0) {
          matchedFields[token] = Array.from(matchingFieldSet);
          matchedTokens.push(token);
        }
      }

      if (!matchedTokens.length) return null;

      return {
        device,
        matchedTokens,
        matchedFields,
        matchedCount: matchedTokens.length,
        totalTokens: normalizedTokens.length,
        matchMode:
          matchedTokens.length === normalizedTokens.length
            ? normalizedTokens.length > 1
              ? "multi"
              : "single"
            : "partial",
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.matchedCount !== left.matchedCount) {
        return right.matchedCount - left.matchedCount;
      }
      return String(left?.device?._id || "").localeCompare(
        String(right?.device?._id || ""),
      );
    });
};

const findDevicesByScanTokensStrict = (devices = [], scanTokens = []) => {
  const normalizedTokens = normalizeTokenList(scanTokens);
  if (!normalizedTokens.length) return [];

  return rankDevicesByScanTokens(devices, normalizedTokens).filter(
    (item) => item.matchedCount === normalizedTokens.length,
  );
};

const findDevicesByScanTokensBestEffort = (devices = [], scanTokens = []) => {
  const normalizedTokens = normalizeTokenList(scanTokens);
  if (!normalizedTokens.length) return [];

  const strictMatches = findDevicesByScanTokensStrict(devices, normalizedTokens);
  if (strictMatches.length > 0) return strictMatches;

  const rankedMatches = rankDevicesByScanTokens(devices, normalizedTokens);
  if (!rankedMatches.length) return [];

  const bestMatchedCount = rankedMatches[0].matchedCount;
  return rankedMatches.filter((item) => item.matchedCount === bestMatchedCount);
};

module.exports = {
  parseStickerScanTokens,
  parseStickerScanTokensFromJigFields,
  findDevicesByScanTokensStrict,
  findDevicesByScanTokensBestEffort,
};
