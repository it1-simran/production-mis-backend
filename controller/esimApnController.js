const EsimApn = require("../models/EsimApn");

module.exports = {
    create: async (req, res) => {
        try {
            const {
                apnName,
                esimMake,
                esimProfile1,
                esimProfile2,
                activeStatus,
                remarks
            } = req.body;

            // Check if already exists
            const existing = await EsimApn.findOne({
                apnName,
                esimMake,
                esimProfile1,
            });

            if (existing) {
                return res.status(409).json({
                    status: 409,
                    message: "APN already exists for this Make & Profile",
                });
            }

            const newApn = new EsimApn({
                apnName,
                esimMake,
                esimProfile1,
                esimProfile2,
                activeStatus,
                remarks
            });

            await newApn.save();

            return res.status(201).json({
                status: 201,
                message: "ESIM APN created successfully",
                data: newApn,
            });

        } catch (error) {
            console.error("Error in ESIM APN create:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // create: async (req, res) => {
    //     try {
    //         const { apnName, esimMake, esimProfile1, esimProfile2, activeStatus, remarks } = req.body;
    //         const newApn = new EsimApn({ apnName, esimMake, esimProfile1, esimProfile2, activeStatus, remarks });
    //         await newApn.save();
    //         return res.status(201).json({
    //             status: 201,
    //             message: "ESIM APN created successfully",
    //             data: newApn,
    //         });
    //     } catch (error) {
    //         console.error("Error in ESIM APN create:", error);
    //         return res.status(500).json({
    //             status: 500,
    //             message: "Server error",
    //             error: error.message,
    //         });
    //     }
    // },
    view: async (req, res) => {
        try {
            const apns = await EsimApn.find();
            return res.status(200).json({
                status: 200,
                message: "ESIM APN records fetched successfully",
                data: apns,
            });
        } catch (error) {
            console.error("Error in ESIM APN view:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    viewAPNById: async (req, res) => {
        try {
            const { id } = req.params;
            const apn = await EsimApn.find({ apnName: id });
            if (!apn) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM APN record fetched successfully",
                data: apn,
            });
        } catch (error) {
            console.error("Error in ESIM APN by ID view:", error);
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
            const updated = await EsimApn.findByIdAndUpdate(id, updateData, { new: true });
            if (!updated) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM APN updated successfully",
                data: updated,
            });
        } catch (error) {
            console.error("Error in ESIM APN update:", error);
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
            const deleted = await EsimApn.findByIdAndDelete(id);
            if (!deleted) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM APN deleted successfully",
            });
        } catch (error) {
            console.error("Error in ESIM APN delete:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
};
