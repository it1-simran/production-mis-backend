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

const REPACKAGING_MENU = {
  icon: `<svg class="fill-current" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 16v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5M21 11H3M16 11V3a2 2 0 0 0-2-2H10a2 2 0 0 0-2 2v8M7 11v5m10-5v5" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  label: "Repackaging",
  route: "/operators/repackaging",
};

const ensureRepackagingMenu = async () => {
  const doc = await Menu.findOne();
  if (!doc) {
    console.error("No Menu document found in database.");
    return;
  }

  const menus = Array.isArray(doc.menus) ? doc.menus : [];
  const exists = menus.some(
    (m) => String(m?.route || "") === REPACKAGING_MENU.route,
  );

  if (!exists) {
    // Find Task Management to insert after
    const taskIndex = menus.findIndex(m => String(m?.label || "").toLowerCase().includes("task management"));
    if (taskIndex !== -1) {
      menus.splice(taskIndex + 1, 0, REPACKAGING_MENU);
    } else {
      menus.push(REPACKAGING_MENU);
    }
    
    doc.menus = menus;
    // Mark as modified to ensure mongoose saves the array change if we used splice
    doc.markModified("menus");
    await doc.save();
    console.log("Added Repackaging menu.");
  } else {
    console.log("Repackaging menu already exists. No changes.");
  }
};

const run = async () => {
  try {
    loadEnv();
    await connectDB();
    await ensureRepackagingMenu();
  } catch (err) {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

run();
