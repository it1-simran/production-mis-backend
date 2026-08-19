/**
 * Resolves ${slug} tokens inside a Testing Plan against a Purchase Order.
 *
 * Slug mappings (from the SlugMapping collection) point each slug at a dot-path
 * in the PO, e.g. vendor_id -> "vendorId", pip -> "configuration.values.pip.value".
 * Every string in the plan (commands, values, jigFields…) has its ${slug}
 * tokens replaced with the resolved PO value. Unknown slugs are left untouched.
 */

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function buildSlugValues(po, slugMaps = []) {
  const values = {};
  for (const m of slugMaps) {
    if (!m || !m.slug || m.isActive === false) continue;
    const v = getByPath(po, m.source);
    values[m.slug] = v == null ? "" : String(v);
  }
  return values;
}

function resolveString(str, values) {
  return str.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (full, slug) =>
    Object.prototype.hasOwnProperty.call(values, slug) ? values[slug] : full
  );
}

function resolveDeep(node, values) {
  if (typeof node === "string") return resolveString(node, values);
  if (Array.isArray(node)) return node.map((n) => resolveDeep(n, values));
  if (node && typeof node === "object") {
    const out = {};
    for (const k of Object.keys(node)) out[k] = resolveDeep(node[k], values);
    return out;
  }
  return node;
}

/**
 * @param {any} plan      Testing plan template (array of stages or any nested structure).
 * @param {object} po     Plain PO object (call po.toObject() first for a mongoose doc).
 * @param {Array} slugMaps SlugMapping docs.
 */
function resolveTestingPlan(plan, po, slugMaps) {
  return resolveDeep(plan, buildSlugValues(po, slugMaps));
}

module.exports = { resolveTestingPlan, buildSlugValues, getByPath };
