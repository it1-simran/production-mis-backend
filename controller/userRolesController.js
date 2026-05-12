const mongoose = require("mongoose");
const UserRoles = require("../models/userRoles");
const UserTypes = require("../models/userType");
const bcrypt = require("bcrypt");
module.exports = {
  create: async (req, res) => {
    try {
      const data = req?.body;
      const newUserRoles = new UserRoles(data);
      await newUserRoles.save();
      return res.status(200).json({
        status: 200,
        message: "User Role Created successfully!!",
        newUserRoles,
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "An error occurred while updating the user" });
    }
  },
  view: async (req, res) => {
    try {
      const userRoles = await UserRoles.find().sort({ _id: -1 });
      return res.status(200).json({
        status: 200,
        status_msg: "Users Roles Fetched Sucessfully!!",
        userRoles,
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "An error occurred while updating the user" });
    }
  },
  deleteUserRole: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ status: 400, message: "Invalid role ID" });
      }
      const userRoles = await UserRoles.findByIdAndDelete(req.params.id);
      if (!userRoles) {
        return res.status(404).json({ message: "User Role not found" });
      }
      res
        .status(200)
        .json({ message: "User Role deleted successfully", userRoles });
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

      const result = await UserRoles.deleteMany({ _id: { $in: objectIds } });
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
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid role ID format" });
      }

      const role = await UserTypes.findById(id);
      if (!role) {
        return res.status(404).json({ status: 404, message: "User Role not found" });
      }
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
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ status: 400, message: "Invalid role ID" });
      }
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
      
      let userType = await UserTypes.find({ 
        name: { $nin: ["ADMIN", "ADMINISTRATOR", "admin", "administrator"] } 
      }).sort({ name: 1 });
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
      if (!type || typeof type !== "string") {
        return res.status(400).json({ status: 400, message: "Missing or invalid 'type' query parameter" });
      }
      const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const userType = await UserTypes.findOne({ name: new RegExp(`^${escaped}$`, "i") });
      
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
