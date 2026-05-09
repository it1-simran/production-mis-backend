const mongoose = require("mongoose");
const path = require("path");

// Load models
const Menu = require("../models/menu");

async function dumpMenu() {
  try {
    await mongoose.connect("mongodb://localhost:27017/production-mis");
    console.log("Connected to MongoDB");

    const menus = await Menu.find();
    console.log(JSON.stringify(menus, null, 2));

    await mongoose.disconnect();
  } catch (error) {
    console.error(error);
  }
}

dumpMenu();
