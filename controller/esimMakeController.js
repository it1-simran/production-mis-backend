const EsimMake = require("../models/EsimMake");

const DUPLICATE_FIELD_LABELS = { simId: "SIM Make ID", name: "Name" };

// Mongo duplicate-key error (E11000) — surface which field collided instead
// of a generic 500, so the form can show a clear message.
const duplicateFieldMessage = (error) => {
    if (error?.code !== 11000) return null;
    const field = Object.keys(error?.keyPattern || {})[0];
    const label = DUPLICATE_FIELD_LABELS[field] || field || "value";
    return `${label} already exists. Please use a different ${label}.`;
};

module.exports = {
    create: async (req, res) => {
        try {
            const { simId, name, manufacturer, activeStatus, showInCpanel, remarks } = req.body;
            const newMake = new EsimMake({ simId, name, manufacturer: manufacturer || "", activeStatus, showInCpanel: !!showInCpanel, remarks });
            await newMake.save();
            return res.status(201).json({
                status: 201,
                message: "ESIM Make created successfully",
                data: newMake,
            });
        } catch (error) {
            const duplicateMessage = duplicateFieldMessage(error);
            if (duplicateMessage) {
                return res.status(409).json({ status: 409, message: duplicateMessage });
            }
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
            const makes = await EsimMake.find()
                .select("_id simId name manufacturer activeStatus showInCpanel remarks createdAt updatedAt")
                .sort({ _id: -1 })
                .limit(1000)
                .lean();
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
            const duplicateMessage = duplicateFieldMessage(error);
            if (duplicateMessage) {
                return res.status(409).json({ status: 409, message: duplicateMessage });
            }
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