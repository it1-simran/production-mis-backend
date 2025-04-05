const mongoose = require("mongoose");
const Jig = require("../models/jig");
const jigCategory = require("../models/jigCategory");
const assignJigToPlanModel = require("../models/assignJigToPlan");
module.exports = {
  create: async (req, res) => {
    try {
      const { name, jigCategory } = req.body;
      const newJig = new Jig({ name, jigCategory });
      await newJig.save();
      return res
        .status(200)
        .json({ status: 200, message: "Jig Created Succesfully", newJig });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  createJigCategory: async (req, res) => {
    try {
      const { name, status } = req.body;
      const jigCat = new jigCategory({ name, status });
      await jigCat.save();

      return res
        .status(200)
        .json({ status: 200, message: "Jig Created Succesfully", jigCat });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  view: async (req, res) => {
    try {
      const Jigs = await Jig.find();
      return res.status(200).json({
        status: 200,
        status_msg: "Jigs Fetched Sucessfully!!",
        Jigs,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  viewCategory: async (req, res) => {
    try {
      const JigCategories = await jigCategory.find();
      return res.status(200).json({
        status: 200,
        status_msg: "Jigs Fetched Sucessfully!!",
        JigCategories,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  delete: async (req, res) => {
    try {
      const jig = await Jig.findByIdAndDelete(req.params.id);

      if (!jig) {
        return res.status(404).json({ message: "Jig not found" });
      }
      res.status(200).json({ message: "Jig deleted successfully", jig });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deleteCategory: async (req, res) => {
    try {
      const jigcat = await jigCategory.findByIdAndDelete(req.params.id);

      if (!jigcat) {
        return res.status(404).json({ message: "Jig Category not found" });
      }
      res
        .status(200)
        .json({ message: "Jig Category deleted successfully", jigcat });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deleteJigMultiple: async (req, res) => {
    try {
      const ids = req.body.deleteIds;

      // Validate that 'ids' is an array and not empty
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          message: "Invalid request, ids must be an array of strings",
        });
      }

      // Convert each ID to a valid ObjectId using `new`
      const objectIds = ids.map((id) => {
        if (mongoose.Types.ObjectId.isValid(id)) {
          return new mongoose.Types.ObjectId(id); // Use `new` keyword
        } else {
          throw new Error(`Invalid ObjectId: ${id}`);
        }
      });

      // Delete multiple items based on their ObjectId
      const result = await Jig.deleteMany({ _id: { $in: objectIds } });

      // Check if any items were actually deleted
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }

      // Success response
      return res.status(200).json({
        message: `${result.deletedCount} item(s) deleted successfully`,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  deleteCategoryMultiple: async (req, res) => {
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
      const result = await jigCategory.deleteMany({ _id: { $in: objectIds } });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "No items found to delete" });
      }
      return res.status(200).json({
        message: `${result.deletedCount} item(s) deleted successfully`,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  updateJigStatus: async (req, res) =>{
    try {
      let jigId = req.params.id;
      let status = req.body.status;
      let updateAssignedOperator;
      let jigData = await assignJigToPlanModel.findOne({ jigId });
      if (jigData && Object.keys(jigData).length > 0) {
        updateAssignedOperator = await assignJigToPlanModel.findByIdAndUpdate(
          jigData._id,
          { status },
          { new: true, runValidators: true }
        );
      } else {
        return res.status(500).json({
          status: 500,
          message: "No Records found!!",
          updateAssignedOperator,
        });
      }
      return res.status(200).json({
        status: 200,
        message: "Vacant Operator found!!",
        updateAssignedOperator,
      });
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  fetchJigsById: async (req, res) => {
    try {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid jigCategory ID" });
      }
      const jigs = await Jig.find({ jigCategory: id });
      if (!jigs) {
        return res.status(404).json({ error: "Jig not found" });
      }
      return res.status(200).json(jigs);
    } catch (error) {
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
};
