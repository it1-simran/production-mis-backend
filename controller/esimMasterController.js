const EsimMaster = require("../models/EsimMaster");
const EsimMake = require("../models/EsimMake");
const EsimProfile = require("../models/EsimProfile");
const EsimApn = require("../models/EsimApn");
module.exports = {
    bulkCreate: async (req, res) => {
        try {
            const data = req.body;

            // Basic validation
            if (!Array.isArray(data) || data.length === 0) {
                return res.status(400).json({
                    status: 400,
                    message: "Invalid data. Expected a non-empty array of objects.",
                });
            }

            // Insert data
            // ordered: false ensures that if one fails (e.g. duplicate CCID), others still get processed
            const result = await EsimMaster.insertMany(data, { ordered: false });

            return res.status(201).json({
                status: 201,
                message: "ESimmaster records created successfully",
                count: result.length,
                data: result,
            });
        } catch (error) {
            // Handle bulk write errors (e.g. some duplicates)
            if (error.name === "MongoBulkWriteError" || error.code === 11000) {
                return res.status(400).json({
                    status: 400,
                    message: "Some records failed to insert due to duplicates (CCID must be unique).",
                    insertedCount: error.insertedDocs ? error.insertedDocs.length : 0,
                    error: error.message,
                });
            }

            console.error("Error in ESIM Master bulk create:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    view: async (req, res) => {
        try {
            const esimMasters = await EsimMaster.find();
            return res.status(200).json({
                status: 200,
                message: "ESIM Master records fetched successfully",
                data: esimMasters,
            });
        } catch (error) {
            console.error("Error in ESIM Master view:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    create: async (req, res) => {
        try {
            const { ccid, esimMake, profile1, profile2, apnProfile1, apnProfile2, remarks } = req.body;
            const newEntry = new EsimMaster({ ccid, esimMake, profile1, profile2, apnProfile1, apnProfile2, remarks });
            await newEntry.save();
            return res.status(201).json({
                status: 201,
                message: "ESIM Master created successfully",
                data: newEntry,
            });
        } catch (error) {
            console.error("Error in ESIM Master create:", error);
            if (error.code === 11000) {
                return res.status(400).json({ status: 400, message: "CCID already exists" });
            }
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
            const updated = await EsimMaster.findByIdAndUpdate(id, updateData, { new: true });
            if (!updated) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM Master updated successfully",
                data: updated,
            });
        } catch (error) {
            console.error("Error in ESIM Master update:", error);
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
            const deleted = await EsimMaster.findByIdAndDelete(id);
            if (!deleted) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM Master deleted successfully",
            });
        } catch (error) {
            console.error("Error in ESIM Master delete:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    bulkDelete: async (req, res) => {
        try {
            const { ids } = req.body;
            if (!Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ status: 400, message: "Invalid IDs provided" });
            }
            const result = await EsimMaster.deleteMany({ _id: { $in: ids } });
            return res.status(200).json({
                status: 200,
                message: `${result.deletedCount} records deleted successfully`,
            });
        } catch (error) {
            console.error("Error in ESIM Master bulk delete:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    getByCcid: async (req, res) => {
        try {
            const { ccid } = req.params;
            const result = await EsimMaster.findOne({ ccid: ccid.trim() });
            if (!result) {
                return res.status(404).json({ status: 404, message: "ESIM Master not found for this CCID" });
            }

            // Fetch IDs for command generation
            const [makeData, p1Data, p2Data] = await Promise.all([
                EsimMake.findOne({ name: result.esimMake }),
                EsimProfile.findOne({ name: { $in: [result.profile1] } }),
                EsimProfile.findOne({ name: { $in: [result.profile2] } })
            ]);

            const finalData = result.toObject();
            finalData.esimMakeId = makeData ? makeData.simId : result.esimMake;
            finalData.profile1Id = p1Data ? p1Data.profileId : result.profile1;
            finalData.profile2Id = p2Data ? p2Data.profileId : result.profile2;

            return res.status(200).json({
                status: 200,
                message: "ESIM Master record fetched successfully",
                data: finalData,
            });
        } catch (error) {
            console.error("Error in ESIM Master getByCcid:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    getAPNByMakeAndProfile: async (req, res) => {
        try {
            const { esimMake, profile1 } = req.params;
            const result = await EsimApn.findOne({ esimMake: esimMake.trim(), esimProfile1: profile1.trim() });
            if (!result) {
                return res.status(404).json({ status: 404, message: "ESIM Master APN not found for this make and profile" });
            }
            return res.status(200).json({
                status: 200,
                message: "ESIM MasterAPN record fetched successfully",
                data: result,
            });
        } catch (error) {
            console.error("Error in APN getAPNByMakeAndProfile:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
};
