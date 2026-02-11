const mongoose = require("mongoose");


const RoleSchema = new mongoose.Schema({
  operator: { type: Boolean, default: false },
  admin: { type: Boolean, default: false },
  ppc: { type: Boolean, default: false },
  qc: { type: Boolean, default: false },
  trc: { type: Boolean, default: false },
  store: { type: Boolean, default: false },
  production_manager: { type: Boolean, default: false },
  engineering: { type: Boolean, default: false }
}, { _id: false });

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
