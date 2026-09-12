const mongoose = require("mongoose");

/**
 * Master data mapping a device model to the RS232 command used to read it,
 * per customer + device type. Free text on customer — no standalone Customer
 * master exists elsewhere in MES yet.
 */
const rs232CommandMasterSchema = new mongoose.Schema({
    customer: { type: String, required: true, trim: true },
    deviceType: { type: String, required: true, trim: true, enum: ["2G", "4G"] },
    modelName: { type: String, required: true, trim: true },
    vendorId: { type: String, required: true, trim: true },
    rs232Command: { type: String, required: true, trim: true },
    activeStatus: { type: Boolean, default: true },
    remarks: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

rs232CommandMasterSchema.index({ customer: 1, deviceType: 1, modelName: 1 });

module.exports = mongoose.model("Rs232CommandMaster", rs232CommandMasterSchema);
