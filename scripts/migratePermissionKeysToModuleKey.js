/* eslint-disable no-console */
/**
 * One-time migration: copy every UserType.permissions grant stored under a
 * legacy derived-label key (e.g. "view_process") to the new stable moduleKey
 * (e.g. "process_management.view"). Additive only — legacy keys are left in
 * place, nothing is deleted, so this is safe to run more than once and safe
 * to leave un-run (the authController fallback keeps legacy keys working
 * either way).
 *
 * Usage:
 *   node scripts/migratePermissionKeysToModuleKey.js            # dry run, no writes
 *   node scripts/migratePermissionKeysToModuleKey.js --write    # persist changes
 */
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Menu = require("../models/menu");
const UserTypes = require("../models/userType");
const LEGACY_MODULE_LABELS = require("../constants/legacyModuleLabels");

const loadEnv = () => {
  const env = process.env.NODE_ENV || "development";
  const envFile = `.env.${env}`;
  const envPath = path.resolve(__dirname, "..", envFile);
  const fallbackPath = path.resolve(__dirname, "..", ".env");

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`Loaded ${envFile}`);
  } else if (fs.existsSync(fallbackPath)) {
    dotenv.config({ path: fallbackPath });
    console.log("Loaded .env");
  } else {
    console.warn("No .env file found. Using process env.");
  }
};

const legacyDerive = (label) =>
  String(label || "").toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Build legacyDerivedKey -> moduleKey from two sources: the live Menu doc
 * (current labels) and constants/legacyModuleLabels.js (every historical
 * label a module has ever been known by, including ones already renamed
 * away from — e.g. "Inventory" before it became "Inventory & Store
 * Management"). The live doc alone isn't enough once a label has changed,
 * since a role's stored permission key can still reflect the label it had
 * *when the role was granted*, not today's label.
 */
const buildLegacyKeyToModuleKey = (menuDoc) => {
  const map = {};
  for (const [moduleKey, labels] of Object.entries(LEGACY_MODULE_LABELS)) {
    for (const label of labels) {
      map[legacyDerive(label)] = moduleKey;
    }
  }
  const menus = Array.isArray(menuDoc?.menus) ? menuDoc.menus : [];
  for (const item of menus) {
    if (!item?.moduleKey) continue;
    map[legacyDerive(item.label)] = item.moduleKey;
    if (Array.isArray(item.children)) {
      for (const child of item.children) {
        if (!child?.moduleKey) continue;
        map[legacyDerive(child.label)] = child.moduleKey;
      }
    }
  }
  return map;
};

const orMergePerm = (a, b) => ({
  create: !!(a?.create || b?.create),
  read: !!(a?.read || b?.read),
  update: !!(a?.update || b?.update),
  delete: !!(a?.delete || b?.delete),
});

const run = async () => {
  const write = process.argv.includes("--write");
  loadEnv();
  await connectDB();

  const menuDoc = await Menu.findOne();
  if (!menuDoc) {
    console.error("No Menu document found — cannot build legacyKey -> moduleKey map. Aborting.");
    return;
  }
  const legacyKeyToModuleKey = buildLegacyKeyToModuleKey(menuDoc);

  const roles = await UserTypes.find();
  console.log(`Found ${roles.length} role(s).\n`);

  const orphanedKeysSeen = new Set();

  for (const role of roles) {
    const permissions = role.permissions || new Map();
    const entries =
      permissions instanceof Map ? Array.from(permissions.entries()) : Object.entries(permissions);

    if (entries.length === 0) {
      console.log(`[${role.name}] no permissions set — skipping.`);
      continue;
    }

    let changed = false;
    const report = [];

    for (const [legacyKey, value] of entries) {
      const moduleKey = legacyKeyToModuleKey[legacyKey];
      if (!moduleKey) {
        // Already a moduleKey (dotted), or a truly orphaned legacy key with
        // no matching menu item — either way, nothing to migrate for it.
        if (!legacyKey.includes(".") && !Object.values(legacyKeyToModuleKey).includes(legacyKey)) {
          orphanedKeysSeen.add(legacyKey);
        }
        continue;
      }
      if (moduleKey === legacyKey) continue; // already the moduleKey itself

      const existing = permissions instanceof Map ? permissions.get(moduleKey) : permissions[moduleKey];
      if (existing) {
        // moduleKey already has an explicit entry — it's authoritative (this
        // is exactly the precedence rule authController.hasModuleLabelAction
        // and the frontend's resolveStoredModulePermissions now enforce).
        // OR-merging the legacy value in here would silently resurrect a
        // permission an admin deliberately downgraded through the editor
        // after this role was last touched by the old key format — do not
        // touch it, just report that it's being left alone.
        report.push(`  ${legacyKey} -> ${moduleKey}: already has its own value, left unchanged (legacy value ignored: ${JSON.stringify(value)})`);
        continue;
      }
      const merged = orMergePerm(existing, value);
      if (permissions instanceof Map) {
        permissions.set(moduleKey, merged);
      } else {
        permissions[moduleKey] = merged;
      }
      changed = true;
      report.push(`  ${legacyKey} -> ${moduleKey}: ${JSON.stringify(merged)}`);
    }

    if (changed) {
      console.log(`[${role.name}]`);
      report.forEach((line) => console.log(line));
      if (write) {
        role.permissions = permissions;
        role.markModified("permissions");
        await role.save();
        console.log(`  Saved.`);
      }
    } else {
      console.log(`[${role.name}] no legacy keys needed migrating.`);
    }
  }

  if (orphanedKeysSeen.size > 0) {
    console.log("\nOrphaned legacy keys (no matching menu item — review manually):");
    orphanedKeysSeen.forEach((k) => console.log(`  ${k}`));
  }

  console.log(write ? "\nDone (written)." : "\nDry run complete — pass --write to persist.");
};

run()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
