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

const REPORTS_ICON =
  `<svg class="fill-current" width="18" height="19" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h12v2H3v-2z" fill="#ffffff"/></svg>`;

const REPORTS_CHILD = {
  label: "NG Devices Report",
  route: "/reports/ng-devices",
};

const ensureReportsMenu = async () => {
  const doc = await Menu.findOne();
  if (!doc) {
    const created = new Menu({
      menus: [
        {
          icon: REPORTS_ICON,
          label: "Reports",
          route: "#",
          children: [REPORTS_CHILD],
        },
      ],
    });
    await created.save();
    console.log("Created new Menu with Reports -> NG Devices Report.");
    return;
  }

  const menus = Array.isArray(doc.menus) ? doc.menus : [];
  const reportsIndex = menus.findIndex(
    (m) => String(m?.label || "").toLowerCase() === "reports",
  );

  if (reportsIndex === -1) {
    menus.push({
      icon: REPORTS_ICON,
      label: "Reports",
      route: "#",
      children: [REPORTS_CHILD],
    });
    doc.menus = menus;
    await doc.save();
    console.log("Added Reports menu with NG Devices Report.");
    return;
  }

  const reportsMenu = menus[reportsIndex];
  const children = Array.isArray(reportsMenu.children) ? reportsMenu.children : [];
  const exists = children.some(
    (c) => String(c?.route || "") === REPORTS_CHILD.route,
  );

  if (!exists) {
    children.push(REPORTS_CHILD);
    reportsMenu.children = children;
    menus[reportsIndex] = reportsMenu;
    doc.menus = menus;
    await doc.save();
    console.log("Added NG Devices Report under Reports.");
  } else {
    console.log("NG Devices Report already exists under Reports. No changes.");
  }
};

const run = async () => {
  try {
    loadEnv();
    await connectDB();
    await ensureReportsMenu();
  } catch (err) {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

run();
