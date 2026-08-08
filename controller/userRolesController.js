const mongoose = require("mongoose");
const UserTypes = require("../models/userType");
const User = require("../models/User");
const { normalizeUserTypeKey, isFullAccessRole } = require("../utils/roleAccess");
console.log(">>> [DEBUG] UserTypes Model Loaded:", !!UserTypes, typeof UserTypes);
const bcrypt = require("bcrypt");
module.exports = {
  create: async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Role name is required" });
      }
      const roleName = name.trim();
      const existingRole = await UserTypes.findOne({ name: new RegExp(`^${roleName}$`, "i") });
      if (existingRole) {
        return res.status(400).json({ message: "Role already exists" });
      }

      const newUserType = new UserTypes({
        name: roleName,
        permissions: new Map(),
        createdAt: new Date(),
        updatedAt: new Date()
      });
      await newUserType.save();

      return res.status(200).json({
        status: 200,
        message: "User Role Created successfully!!",
        newUserRoles: newUserType,
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "An error occurred while creating the role", error: error.message });
    }
  },
  deleteUserRole: async (req, res) => {
    try {
      const role = await UserTypes.findById(req.params.id);
      if (!role) {
        return res.status(404).json({ message: "User Role not found" });
      }
      if (isFullAccessRole(role.name)) {
        return res.status(403).json({
          message: `"${role.name}" is a system role and cannot be deleted.`,
        });
      }
      const inUseCount = await User.countDocuments({
        userType: new RegExp(`^${role.name}$`, "i"),
      });
      if (inUseCount > 0) {
        return res.status(409).json({
          message: `Cannot delete role "${role.name}" — it is currently assigned to ${inUseCount} user(s). Reassign them first.`,
        });
      }
      await UserTypes.findByIdAndDelete(req.params.id);
      res
        .status(200)
        .json({ message: "User Role deleted successfully", userRoles: role });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deleteUserRoleMultiple: async (req, res) => {
    try {
      const ids = req.body.deleteIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          message: "Invalid request, ids must be an array of strings",
        });
      }
      const objectIds = ids.map((id) => {
        if (mongoose.Types.ObjectId.isValid(id)) {
          return new mongoose.Types.ObjectId(id);
        } else {
          throw new Error(`Invalid ObjectId: ${id}`);
        }
      });

      const roles = await UserTypes.find({ _id: { $in: objectIds } });
      const protectedNames = roles.filter((r) => isFullAccessRole(r.name)).map((r) => r.name);
      if (protectedNames.length > 0) {
        return res.status(403).json({
          message: `System role(s) cannot be deleted: ${protectedNames.join(", ")}`,
        });
      }
      const inUseRoles = [];
      for (const role of roles) {
        const inUseCount = await User.countDocuments({
          userType: new RegExp(`^${role.name}$`, "i"),
        });
        if (inUseCount > 0) inUseRoles.push(`${role.name} (${inUseCount})`);
      }
      if (inUseRoles.length > 0) {
        return res.status(409).json({
          message: `Cannot delete role(s) currently assigned to users: ${inUseRoles.join(", ")}`,
        });
      }

      const result = await UserTypes.deleteMany({ _id: { $in: objectIds } });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No Users found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} roles(s) deleted successfully`,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getUserRolesByID: async (req, res) => {
    try {
      const id = req.params.id;
      console.log(`>>> [DEBUG] Fetching role by ID: ${id}`);
      
      if (!mongoose.Types.ObjectId.isValid(id)) {
        console.error(`>>> [ERROR] Invalid ObjectId format: ${id}`);
        return res.status(400).json({ error: "Invalid role ID format" });
      }

      const role = await UserTypes.findById(id);
      
      if (!role) {
        console.warn(`>>> [WARN] Role not found in database for ID: ${id}`);
        return res.status(404).json({ error: "User Role not found in database" });
      }

      console.log(`>>> [DEBUG] Role found: ${role.name}`);
      return res.status(200).json({ 
        roles: role.permissions || {}, 
        name: role.name 
      });
    } catch (error) {
      console.error(`>>> [CRITICAL] getUserRolesByID exception:`, error);
      return res.status(500).json({ 
        error: "RBAC_CONTROLLER_ERROR", 
        details: error.message,
        path: "/user-roles/get/" + req.params.id
      });
    }
  },
  update: async (req, res) => {
    try {
      const id = req.params.id;
      const existingRole = await UserTypes.findById(id);
      if (!existingRole) {
        return res.status(404).json({ message: "Role not found" });
      }
      if (isFullAccessRole(existingRole.name)) {
        return res.status(403).json({
          message: `"${existingRole.name}" is a system role with full access already — its permission map cannot be edited.`,
        });
      }
      // We are now updating permissions directly on the UserType (Role)
      const updatedUserType = await UserTypes.findByIdAndUpdate(
        id,
        { $set: { permissions: req.body, updatedAt: Date.now() } },
        {
          new: true,
          runValidators: true,
        },
      );

      if (!updatedUserType) {
        return res.status(404).json({ message: "Role not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "Role permissions updated successfully",
        role: updatedUserType,
      });
    } catch (error) {
      console.error(`>>> [CRITICAL] update permissions exception:`, error);
      return res.status(500).json({ 
        error: "RBAC_UPDATE_ERROR", 
        details: error.message 
      });
    }
  },
  getUserType: async (req, res) => {
    try {
      // Auto-cleanup: Remove legacy production_process permission from all roles
      await UserTypes.updateMany({}, { $unset: { "permissions.production_process": "" } });

      // Hide admin/administrator from the ordinary role-selection lists, normalized
      // (a prior case-sensitive $nin let "Admin" — capital A — slip through unfiltered).
      const allRoles = await UserTypes.find({}).sort({ name: 1 }).lean();
      let userType = allRoles.filter((r) => {
        const key = normalizeUserTypeKey(r.name);
        return key !== "admin" && key !== "administrator";
      });
      return res.status(200).json({
        status: 200,
        status_msg: "User Roles Fetched Successfully!!",
        userType,
      });
    } catch (error) {
      console.error(`>>> [ERROR] RBAC method failure:`, error);
      return res.status(500).json({ 
        error: "RBAC_INTERNAL_METHOD_ERROR", 
        details: error.message 
      });
    }
  },
  getUserTypeByType: async (req, res) => {
    try {
      const { type } = req.query;
      // Bootstraps a logged-in user's OWN permission set — restrict to the caller's
      // own role (or a full-access role, which may reasonably inspect any role) so an
      // authenticated user can't enumerate every other role's permission map by name.
      const requesterType = req.user?.userType;
      if (!requesterType) {
        return res.status(401).json({ message: "Unauthorized" });
      }
      if (
        normalizeUserTypeKey(type) !== normalizeUserTypeKey(requesterType) &&
        !isFullAccessRole(requesterType)
      ) {
        return res.status(403).json({ message: "You may only fetch your own role's permissions" });
      }
      const userType = await UserTypes.findOne({ name: new RegExp(`^${type}$`, "i") }).lean();
      
      if (!userType) {
        return res.status(404).json({ message: "Role not found" });
      }

      return res.status(200).json({
        status: 200,
        status_msg: "Role Permissions Fetched Successfully!!",
        userType: [userType], // Return as array to maintain compatibility
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
