/**
 * Adds a SKU's typed-in ("Others") or customer-supplied eSIM details to MES's
 * eSIM master data when NPD gives the SKU final approval, so later CCID
 * uploads for that make/profile resolve their APN.
 *
 * Anything already in the master is REUSED, never recreated or overwritten:
 *   - an existing make (name, case-insensitive) keeps its SIM Make ID
 *   - an existing profile (any name variant, case-insensitive) is reused
 *   - an existing APN for that make + profile wins over the SKU's typed one,
 *     and the SKU is aligned to it (so SKU and CCID uploads agree)
 *
 * The master data is keyed the way the CCID upload reads it:
 *   - EsimMake  { simId, name }          — CCID rows store the make as simId
 *   - EsimProfile { profileId, name[] }  — one profile, several name variants
 *   - EsimApn   { esimMake: simId, esimProfile1: <profile main name>, apnName }
 * getAPNByMakeAndProfile falls back to sibling variants, so one APN row per
 * profile (under its main name) covers every variant.
 *
 * planEsimMasterSync() is read-only (NPD preview); applyEsimMasterSync()
 * creates only what is missing and is safe to re-run.
 */
const EsimMake = require("../models/EsimMake");
const EsimProfile = require("../models/EsimProfile");
const EsimApn = require("../models/EsimApn");

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactCi = (s) => new RegExp(`^${escapeRegex(String(s).trim())}$`, "i");

// A catalog profile reaches the SKU as its joined label ("Airtel / airtel");
// a typed-in one is a single name.
const profileVariants = (label) =>
  String(label || "")
    .split(" / ")
    .map((v) => v.trim())
    .filter(Boolean);

/** Next free numeric id ("10" after "1".."9") for simId / profileId. */
async function nextNumericId(Model, field) {
  const docs = await Model.find({}, { [field]: 1 }).lean();
  const max = docs.reduce((m, d) => {
    const n = parseInt(d[field], 10);
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  return String(max + 1);
}

/** Whether this SKU carries eSIM details that should go into master data. */
function hasSyncableEsim(sku) {
  const e = sku?.esim || {};
  return (e.provider === "jsd" || e.provider === "customer") && !!String(e.make || "").trim() && !!(e.apnProfile1 || e.apnProfile2);
}

async function findProfile(label) {
  const variants = profileVariants(label);
  if (!variants.length) return null;
  return EsimProfile.findOne({ name: { $in: variants.map(exactCi) } }).lean();
}

async function findApn(simId, profileNames) {
  if (!simId || !profileNames.length) return null;
  return EsimApn.findOne({ esimMake: simId, esimProfile1: { $in: profileNames.map(exactCi) } }).lean();
}

/**
 * Read-only preview of what approval will do, per item:
 *   { make: { name, exists, simId },
 *     profiles: [{ slot, label, exists, mainName, profileId,
 *                  apn: { typed, existing, willUse, exists } }] }
 */
async function planEsimMasterSync(sku) {
  if (!hasSyncableEsim(sku)) return { skip: true, make: null, profiles: [] };
  const e = sku.esim;

  const make = await EsimMake.findOne({ name: exactCi(e.make) }).lean();
  const plan = {
    skip: false,
    make: { name: make ? make.name : e.make.trim(), exists: !!make, simId: make ? make.simId : null },
    profiles: [],
  };

  for (const [slot, label, typedApn] of [[1, e.profile1, e.apnProfile1], [2, e.profile2, e.apnProfile2]]) {
    if (!String(label || "").trim()) continue;
    const profile = await findProfile(label);
    const names = profile ? profile.name : profileVariants(label);
    const existingApn = make ? await findApn(make.simId, names) : null;
    plan.profiles.push({
      slot,
      label,
      exists: !!profile,
      mainName: names[0],
      profileId: profile ? profile.profileId : null,
      apn: {
        typed: typedApn || "",
        existing: existingApn ? existingApn.apnName : "",
        exists: !!existingApn,
        // The master's APN wins over the typed one.
        willUse: existingApn ? existingApn.apnName : typedApn || "",
      },
    });
  }
  return plan;
}

/**
 * Create whatever is missing and reuse what exists. Returns
 * { created: [..], reused: [..], apnProfile1, apnProfile2 } — the APNs the SKU
 * should carry after approval (the master's value where one already existed).
 */
async function applyEsimMasterSync(sku) {
  const result = { created: [], reused: [], apnProfile1: sku?.esim?.apnProfile1 || "", apnProfile2: sku?.esim?.apnProfile2 || "" };
  if (!hasSyncableEsim(sku)) return result;
  const e = sku.esim;
  const remarks = `Added from ${sku.skuCode || "SKU request"}`;

  let make = await EsimMake.findOne({ name: exactCi(e.make) }).lean();
  if (make) {
    result.reused.push(`eSIM Make "${make.name}"`);
  } else {
    make = (
      await EsimMake.create({
        simId: await nextNumericId(EsimMake, "simId"),
        name: e.make.trim(),
        manufacturer: "",
        activeStatus: true,
        showInCpanel: true, // selectable in GPSCPANEL right away
        remarks,
      })
    ).toObject();
    result.created.push(`eSIM Make "${make.name}" (SIM Make ID ${make.simId})`);
  }

  for (const [slot, label, typedApn] of [[1, e.profile1, e.apnProfile1], [2, e.profile2, e.apnProfile2]]) {
    if (!String(label || "").trim()) continue;
    let profile = await findProfile(label);
    if (profile) {
      result.reused.push(`eSIM Profile "${profile.name[0]}"`);
    } else {
      profile = (
        await EsimProfile.create({
          profileId: await nextNumericId(EsimProfile, "profileId"),
          name: [profileVariants(label)[0]],
          activeStatus: true,
          remarks,
        })
      ).toObject();
      result.created.push(`eSIM Profile "${profile.name[0]}" (Profile ID ${profile.profileId})`);
    }

    const existing = await findApn(make.simId, profile.name);
    if (existing) {
      result.reused.push(`APN "${existing.apnName}" for ${make.name} / ${profile.name[0]}`);
      result[`apnProfile${slot}`] = existing.apnName;
    } else if (typedApn) {
      await EsimApn.create({ apnName: typedApn, esimMake: make.simId, esimProfile1: profile.name[0], activeStatus: true, remarks });
      result.created.push(`APN "${typedApn}" for ${make.name} / ${profile.name[0]}`);
    }
  }
  return result;
}

module.exports = { planEsimMasterSync, applyEsimMasterSync, hasSyncableEsim };
