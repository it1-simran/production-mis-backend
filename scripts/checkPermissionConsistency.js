/* eslint-disable no-console */
/**
 * Consistency check: every moduleKey referenced by an authorize(...) call in
 * routes/api.js or constants/authorizationModules.js must resolve to a real
 * item in the live Menu document. A reference that doesn't resolve is an
 * "orphaned key" — the exact failure mode that caused the old "Operator
 * Task" permission-key bug (a route gated on a label no menu item ever
 * produced, so no role could ever be granted access to it).
 *
 * Read-only. Usage: node scripts/checkPermissionConsistency.js
 */
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Menu = require("../models/menu");
const MODULE_KEYS = require("../constants/moduleKeys");

const loadEnv = () => {
  const env = process.env.NODE_ENV || "development";
  const envFile = `.env.${env}`;
  const envPath = path.resolve(__dirname, "..", envFile);
  const fallbackPath = path.resolve(__dirname, "..", ".env");

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else if (fs.existsSync(fallbackPath)) {
    dotenv.config({ path: fallbackPath });
  } else {
    console.warn("No .env file found. Using process env.");
  }
};

const collectLiveModuleKeys = (menuDoc) => {
  const keys = new Set();
  const menus = Array.isArray(menuDoc?.menus) ? menuDoc.menus : [];
  for (const item of menus) {
    if (item?.moduleKey) keys.add(item.moduleKey);
    if (Array.isArray(item.children)) {
      for (const child of item.children) {
        if (child?.moduleKey) keys.add(child.moduleKey);
      }
    }
  }
  return keys;
};

/**
 * Statically scans a JS source file for every `MODULE_KEYS.SOME_CONST`
 * reference and resolves it against the imported MODULE_KEYS object, so we
 * check the actual string value used at runtime, not just the identifier.
 */
const findReferencedModuleKeys = (filePath) => {
  const source = fs.readFileSync(filePath, "utf8");
  const referenced = new Set();
  const re = /MODULE_KEYS\.([A-Z0-9_]+)/g;
  let match;
  while ((match = re.exec(source))) {
    const constName = match[1];
    const value = MODULE_KEYS[constName];
    if (value) referenced.add(value);
    else console.warn(`  (!) ${filePath}: MODULE_KEYS.${constName} is not defined in constants/moduleKeys.js`);
  }
  return referenced;
};

const run = async () => {
  loadEnv();
  await connectDB();

  const menuDoc = await Menu.findOne();
  if (!menuDoc) {
    console.error("No Menu document found — cannot verify. Aborting.");
    return;
  }
  const liveKeys = collectLiveModuleKeys(menuDoc);

  const filesToScan = [
    path.resolve(__dirname, "../routes/api.js"),
    path.resolve(__dirname, "../constants/authorizationModules.js"),
  ];

  const allReferenced = new Set();
  for (const file of filesToScan) {
    for (const key of findReferencedModuleKeys(file)) {
      allReferenced.add(key);
    }
  }

  const orphaned = [...allReferenced].filter((key) => !liveKeys.has(key));

  console.log(`Live menu moduleKeys: ${liveKeys.size}`);
  console.log(`Referenced in authorize() call sites: ${allReferenced.size}`);

  if (orphaned.length === 0) {
    console.log("\nNo orphaned moduleKey references found.");
  } else {
    console.log(`\n${orphaned.length} orphaned moduleKey reference(s) — no role can ever be granted these:`);
    orphaned.forEach((key) => console.log(`  ${key}`));
    process.exitCode = 1;
  }
};

run()
  .catch((err) => {
    console.error("Consistency check failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
