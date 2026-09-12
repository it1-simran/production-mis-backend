const Rs232CommandMaster = require("../models/Rs232CommandMaster");

module.exports = {
    /**
     * Distinct Model Name + Vendor ID combos from the RS232 Command Master,
     * for the Sales SKU approval modal's pick-list. Matching customer records
     * are surfaced first (case-insensitive), so Sales sees the ones relevant
     * to this SKU's customer before the wider pool.
     */
    modelOptionsFor: async (customer) => {
        const records = await Rs232CommandMaster.find({ activeStatus: true })
            .select("customer modelName vendorId")
            .lean();

        const seen = new Set();
        const matching = [];
        const others = [];
        const customerRx = customer ? new RegExp(`^${String(customer).trim()}$`, "i") : null;

        records.forEach((r) => {
            const key = `${r.modelName}|||${r.vendorId}`;
            if (seen.has(key)) return;
            seen.add(key);
            const opt = { model_name: r.modelName, vendor_id: r.vendorId };
            if (customerRx && customerRx.test(r.customer || "")) matching.push(opt);
            else others.push(opt);
        });

        return [...matching, ...others];
    },
    create: async (req, res) => {
        try {
            const { customer, deviceType, modelName, vendorId, rs232Command, activeStatus, remarks } = req.body;
            const record = new Rs232CommandMaster({
                customer,
                deviceType,
                modelName,
                vendorId,
                rs232Command,
                activeStatus: activeStatus !== undefined ? !!activeStatus : true,
                remarks,
            });
            await record.save();
            return res.status(201).json({
                status: 201,
                message: "RS232 Command record created successfully",
                data: record,
            });
        } catch (error) {
            console.error("Error in RS232 Command Master create:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
    view: async (req, res) => {
        try {
            const records = await Rs232CommandMaster.find()
                .select("_id customer deviceType modelName vendorId rs232Command activeStatus remarks createdAt updatedAt")
                .sort({ _id: -1 })
                .limit(1000)
                .lean();
            return res.status(200).json({
                status: 200,
                message: "RS232 Command records fetched successfully",
                data: records,
            });
        } catch (error) {
            console.error("Error in RS232 Command Master view:", error);
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
            const updated = await Rs232CommandMaster.findByIdAndUpdate(id, updateData, { new: true, runValidators: true });
            if (!updated) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "RS232 Command record updated successfully",
                data: updated,
            });
        } catch (error) {
            console.error("Error in RS232 Command Master update:", error);
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
            const deleted = await Rs232CommandMaster.findByIdAndDelete(id);
            if (!deleted) {
                return res.status(404).json({ status: 404, message: "Record not found" });
            }
            return res.status(200).json({
                status: 200,
                message: "RS232 Command record deleted successfully",
            });
        } catch (error) {
            console.error("Error in RS232 Command Master delete:", error);
            return res.status(500).json({
                status: 500,
                message: "Server error",
                error: error.message,
            });
        }
    },
};
