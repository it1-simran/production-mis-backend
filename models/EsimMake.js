const mongoose = require("mongoose");

const esimMakeSchema = new mongoose.Schema({
    simId: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    // Free-text manufacturer name, picked from the distinct customer names
    // already recorded in the RS232 Command Master ("Manage Manufacturer").
    manufacturer: { type: String, default: "" },
    activeStatus: { type: Boolean, default: true },
    // When true, this make is offered in the GPSCPANEL Raise-PO form.
    showInCpanel: { type: Boolean, default: false },
    remarks: { type: String, required: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

esimMakeSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model("EsimMake", esimMakeSchema);
