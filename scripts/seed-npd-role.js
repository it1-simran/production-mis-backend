/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const UserType = require("../models/userType");

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

const ensureNpdRole = async () => {
  let doc = await UserType.findOne({ name: "NPD" });

  if (!doc) {
    doc = new UserType({ name: "NPD", permissions: {} });
    console.log("Creating new NPD role.");
  } else {
    console.log("NPD role already exists — ensuring it has the SKU-requests permission.");
  }

  doc.permissions.set("dashboard", { create: false, read: true, update: false, delete: false, showInSidebar: true });
  doc.permissions.set("npd__sku_requests", { create: false, read: true, update: true, delete: false, showInSidebar: true });

  await doc.save();
  console.log("NPD role is ready with access to Dashboard + NPD SKU Requests.");
};

const run = async () => {
  try {
    loadEnv();
    await connectDB();
    await ensureNpdRole();
  } catch (err) {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

run();
