const mongoose = require("mongoose");


const RoleSchema = new mongoose.Schema({
}, { _id: false, strict: false });

const UserRolesSchema = new mongoose.Schema({
  roles: {
    type: Map,
    of: RoleSchema,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const UserRoles = mongoose.model("userRoles", UserRolesSchema);
module.exports = UserRoles;
