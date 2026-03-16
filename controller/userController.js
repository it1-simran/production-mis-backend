const mongoose = require("mongoose");
const User = require("../models/User");
const bcrypt = require("bcrypt");
module.exports = {
  getUserById: async (req, res) => {
    try {
      const userId = req.query.id;
      if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
      }
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      user.password = undefined; // Do not send password to the client
      return res
        .status(200)
        .json({ status: 200, status_msg: "User Fetched Sucessfully!!", user });
    } catch (error) {
      console.error("Error fetching user details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  uploadProfilePicture: async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }
    try {
      const userId = req.params.userId;
      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { profilePic: req.file.path },
        { new: true }
      );
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }
      res.status(200).json({
        message: "Profile picture uploaded successfully",
        filePath: req.file.path,
        user: updatedUser,
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "An error occurred while updating the user" });
    }
  },
  createUser: async (req, res) => {
    try {
      const {
        name,
        email,
        employeeCode,
        gender,
        dateOfBirth,
        userType,
        skills,
        mobileNo,
      } = req?.body;

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(req?.body.password, salt);
      const password = hashedPassword;
      const newUser = new User({
        name,
        email,
        employeeCode,
        gender,
        password,
        dateOfBirth,
        userType,
        skills,
        mobileNo,
      });

      await newUser.save();
      newUser.password = undefined;
      return res.status(200).json({
        status: 200,
        message: "User created successfully",
        newUser,
      });
    } catch (error) {
      console.error("Error creating user:", error);
      res
        .status(500)
        .json({ message: "An error occurred while creating the user" });
    }
  },
  uploadCoverPicture: async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }
    try {
      const userId = req.params.userId;
      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { coverPic: req.file.path },
        { new: true }
      );
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }
      res.status(200).json({
        message: "Cover picture uploaded successfully",
        filePath: req.file.path,
        user: updatedUser,
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "An error occurred while updating the user" });
    }
  },
  getUsers: async (req, res) => {
    try {
      const users = await User.find({ userType: { $ne: "admin" } }).select("-password");
      return res.status(200).json({
        status: 200,
        status_msg: "Users Fetched Sucessfully!!",
        users,
      });
    } catch (error) {
      console.error("Error fetching User details:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  deleteUser: async (req, res) => {
    try {
      const users = await User.findByIdAndDelete(req.params.id);

      if (!users) {
        return res.status(404).json({ message: "User not found" });
      }
      res.status(200).json({ message: "User deleted successfully", users });
    } catch (error) {
      console.error("Error Delete User:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  deleteUserMultiple: async (req, res) => {
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

      const result = await User.deleteMany({ _id: { $in: objectIds } });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} item(s) deleted successfully`,
      });
    } catch (error) {
      console.error("Error Delete User:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  updateUser: async (req, res) => {
    try {
      const id = req.params.id;
      const {
        name,
        email,
        employeeCode,
        gender,
        dateOfBirth,
        userType,
        skills,
        mobileNo,
      } = req.body;

      const updatedData = {
        name,
        email,
        employeeCode,
        gender,
        dateOfBirth,
        userType,
        skills,
        mobileNo,
      };
      const updatedUser = await User.findByIdAndUpdate(id, updatedData, {
        new: true,
        runValidators: true,
        context: "query",
      });
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }
      updatedUser.password = undefined;
      return res.status(200).json({
        status: 200,
        message: "User updated successfully",
        user: updatedUser,
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(400).json({ error: "Email already exists" });
      }
      console.error("Error updating user:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  updateOperatorSkillSet: async (req, res) => {
    try {
      const id = req.params.id;
      const updatedData = { skills: req.body.skills.split(",") };
      const updatedUserSkill = await User.findByIdAndUpdate(id, updatedData, {
        new: true,
        runValidators: true,
        context: "query",
      });
      return res.status(200).json({
        status: 200,
        message: "User Skills Added successfully!",
        user: updatedUserSkill,
      });
    } catch (error) {
      console.error("Error updating user:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
  getUserRegistrationTrends: async (req, res) => {
    try {
      const days = Math.max(parseInt(req.query.days, 10) || 30, 1);
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      start.setHours(0, 0, 0, 0);

      const trend = await User.aggregate([
        { $match: { createdAt: { $gte: start } } },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const countsByDay = trend.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {});

      const categories = [];
      const data = [];
      for (let i = 0; i < days; i += 1) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const key = d.toISOString().slice(0, 10);
        categories.push(key);
        data.push(countsByDay[key] || 0);
      }

      const roleDistribution = await User.aggregate([
        { $match: { userType: { $ne: "admin" } } },
        { $group: { _id: "$userType", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]);

      return res.status(200).json({
        status: 200,
        message: "User registration trends fetched successfully",
        categories,
        series: [{ name: "Registrations", data }],
        roleDistribution: roleDistribution.map((r) => ({
          role: r._id || "Unknown",
          count: r.count,
        })),
      });
    } catch (error) {
      console.error("Error fetching user registration trends:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
};
