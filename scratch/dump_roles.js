const mongoose = require("mongoose");
require("dotenv").config();

async function dumpUserTypes() {
  try {
    const mongoUri = "mongodb+srv://jsddev:x262TbqjMpNYBY*@production-mis.w6l8d.mongodb.net/production-mis?retryWrites=true&w=majority";
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    const UserType = mongoose.model("UserType", new mongoose.Schema({}, { strict: false }));
    const roles = await UserType.find({});
    
    console.log("User Roles found:", roles.length);
    roles.forEach(role => {
      console.log(`\nRole: ${role.name}`);
      console.log("Permissions keys:", Object.keys(role.permissions || {}));
      if (role.permissions) {
        // Log a sample
        const firstKey = Object.keys(role.permissions)[0];
        if (firstKey) {
            console.log(`Sample Permission [${firstKey}]:`, JSON.stringify(role.permissions[firstKey]));
        }
      }
    });

    await mongoose.connection.close();
  } catch (error) {
    console.error("Error:", error);
  }
}

dumpUserTypes();
