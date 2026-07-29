/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Menu = require("../models/menu");

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

const CHILDREN_TO_ADD = [
  { label: "Bulk Delete Devices", route: "/device/bulk-delete" },
  { label: "Deletion History", route: "/device/deleted-devices" },
];

const ensureDeviceManagementChildren = async () => {
  const doc = await Menu.findOne();
  if (!doc) {
    console.error("No Menu document found in database.");
    return;
  }

  const menus = Array.isArray(doc.menus) ? doc.menus : [];
  const deviceMenuIndex = menus.findIndex(
    (m) => String(m?.label || "").toLowerCase() === "device management",
  );

  if (deviceMenuIndex === -1) {
    console.error('No "Device Management" parent menu found — nothing to attach to.');
    return;
  }

  const deviceMenu = menus[deviceMenuIndex];
  const children = Array.isArray(deviceMenu.children) ? deviceMenu.children : [];
  let changed = false;

  for (const child of CHILDREN_TO_ADD) {
    const exists = children.some((c) => String(c?.route || "") === child.route);
    if (!exists) {
      children.push(child);
      changed = true;
      console.log(`Added "${child.label}" (${child.route}) under Device Management.`);
    } else {
      console.log(`"${child.label}" already exists. Skipping.`);
    }
  }

  if (changed) {
    deviceMenu.children = children;
    doc.menus = menus;
    doc.markModified("menus");
    await doc.save();
    console.log("Menu document saved.");
  } else {
    console.log("No changes needed.");
  }
};

const run = async () => {
  try {
    loadEnv();
    await connectDB();
    await ensureDeviceManagementChildren();
  } catch (err) {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

run();
