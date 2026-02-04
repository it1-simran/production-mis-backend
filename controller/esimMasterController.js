const EsimMaster = require("../models/EsimMaster");

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
};
