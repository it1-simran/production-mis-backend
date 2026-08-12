const mongoose = require("mongoose");

const userTypeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  permissions: {
    type: Map,
    of: {
      create: { type: Boolean, default: false },
      read: { type: Boolean, default: false },
      update: { type: Boolean, default: false },
      delete: { type: Boolean, default: false },
      // Whether this module gets its own sidebar nav entry, independent of the
      // access flags above — lets a role have working access to a module (e.g.
      // so another page's button can open it) without a dedicated nav link.
      // Absent/undefined means "visible" (see resolveShowInSidebar on the
      // frontend); this schema field only needs to exist so Mongoose's strict
      // embedded-object casting doesn't silently drop it before save.
      showInSidebar: { type: Boolean },
    },
    default: {},
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const UserType = mongoose.model("UserType", userTypeSchema, "userTypes");
module.exports = UserType;
