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
      const user = await User.findById(userId).lean();
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      user.password = undefined; // Do not send password to the client
      return res
        .status(200)
        .json({ status: 200, status_msg: "User Fetched Sucessfully!!", user });
    } catch (error) {
      console.error("Error fetching user details:", error);
      return res.status(500).json({ error: "USER_CONTROLLER_INTERNAL_ERROR", details: error.message });
    }
  },
  generateEmployeeCode: async (req, res) => {
    try {
      const year = new Date().getFullYear().toString().slice(-2);
      const prefix = `JSD-${year}-`;
      const Sequence = require("../models/Sequence");
      
      let seq = await Sequence.findOneAndUpdate(
        { name: `employeeCode_${year}` },
        { $inc: { value: 1 } },
        { new: true, upsert: true }
      );
      
      const serial = String(seq.value).padStart(4, "0");
      const newCode = `${prefix}${serial}`;
      return res.status(200).json({ status: 200, code: newCode, prefix, serial });
    } catch (error) {
      console.error("Error generating employee code:", error);
      return res.status(500).json({ error: "Internal Server Error", details: error.message, stack: error.stack });
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

      const trimmedCode = String(employeeCode || "").trim();
      if (!trimmedCode) {
        return res
          .status(400)
          .json({ status: 400, message: "Employee Code is required" });
      }

      // Employee Code must be UNIQUE (case-insensitive).
      const codeTaken = await User.findOne({
        employeeCode: {
          $regex: `^${trimmedCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          $options: "i",
        },
      })
        .select("_id")
        .lean();
      if (codeTaken) {
        return res.status(409).json({
          status: 409,
          message: `Employee Code "${trimmedCode}" already exists`,
        });
      }

      // Programmatic email uniqueness check (no DB index needed for email).
      const parsedEmail = String(email || "").trim();
      if (parsedEmail) {
        const emailTaken = await User.findOne({ email: parsedEmail }).select("_id").lean();
        if (emailTaken) {
          return res.status(409).json({ status: 409, message: "A user with this email already exists" });
        }
      }

      const isOperatorRole = /operator/i.test(String(userType || ""));
      const rawPassword = String(req?.body?.password || "").trim();
      if (!rawPassword && !isOperatorRole) {
        return res
          .status(400)
          .json({ status: 400, message: "Password is required for this role" });
      }
      const effectivePassword = rawPassword || trimmedCode;

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(effectivePassword, salt);
      const password = hashedPassword;

      const userPayload = {
        _id: new (require('mongoose').Types.ObjectId)(),
        name,
        employeeCode: trimmedCode,
        gender,
        password,
        dateOfBirth,
        userType,
        skills: skills || [],
        profilePic: "",
        coverPic: "",
        department: "",
        status: "Active",
        deboardedAt: null,
        deboardedBy: null,
        deboardReason: "",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Only include email / mobileNo if they are real non-empty strings.
      // Explicitly delete the keys if falsy — prevent null from sneaking in
      // via JSON body coercion (JSON null → JS null → would be stored as BSON null
      // and break the sparse unique index).
      const parsedMobile = String(mobileNo || "").trim();
      if (parsedEmail) {
        userPayload.email = parsedEmail;
      } else {
        delete userPayload.email;
      }
      if (parsedMobile) {
        userPayload.mobileNo = parsedMobile;
      } else {
        delete userPayload.mobileNo;
      }

      console.log('[createUser] inserting payload keys:', Object.keys(userPayload), '| email present:', 'email' in userPayload);

      // Use raw MongoDB insertOne to bypass Mongoose's null coercion on
      // schema-defined fields that are absent from the payload.
      await User.collection.insertOne(userPayload);

      // Ensure sequence stays ahead if manually entered
      const yearMatch = trimmedCode.match(/^JSD-(\d{2})-(\d+)$/i);
      if (yearMatch) {
        const year = yearMatch[1];
        const num = parseInt(yearMatch[2], 10);
        if (!isNaN(num)) {
          const Sequence = require("../models/Sequence");
          await Sequence.findOneAndUpdate(
            { name: `employeeCode_${year}` },
            { $max: { value: num } },
            { upsert: true }
          );
        }
      }

      return res.status(200).json({
        status: 200,
        message: "User created successfully",
      });
    } catch (error) {
      if (error.code === 11000) {
        const dupField = Object.keys(error.keyPattern || {})[0] || "field";
        console.error("[DEBUG-409] Duplicate key:", JSON.stringify({ keyPattern: error.keyPattern, keyValue: error.keyValue }));
        return res.status(409).json({
          status: 409,
          message: `A user with this ${dupField} already exists`,
        });
      }
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
      const { status } = req.query;
      const OperatorWorkSession = require("../models/operatorWorkSession");
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      // Find operators who are active today
      const activeSessions = await OperatorWorkSession.distinct("operatorId", {
        status: "active",
        startedAt: { $gte: startOfDay, $lte: endOfDay }
      });
      const activeSessionStrings = activeSessions.map(id => id.toString());

      const query = { userType: { $ne: "admin" } };
      
      if (status === 'Discarded') {
        query.status = 'Discarded';
      } else if (status === 'Active') {
        query._id = { $in: activeSessions };
        query.status = { $ne: 'Discarded' };
      } else if (status === 'Inactive') {
        query._id = { $nin: activeSessions };
        query.status = { $ne: 'Discarded' };
      } else if (status && status !== 'All') {
        query.status = status;
      } else {
        query.status = { $ne: 'Discarded' };
      }

      let users = await User.find(query).select("-password").sort({ _id: -1 }).lean();
      
      // Override the status field based on today's session activity
      users = users.map(u => {
        if (u.status === 'Discarded') {
          return u;
        }
        if (activeSessionStrings.includes(u._id.toString())) {
          u.status = 'Active';
        } else {
          u.status = 'Inactive';
        }
        return u;
      });

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
  getOperatorDashboardStats: async (req, res) => {
    try {
      const OperatorWorkSession = require("../models/operatorWorkSession");
      const ProcessModel = require("../models/process");
      const assignOperatorToPlan = require("../models/assignOperatorToPlan");
      
      const validOperators = await User.find({
        userType: { $regex: /^operator$/i },
        status: { $ne: 'Discarded' }
      }).distinct('_id');
      const totalOperators = validOperators.length;

      const deboardedOperators = await User.countDocuments({
        userType: { $regex: /^operator$/i },
        status: 'Discarded'
      });

      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const activeSessions = await OperatorWorkSession.distinct("operatorId", {
        status: "active",
        startedAt: { $gte: startOfDay, $lte: endOfDay },
        operatorId: { $in: validOperators }
      });
      const activeOperators = activeSessions.length;

      const inactiveOperators = Math.max(0, totalOperators - activeOperators);

      const activeProcesses = await ProcessModel.find({ status: "active" }).lean();
      let requiredManpower = 0;
      for (const p of activeProcesses) {
        requiredManpower += (p.stages ? p.stages.length : 0);
      }

      const occupiedUsers = await assignOperatorToPlan.distinct("userId", { 
        status: "Occupied",
        userId: { $in: validOperators }
      });
      const availableManpower = Math.max(0, totalOperators - occupiedUsers.length);

      const manpowerGap = requiredManpower - availableManpower;

      return res.status(200).json({
        status: 200,
        data: {
          totalOperators,
          activeOperators,
          inactiveOperators,
          requiredManpower,
          availableManpower,
          manpowerGap,
          deboardedOperators
        }
      });
    } catch (error) {
      console.error("Error fetching operator dashboard stats:", error);
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
  deboardOperator: async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const adminId = req.user ? req.user._id : null;

      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json({ message: "Operator not found." });
      }

      const AssignOperatorToPlan = require("../models/assignOperatorToPlan");
      const activeAssignments = await AssignOperatorToPlan.find({ userId: id, status: "Occupied" });
      
      if (activeAssignments.length > 0 && req.body.force !== true) {
        return res.status(400).json({ 
          error: "ACTIVE_TASKS",
          message: "Cannot deboard operator with active unfinished production tasks. Please free their assignments first." 
        });
      }

      user.status = "Discarded";
      user.deboardedAt = new Date();
      if (adminId) user.deboardedBy = adminId;
      user.deboardReason = reason || "No reason provided";

      await user.save();

      return res.status(200).json({ message: "Operator successfully deboarded.", user });
    } catch (error) {
      console.error("Error deboarding operator:", error);
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

      // Employee Code must stay UNIQUE (case-insensitive), excluding this user.
      const trimmedCode = String(employeeCode || "").trim();
      if (trimmedCode) {
        const codeTaken = await User.findOne({
          _id: { $ne: id },
          employeeCode: {
            $regex: `^${trimmedCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            $options: "i",
          },
        })
          .select("_id")
          .lean();
        if (codeTaken) {
          return res.status(409).json({
            status: 409,
            message: `Employee Code "${trimmedCode}" already exists`,
          });
        }
      }

      // Only set fields that were actually provided — the UI no longer sends
      // email/phone, and absent fields must not clobber stored values.
      const updatedData = {};
      if (name !== undefined) updatedData.name = name;
      if (email !== undefined && String(email).trim()) updatedData.email = email;
      if (trimmedCode) updatedData.employeeCode = trimmedCode;
      if (gender !== undefined) updatedData.gender = gender;
      if (dateOfBirth !== undefined) updatedData.dateOfBirth = dateOfBirth;
      if (userType !== undefined) updatedData.userType = userType;
      if (skills !== undefined) updatedData.skills = skills;
      if (mobileNo !== undefined) updatedData.mobileNo = mobileNo;
      
      const rawPassword = String(req?.body?.password || "").trim();
      if (rawPassword) {
        const bcrypt = require("bcryptjs");
        const salt = await bcrypt.genSalt(10);
        updatedData.password = await bcrypt.hash(rawPassword, salt);
      }

      updatedData.updatedAt = new Date();

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
        const dupField = Object.keys(error.keyPattern || {})[0] || "field";
        return res.status(409).json({
          status: 409,
          message: `A user with this ${dupField} already exists`,
        });
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
