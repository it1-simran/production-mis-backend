const EsimProfile = require("../models/EsimProfile");

module.exports = {
    create: async (req, res) => {
        try {
            const { profileId, name, activeStatus, remarks } = req.body;
            const newProfile = new EsimProfile({ profileId, name, activeStatus, remarks });
            await newProfile.save();
            return res.status(201).json({
                status: 201,
                message: "ESIM Profile created successfully",
                data: newProfile,
            });
        } catch (error) {
            console.error("Error in ESIM Profile create:", error);
            if (error.code === 11000) {
                return res.status(400).json({ status: 400, message: "Profile ID already exists" });
            }
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    view: async (req, res) => {
        try {
            const profiles = await EsimProfile.find();
            return res.status(200).json({
                status: 200,
                message: "ESIM Profile records fetched successfully",
                data: profiles,
            });
        } catch (error) {
            console.error("Error in ESIM Profile view:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    esimProfileById: async (req, res) => {
        try {
            const { id } = req.params;
            const profile = await EsimProfile.find({ profileId: id });
            if (!profile) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM Profile record fetched successfully",
                data: profile,
            });
        } catch (error) {
            console.error("Error in ESIM Profile by ID view:", error);
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
            const updated = await EsimProfile.findByIdAndUpdate(id, updateData, { new: true });
            if (!updated) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM Profile updated successfully",
                data: updated,
            });
        } catch (error) {
            console.error("Error in ESIM Profile update:", error);
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
            const deleted = await EsimProfile.findByIdAndDelete(id);
            if (!deleted) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM Profile deleted successfully",
            });
        } catch (error) {
            console.error("Error in ESIM Profile delete:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
};
