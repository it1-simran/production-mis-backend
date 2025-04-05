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
      const userRoles = await UserRoles.find();
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
      const userRole = await UserRoles.findById(id);
      if (!userRole) {
        return res.status(404).json({ error: "User Roles not found" });
      }
      return res.status(200).json(userRole);
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  update: async (req, res) => {
    try {
      const id = req.params.id;
      const updatedData = {roles:req.body};
      const updatedRoomPlan = await UserRoles.findByIdAndUpdate(
        id,
        updatedData,
        {
          new: true,
          runValidators: true,
        }
      );

      if (!updatedRoomPlan) {
        return res.status(404).json({ message: "Users Role not found" });
      }

      return res.status(200).json({
        status: 200,
        message: "Users Role updated successfully",
        roomPlan: updatedRoomPlan,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getUserType: async (req, res) => {
    try {
      let userType = await UserTypes.find();
      return res.status(200).json({
        status: 200,
        status_msg: "Users Roles Fetched Sucessfully!!",
        userType,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  getUserTypeByType: async (req, res) => {
    try {
      let userType = await UserRoles.find();
      return res.status(200).json({
        status: 200,
        status_msg: "Users Roles Fetched Sucessfully!!",
        userType,
      });
    } catch (error) {
        console.log("error ===> ", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
