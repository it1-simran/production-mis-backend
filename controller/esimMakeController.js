const EsimMake = require("../models/EsimMake");

module.exports = {
    create: async (req, res) => {
        try {
            const { simId, name, activeStatus, remarks } = req.body;
            const newMake = new EsimMake({ simId, name, activeStatus, remarks });
            await newMake.save();
            return res.status(201).json({
                status: 201,
                message: "ESIM Make created successfully",
                data: newMake,
            });
        } catch (error) {
            console.error("Error in ESIM Make create:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    view: async (req, res) => {
        try {
            const makes = await EsimMake.find();
            return res.status(200).json({
                status: 200,
                message: "ESIM Make records fetched successfully",
                data: makes,
            });
        } catch (error) {
            console.error("Error in ESIM Make view:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    update: async (req, res) => {
        try {
            const { id } = req.params;
            const updateData = req.body;
            updateData.updatedAt = Date.now();
            const updated = await EsimMake.findByIdAndUpdate(id, updateData, { new: true });
            if (!updated) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM Make updated successfully",
                data: updated,
            });
        } catch (error) {
            console.error("Error in ESIM Make update:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    delete: async (req, res) => {
        try {
            const { id } = req.params;
            const deleted = await EsimMake.findByIdAndDelete(id);
            if (!deleted) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM Make deleted successfully",
            });
        } catch (error) {
            console.error("Error in ESIM Make delete:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
};
